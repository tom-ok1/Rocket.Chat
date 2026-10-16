import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { CollectorStore } from '../../apps/meteor/client/akatsuki/storage';
import { collectConnection, flushPending } from '../../apps/meteor/client/akatsuki/core';
import { messageToEvent } from '../../apps/meteor/client/akatsuki/model';
import type { CollectorSource } from '../../apps/meteor/client/akatsuki/core';

const room = { id: 'r1', type: 'c' as const };
const raw = (id: string) => ({ _id: id, rid: 'r1', msg: `報告 ${id}`, ts: '2026-10-15T00:30:00Z', u: { _id: 'u1' } });
const setup = async () => {
	const store = await CollectorStore.open(crypto.randomUUID());
	const controller = new AbortController();
	let receive: ((message: unknown) => void) | undefined;
	const stop = vi.fn();
	const source: CollectorSource<unknown> = {
		rooms: async () => [room],
		now: async () => '2026-10-15T01:00:00.000Z',
		subscribe: vi.fn(async (_room, listener) => {
			receive = listener;
			return stop;
		}),
		history: vi.fn(async () => []),
		normalize: (input) => messageToEvent('https://chat.example', input),
	};
	return { store, source, controller, stop, receive: (input: unknown) => receive?.(input) };
};

it('fetches messages after the saved cursor once per room and deduplicates the live overlap', async () => {
	const ctx = await setup();
	ctx.source.history = vi.fn(async (_room, since) => {
		expect(ctx.source.subscribe).toHaveBeenCalled();
		expect(since).toBe('2026-10-15T00:00:00.000Z');
		ctx.receive(raw('m1'));
		return [raw('m1'), raw('m2')];
	});
	const running = collectConnection(
		ctx.source,
		ctx.store,
		{ initialSince: '2026-10-15T00:00:00Z', checkpointMs: 60000 },
		ctx.controller.signal,
	);
	await vi.waitFor(async () => expect(await ctx.store.cursor('r1')).toBe('2026-10-15T01:00:00.000Z'));
	expect(await ctx.store.pending()).toHaveLength(2);
	expect(ctx.source.history).toHaveBeenCalledExactlyOnceWith(room, '2026-10-15T00:00:00.000Z', expect.any(AbortSignal));
	ctx.controller.abort();
	await running;
	expect(ctx.stop).toHaveBeenCalledTimes(1);
	ctx.store.close();
});

it('does not advance a cursor when history decryption or persistence fails', async () => {
	const ctx = await setup();
	ctx.source.history = vi.fn(async () => [raw('m1')]);
	ctx.source.normalize = async () => {
		throw new Error('key locked');
	};
	await expect(
		collectConnection(ctx.source, ctx.store, { initialSince: '2026-10-15T00:00:00Z', checkpointMs: 60000 }, ctx.controller.signal),
	).rejects.toThrow('key locked');
	expect(await ctx.store.cursor('r1')).toBe('2026-10-15T00:00:00.000Z');
	expect(ctx.stop).toHaveBeenCalled();
	ctx.store.close();
});

it('retains a completed cursor on reconnect and passes it as the history start', async () => {
	const ctx = await setup();
	await ctx.store.initialize('r1', '2026-10-14T00:00:00Z');
	await ctx.store.cover('r1', '2026-10-15T00:00:00Z');
	const running = collectConnection(ctx.source, ctx.store, { initialSince: null, checkpointMs: 60000 }, ctx.controller.signal);
	await vi.waitFor(() => expect(ctx.source.history).toHaveBeenCalledWith(room, '2026-10-15T00:00:00.000Z', expect.any(AbortSignal)));
	ctx.controller.abort();
	await running;
	ctx.store.close();
});

it('continues from the same cursor after an abort during history retrieval', async () => {
	const ctx = await setup();
	ctx.source.history = vi.fn(() => new Promise<unknown[]>(() => undefined));
	const running = collectConnection(
		ctx.source,
		ctx.store,
		{ initialSince: '2026-10-15T00:00:00Z', checkpointMs: 60000 },
		ctx.controller.signal,
	);
	await vi.waitFor(() => expect(ctx.source.history).toHaveBeenCalledTimes(1));
	ctx.controller.abort();
	await running;
	expect(await ctx.store.cursor('r1')).toBe('2026-10-15T00:00:00.000Z');
	expect(ctx.stop).toHaveBeenCalled();
	ctx.store.close();
});

it('keeps rejected or unacknowledged REST deliveries for retry', async () => {
	const store = await CollectorStore.open(crypto.randomUUID());
	const event = await messageToEvent('https://chat.example', raw('m1'));
	if (!event) throw new Error('Missing test event');
	await store.enqueue([event]);
	const signal = new AbortController().signal;
	await expect(
		flushPending(
			store,
			async () => {
				throw new Error('offline');
			},
			signal,
		),
	).rejects.toThrow('offline');
	await expect(flushPending(store, async () => ({}), signal)).rejects.toThrow();
	expect(await store.pending()).toHaveLength(1);
	const send = vi.fn(async () => ({ report: { id: 'report-1' }, analysisRun: { id: 'run-1' } }));
	await flushPending(store, send, signal);
	expect(await store.pending()).toEqual([]);
	await store.enqueue([event]);
	await flushPending(store, send, signal);
	expect(send).toHaveBeenCalledTimes(1);
	store.close();
});

it('keeps the cursor when live decryption fails during history catchup', async () => {
	const ctx = await setup();
	ctx.source.history = async () => {
		ctx.receive({ ...raw('encrypted'), t: 'e2e' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		return [];
	};
	await expect(
		collectConnection(ctx.source, ctx.store, { initialSince: '2026-10-15T00:00:00Z', checkpointMs: 60000 }, ctx.controller.signal),
	).rejects.toThrow('not decrypted');
	expect(await ctx.store.cursor('r1')).toBe('2026-10-15T00:00:00.000Z');
	expect(ctx.stop).toHaveBeenCalled();
	ctx.store.close();
});
