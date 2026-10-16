import type { CollectorEvent, ReportBody, Room } from './model';
import { isoDate, parseReceipt } from './model';
import type { CollectorStore } from './storage';

export type CollectorSource<T> = {
	rooms(signal: AbortSignal): Promise<Room[]>;
	now(signal: AbortSignal): Promise<string>;
	subscribe(room: Room, listener: (input: T) => void, signal: AbortSignal): Promise<() => void>;
	history(room: Room, since: string, signal: AbortSignal): Promise<T[]>;
	normalize(input: T, signal: AbortSignal): Promise<CollectorEvent | null>;
};
export type CollectionOptions = { initialSince: string | null; checkpointMs: number };

export const abortable = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
	new Promise((resolve, reject) => {
		const aborted = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		if (signal.aborted) {
			aborted();
			return;
		}
		signal.addEventListener('abort', aborted, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener('abort', aborted);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', aborted);
				reject(error);
			},
		);
	});
export const pause = (milliseconds: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const aborted = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', aborted);
			resolve();
		}, milliseconds);
		if (signal.aborted) {
			aborted();
			return;
		}
		signal.addEventListener('abort', aborted, { once: true });
	});

export const collectConnection = async <T>(
	source: CollectorSource<T>,
	store: CollectorStore,
	options: CollectionOptions,
	externalSignal: AbortSignal,
): Promise<void> => {
	const controller = new AbortController();
	const signal = AbortSignal.any([externalSignal, controller.signal]);
	const unsubscribe: (() => void)[] = [];
	let liveTail: Promise<void> = Promise.resolve();
	const save = async (input: T, room: Room): Promise<void> => {
		signal.throwIfAborted();
		const event = await abortable(source.normalize(input, signal), signal);
		if (!event) return;
		if (event.roomId !== room.id) throw new Error('Message belongs to an unexpected room');
		signal.throwIfAborted();
		await store.enqueue([event]);
	};
	const receive =
		(room: Room) =>
		(input: T): void => {
			if (signal.aborted) return;
			liveTail = liveTail
				.then(() => save(input, room))
				.catch((error: unknown) => {
					controller.abort(error);
				});
		};
	try {
		const rooms = await abortable(source.rooms(signal), signal);
		const baseline = isoDate(options.initialSince ?? (await abortable(source.now(signal), signal)));
		// Persist the initial lower bound even if the very first history request fails.
		await Promise.all(rooms.map((room) => store.initialize(room.id, baseline)));
		for (const room of rooms) {
			// eslint-disable-next-line no-await-in-loop -- Establish subscriptions sequentially and retain each cleanup before starting the next.
			const stop = await abortable(source.subscribe(room, receive(room), signal), signal);
			unsubscribe.push(stop);
		}
		while (!signal.aborted) {
			// Checkpoint at the server time before fetching, so messages arriving during the request are covered on the next fetch.
			// eslint-disable-next-line no-await-in-loop -- Each completed catchup cycle needs a new server-clock boundary.
			const latest = isoDate(await abortable(source.now(signal), signal));
			for (const room of rooms) {
				// eslint-disable-next-line no-await-in-loop -- Read the last committed boundary immediately before each room backfill.
				const oldest = await store.cursor(room.id);
				if (!oldest || oldest > latest) throw new Error('Initial cursor is later than the Rocket.Chat server clock');
				// eslint-disable-next-line no-await-in-loop -- Fetch each room once from its saved timestamp.
				const messages = await abortable(source.history(room, oldest, signal), signal);
				for (const input of messages) {
					// eslint-disable-next-line no-await-in-loop -- Save the full response before advancing the recovery cursor.
					await save(input, room);
				}
				// eslint-disable-next-line no-await-in-loop -- Drain the live queue before committing this room coverage boundary.
				await liveTail;
				signal.throwIfAborted();
				// Only complete, durably saved history intervals move the recovery cursor.
				// eslint-disable-next-line no-await-in-loop -- Commit each fully saved room before processing the next room.
				await store.cover(room.id, latest);
			}
			// eslint-disable-next-line no-await-in-loop -- Wait between history checkpoint cycles while subscriptions stay active.
			await pause(options.checkpointMs, signal);
		}
	} catch (error) {
		if (!externalSignal.aborted) throw error;
	} finally {
		controller.abort();
		unsubscribe.forEach((stop) => stop());
		await liveTail;
	}
};

export const flushPending = async (
	store: CollectorStore,
	send: (body: ReportBody, signal: AbortSignal) => Promise<unknown>,
	signal: AbortSignal,
): Promise<void> => {
	for (const event of await store.pending()) {
		signal.throwIfAborted();
		// eslint-disable-next-line no-await-in-loop -- Bound intake load to one report request at a time.
		const result = await abortable(send(event.body, signal), signal);
		const receipt = parseReceipt(result);
		// eslint-disable-next-line no-await-in-loop -- Persist each acceptance before sending the next report.
		await store.acknowledge(event.key, receipt);
	}
};

export const deliverContinuously = async (
	store: CollectorStore,
	send: (body: ReportBody, signal: AbortSignal) => Promise<unknown>,
	signal: AbortSignal,
): Promise<void> => {
	let delay = 1000;
	while (!signal.aborted) {
		try {
			// eslint-disable-next-line no-await-in-loop -- Only one delivery cycle may be active for this outbox.
			await flushPending(store, send, signal);
			delay = 1000;
		} catch (error) {
			if (signal.aborted) return;
			console.error('[Akatsuki collector] REST delivery pending; retrying', error);
			delay = Math.min(delay * 2, 60000);
		}
		try {
			// eslint-disable-next-line no-await-in-loop -- Backoff delays must complete before the next delivery attempt.
			await pause(delay, signal);
		} catch {
			return;
		}
	}
};
