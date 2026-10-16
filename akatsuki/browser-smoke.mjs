import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = `
import { CollectorStore } from './apps/meteor/client/akatsuki/storage';
import { collectConnection, deliverContinuously } from './apps/meteor/client/akatsuki/core';
import { messageToEvent } from './apps/meteor/client/akatsuki/model';
import { sendReport } from './apps/meteor/client/akatsuki/transport';
window.fixture = { async start() {
 const controller = new AbortController(); const store = await CollectorStore.open('browser-recovery-smoke');
 const source = {
  rooms: async () => [{id:'r1',type:'c'}],
  now: async () => (await (await fetch('/clock')).json()).now,
  subscribe: async (_room, receive) => { const events = new EventSource('/events'); events.onmessage = event => receive(JSON.parse(event.data)); await new Promise((resolve,reject) => { events.onopen=resolve; events.onerror=reject; }); return () => events.close(); },
  history: async (_room, since, signal) => (await fetch('/history?'+new URLSearchParams({since}),{signal})).json(),
  normalize: message => messageToEvent('https://existing-chat.example',message)
 };
 const capture = collectConnection(source,store,{initialSince:'2026-10-15T00:00:00Z',checkpointMs:60000},controller.signal);
 const deliveries = deliverContinuously(store,(body,signal) => sendReport(window.sinkUrl,body,signal),controller.signal);
 return {store,controller,capture,deliveries};
}};
window.running = window.fixture.start();
`;
const compiled = await build({
	stdin: { contents: fixture, resolveDir: root, loader: 'ts' },
	bundle: true,
	write: false,
	format: 'iife',
	target: 'chrome120',
	tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
});
let now = '2026-10-15T01:00:00.000Z';
const raw = (id, ts) => ({ _id: id, rid: 'r1', msg: `合成試験報告 ${id}`, ts, u: { _id: 'u1' } });
const messages = [raw('m1', '2026-10-15T00:30:00.000Z')];
const accepted = [];
const receipts = [];
const historyStarts = [];
const streams = new Set();
let sinkAvailable = true;
let preflights = 0;
const handler = async (request, response) => {
	const url = new URL(request.url, 'http://localhost');
	if (url.pathname === '/bundle.js') {
		response.setHeader('Content-Type', 'application/javascript');
		response.end(compiled.outputFiles[0].text);
	} else if (url.pathname === '/clock') {
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ now }));
	} else if (url.pathname === '/events') {
		response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		response.write(': ready\n\n');
		streams.add(response);
		request.on('close', () => streams.delete(response));
	} else if (url.pathname === '/history') {
		const since = url.searchParams.get('since');
		historyStarts.push(since);
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify(messages.filter((m) => m.ts > since)));
	} else if (url.pathname === '/api/reports/text') {
		assert.equal(request.headers.origin, origin);
		assert.equal(request.headers.cookie, undefined);
		assert.equal(request.headers['x-auth-token'], undefined);
		response.setHeader('Access-Control-Allow-Origin', origin);
		if (request.method === 'OPTIONS') {
			preflights++;
			response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
			response.end();
			return;
		}
		let text = '';
		for await (const chunk of request) text += chunk;
		if (!sinkAvailable) {
			response.writeHead(503);
			response.end();
			return;
		}
		const body = JSON.parse(text);
		const match = /^合成試験報告 (m\d+)$/.exec(body.text);
		assert.ok(match, 'Report text must contain only the message body');
		const messageId = match[1];
		accepted.push(messageId);
		response.setHeader('Content-Type', 'application/json');
		let receipt = { report: { id: 'rr-' + messageId }, analysisRun: { id: 'ar-' + messageId } };
		if (process.env.AKATSUKI_ACCEPTANCE_URL) {
			const result = await fetch(process.env.AKATSUKI_ACCEPTANCE_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!result.ok) throw new Error(`Actual Akatsuki intake HTTP ${result.status}`);
			receipt = await result.json();
		}
		receipts.push({ messageId, reportId: receipt.report.id, analysisRunId: receipt.analysisRun.id });
		response.end(JSON.stringify(receipt));
	} else {
		response.setHeader('Content-Type', 'text/html');
		response.setHeader('Set-Cookie', 'rocket=secret; Path=/');
		response.end(`<!doctype html><script>window.sinkUrl=${JSON.stringify(sinkUrl)}</script><script src="/bundle.js"></script>`);
	}
};
const server = createServer(handler);
const sink = createServer(handler);
await new Promise((resolve, reject) => {
	sink.once('error', reject);
	sink.listen(0, '127.0.0.1', resolve);
});
const sinkUrl = `http://127.0.0.1:${sink.address().port}/api/reports/text`;
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const waitFor = async (condition) => {
	const limit = Date.now() + 15000;
	while (!condition()) {
		if (Date.now() > limit) throw new Error('Smoke test timed out');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};
try {
	let page = await context.newPage();
	await page.goto(origin);
	await waitFor(() => accepted.includes('m1'));
	messages.push(raw('m2', '2026-10-15T01:30:00.000Z'));
	for (const stream of streams) stream.write('data: ' + JSON.stringify(messages.at(-1)) + '\n\n');
	await waitFor(() => accepted.includes('m2'));
	await page.close();
	now = '2026-10-15T03:00:00.000Z';
	messages.push(raw('m3', '2026-10-15T02:30:00.000Z'));
	page = await context.newPage();
	await page.goto(origin);
	await waitFor(() => accepted.includes('m3'));
	assert.ok(historyStarts.includes('2026-10-15T01:00:00.000Z'));
	assert.deepEqual(accepted, ['m1', 'm2', 'm3']);
	sinkAvailable = false;
	messages.push(raw('m4', '2026-10-15T03:30:00.000Z'));
	for (const stream of streams) stream.write('data: ' + JSON.stringify(messages.at(-1)) + '\n\n');
	await page.waitForFunction(async () => {
		const running = await window.running;
		return (await running.store.pending()).length === 1;
	});
	await page.close();
	now = '2026-10-15T04:00:00.000Z';
	page = await context.newPage();
	await page.goto(origin);
	await page.waitForFunction(async () => {
		const running = await window.running;
		return (await running.store.pending()).length === 1;
	});
	sinkAvailable = true;
	await waitFor(() => accepted.includes('m4'));
	assert.deepEqual(accepted, ['m1', 'm2', 'm3', 'm4']);
	assert.ok(preflights > 0);
	console.info(
		JSON.stringify({
			browser: 'Chrome',
			directCrossOriginRest: 'passed',
			indexedDbRecovery: 'passed',
			historyThenStream: 'passed',
			restOutageRecovery: 'passed',
			accepted,
			receipts,
		}),
	);
} finally {
	await context.close();
	await browser.close();
	for (const stream of streams) stream.end();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	sink.closeAllConnections();
	await new Promise((resolve) => sink.close(resolve));
}
