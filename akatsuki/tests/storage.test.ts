import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectorStore } from '../../apps/meteor/client/akatsuki/storage';

const event = {
	key: 'event-1',
	roomId: 'r1',
	status: 'pending' as const,
	body: {
		text: '合成報告',
		acquisition: { kind: 'manual_text' as const },
		sourceAsset: { deviceId: 'unit-1', category: 'unknown' as const },
	},
	receipt: null,
};
const stores: CollectorStore[] = [];
const open = async (name = crypto.randomUUID()) => {
	const store = await CollectorStore.open(name);
	stores.push(store);
	return store;
};
afterEach(() => {
	stores.forEach((store) => store.close());
	stores.length = 0;
});

it('persists cursor and outbox across reopening, and deduplicates replay', async () => {
	const name = crypto.randomUUID();
	const first = await open(name);
	await first.initialize('r1', '2026-10-15T00:00:00.000Z');
	await first.enqueue([event]);
	await first.cover('r1', '2026-10-15T01:00:00.000Z');
	first.close();
	const second = await open(name);
	expect(await second.cursor('r1')).toBe('2026-10-15T01:00:00.000Z');
	await second.enqueue([event]);
	expect(await second.pending()).toHaveLength(1);
	await second.acknowledge(event.key, { reportId: 'report-1', analysisRunId: 'run-1' });
	second.close();
	const third = await open(name);
	await third.enqueue([event]);
	expect(await third.pending()).toEqual([]);
});

it('does not move cursor merely because a live message was saved', async () => {
	const store = await open();
	await store.initialize('r1', '2026-10-15T00:00:00.000Z');
	await store.enqueue([event]);
	expect(await store.cursor('r1')).toBe('2026-10-15T00:00:00.000Z');
	await expect(store.cover('r1', '2026-10-14T00:00:00.000Z')).rejects.toThrow('backwards');
});

const rawOpen = (name: string, version: number) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name, version);
		request.onupgradeneeded = () => {
			for (const name of ['meta', 'cursors', 'events'])
				request.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : name === 'cursors' ? 'roomId' : 'key' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

it.each([undefined, 0, 2, 99])('rejects an incompatible version marker %s without changing it', async (version) => {
	const name = crypto.randomUUID();
	const db = await rawOpen(name, 1);
	if (version !== undefined)
		await new Promise<void>((resolve) => {
			const tx = db.transaction('meta', 'readwrite');
			tx.objectStore('meta').put({ key: 'schema', version });
			tx.oncomplete = () => resolve();
		});
	db.close();
	await expect(open(name)).rejects.toThrow('incompatible');
	await expect(open(name)).rejects.toThrow('incompatible');
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
	expect(await (await open(name)).pending()).toEqual([]);
});

it('rejects future database versions and malformed current records', async () => {
	const futureName = crypto.randomUUID();
	(await rawOpen(futureName, 2)).close();
	await expect(open(futureName)).rejects.toThrow('incompatible');
	const name = crypto.randomUUID();
	const store = await open(name);
	store.close();
	const db = await rawOpen(name, 1);
	await new Promise<void>((resolve) => {
		const tx = db.transaction('events', 'readwrite');
		tx.objectStore('events').put({ key: 'bad' });
		tx.oncomplete = () => resolve();
	});
	db.close();
	await expect(open(name)).rejects.toThrow('incompatible');
});

it('rolls back a partial outbox transaction on a failed durable write', async () => {
	const store = await open();
	const add = IDBObjectStore.prototype.add;
	let count = 0;
	const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey,
	) {
		if (++count === 2) throw new DOMException('disk full', 'QuotaExceededError');
		return add.call(this, value, key);
	});
	try {
		await expect(store.enqueue([event, { ...event, key: 'event-2' }])).rejects.toThrow('disk full');
		expect(await store.pending()).toEqual([]);
	} finally {
		spy.mockRestore();
	}
});
