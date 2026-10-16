import type { IMessage } from '@rocket.chat/core-typings';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

import { abortable, collectConnection, deliverContinuously, pause } from './core';
import type { CollectorSource } from './core';
import { messageToEvent, nonempty, object, sha256 } from './model';
import type { Room } from './model';
import { CollectorStore } from './storage';
import { sendReport } from './transport';
import { sdk } from '../../app/utils/client/lib/SDKClient';
import { e2e } from '../lib/e2ee';

type ClientConfig = {
	version: 1;
	serverUrl: string;
	akatsukiUrl: string;
	roomIds: string[];
	initialSince: string | null;
};
const timed = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
	abortable(operation, AbortSignal.any([signal, AbortSignal.timeout(30000)]));

const parseConfig = (input: unknown): ClientConfig => {
	const config = object(input);
	if (config.version !== 1 || !Array.isArray(config.roomIds)) throw new Error('Unsupported collector configuration');
	return {
		version: 1,
		serverUrl: nonempty(config.serverUrl),
		akatsukiUrl: nonempty(config.akatsukiUrl),
		roomIds: config.roomIds.map(nonempty),
		initialSince: config.initialSince === null ? null : nonempty(config.initialSince),
	};
};

const createSource = (config: ClientConfig): CollectorSource<IMessage> => ({
	rooms: async (signal) => {
		const { update } = await timed(sdk.rest.get('/v1/subscriptions.get', {}), signal);
		const rooms: Room[] = update.flatMap((subscription) => {
			if (subscription.t !== 'c' && subscription.t !== 'p' && subscription.t !== 'd') return [];
			if (config.roomIds.length && !config.roomIds.includes(subscription.rid)) return [];
			return [{ id: subscription.rid, type: subscription.t }];
		});
		for (const id of config.roomIds) if (!rooms.some((room) => room.id === id)) throw new Error(`Not joined to configured room ${id}`);
		return rooms;
	},
	now: async (signal) => {
		const response = await fetch('/api/info', { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
		if (!response.ok) throw new Error(`Rocket.Chat clock HTTP ${response.status}`);
		const date = response.headers.get('Date');
		if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Rocket.Chat server did not provide its clock');
		return new Date(date).toISOString();
	},
	subscribe: async (room, receive, signal) => {
		const subscription = sdk.stream('room-messages', [room.id], receive);
		const stop = (): void => {
			subscription.stop();
			signal.removeEventListener('abort', stop);
		};
		signal.addEventListener('abort', stop, { once: true });
		try {
			await timed(subscription.ready(), signal);
			return stop;
		} catch (error) {
			stop();
			throw error;
		}
	},
	history: async (room, since, signal) => {
		const messages = await timed(sdk.call('loadMissedMessages', room.id, new Date(since)), signal);
		if (messages === false) throw new Error(`Cannot load messages for room ${room.id}`);
		return messages;
	},

	normalize: async (message, signal) => {
		// Call the official client instance directly, using its authenticated key lifecycle.
		const decrypted = message.t === 'e2e' ? await timed(e2e.decryptMessage(message, { throwOnError: true }), signal) : message;
		return messageToEvent(config.serverUrl, decrypted);
	},
});

const waitForConnected = (signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const stop = (): void => {
			computation.stop();
			signal.removeEventListener('abort', aborted);
		};
		const aborted = (): void => {
			stop();
			reject(signal.reason);
		};
		// Tracker executes once synchronously, so cleanup runs in a microtask after assignment.
		const computation = Tracker.autorun(() => {
			if (Meteor.status().connected)
				queueMicrotask(() => {
					stop();
					resolve();
				});
		});
		signal.addEventListener('abort', aborted, { once: true });
	});

const runAccount = async (config: ClientConfig, userId: string, signal: AbortSignal): Promise<void> => {
	const identity = await sha256(JSON.stringify([config.serverUrl, userId, config.akatsukiUrl]));
	const databaseName = `akatsuki-collector:${identity}`;
	await navigator.locks.request(databaseName, { signal }, async () => {
		signal.throwIfAborted();
		const store = await CollectorStore.open(databaseName);
		console.info('[Akatsuki collector] Opened durable cursor/outbox', { databaseName });
		const lifetime = new AbortController();
		const runningSignal = AbortSignal.any([signal, lifetime.signal]);
		const deliveries = deliverContinuously(
			store,
			(body, deliverySignal) => sendReport(config.akatsukiUrl, body, deliverySignal),
			runningSignal,
		);
		try {
			const source = createSource(config);
			while (!signal.aborted) {
				// eslint-disable-next-line no-await-in-loop -- A capture session requires an authenticated active connection.
				await waitForConnected(signal);
				const connection = new AbortController();
				const watch = Tracker.autorun(() => {
					if (!Meteor.status().connected) connection.abort();
				});
				const membership = sdk.stream('notify-user', [`${userId}/subscriptions-changed`], () => connection.abort());
				try {
					console.info('[Akatsuki collector] Catching up, then streaming');
					// eslint-disable-next-line no-await-in-loop -- Do not overlap capture sessions or their recovery cursors.
					await collectConnection(
						source,
						store,
						{ initialSince: config.initialSince, checkpointMs: 60000 },
						AbortSignal.any([signal, connection.signal]),
					);
				} catch (error) {
					if (!signal.aborted) console.error('[Akatsuki collector] Capture interrupted; resuming from saved cursor', error);
				} finally {
					membership.stop();
					watch.stop();
					connection.abort();
				}
				// eslint-disable-next-line no-await-in-loop -- Wait before retrying a failed capture session.
				if (!signal.aborted) await pause(3000, signal);
			}
		} finally {
			lifetime.abort();
			await deliveries;
			store.close();
		}
	});
};

Meteor.startup(() => {
	void (async () => {
		const response = await fetch('/_akatsuki/config', { cache: 'no-store' });
		// Running the fork without the local collector host leaves collection disabled.
		if (response.status === 404) return;
		if (!response.ok) throw new Error(`Collector config HTTP ${response.status}`);
		const config = parseConfig(await response.json());
		if (!window.isSecureContext || !navigator.locks || !crypto.subtle)
			throw new Error('Collector requires a secure browser context (localhost or HTTPS) with Web Locks');
		let currentUser: string | null = null;
		let account: AbortController | undefined;
		const watch = Tracker.autorun(() => {
			const userId = Meteor.userId();
			if (userId === currentUser) return;
			currentUser = userId;
			account?.abort();
			if (!userId) return;
			account = new AbortController();
			const { signal } = account;
			void runAccount(config, userId, signal).catch((error: unknown) => {
				if (!signal.aborted) console.error('[Akatsuki collector] Stopped; stored data was preserved', error);
			});
		});
		window.addEventListener(
			'beforeunload',
			() => {
				account?.abort();
				watch.stop();
			},
			{ once: true },
		);
	})().catch((error: unknown) => console.error('[Akatsuki collector] Startup failed', error));
});
