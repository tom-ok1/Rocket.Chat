import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHost, extractRuntimeConfig, readEnvironment } from '../serve.mjs';

const servers: Server[] = [];
const directories: string[] = [];
const listen = async (server: Server): Promise<string> => {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No server address');
	return `http://127.0.0.1:${address.port}`;
};
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const bundle = async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'akatsuki-web-bundle-'));
	directories.push(directory);
	await mkdir(path.join(directory, 'dynamic/client'), { recursive: true });
	await writeFile(path.join(directory, 'main.js'), '/* forked client */');
	await writeFile(path.join(directory, 'dynamic/client/module.js'), 'function() { return "local module"; }');
	await writeFile(
		path.join(directory, 'program.json'),
		JSON.stringify({
			format: 'web-program-pre1',
			manifest: [
				{ type: 'js', path: 'main.js', url: '/main.js?meteor_js_resource=true' },
				{ type: 'dynamic js', path: 'dynamic/client/module.js', url: '/dynamic/client/module.js' },
			],
		}),
	);
	return directory;
};

it('reads the direct JSON runtime configuration served by Rocket.Chat 7.10', () => {
	expect(extractRuntimeConfig('__meteor_runtime_config__ = {"meteorRelease":"METEOR@3.3","ROOT_URL":"http://localhost:3100"};\n')).toEqual({
		meteorRelease: 'METEOR@3.3',
		ROOT_URL: 'http://localhost:3100',
	});
	expect(() => extractRuntimeConfig('__meteor_runtime_config__ = {"value": process.env.SECRET};')).toThrow();
});

it('requires an external server URL and validates source/sink configuration', () => {
	expect(() => readEnvironment({})).toThrow('ROCKET_CHAT_URL');
	expect(() => readEnvironment({ ROCKET_CHAT_URL: 'file:///tmp/chat' })).toThrow();
	expect(() => readEnvironment({ ROCKET_CHAT_URL: 'https://chat.example/subpath' })).toThrow();
	const config = readEnvironment({
		ROCKET_CHAT_URL: 'https://chat.example',
		AKATSUKI_ROOM_IDS: 'r1, r2',
		AKATSUKI_SINCE: '2026-10-15T00:00:00Z',
	});
	expect(config.publicConfig.roomIds).toEqual(['r1', 'r2']);
	expect(config.publicConfig.initialSince).toBe('2026-10-15T00:00:00.000Z');
});

it('serves the forked assets and local dynamic imports while routing the client to the existing server', async () => {
	const runtime = { ROOT_URL: 'https://chat.example', autoupdateVersion: 'server-version' };
	const remote = await listen(
		createServer((request, response) => {
			if (request.url === '/') {
				response.end('<script src="/meteor_runtime_config.js?hash=test"></script>');
			} else if (request.url?.startsWith('/meteor_runtime_config.js')) {
				response.end(`__meteor_runtime_config__ = ${JSON.stringify(runtime)};`);
			} else {
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ server: 'existing-server', path: request.url }));
			}
		}),
	);
	const config = readEnvironment({ ROCKET_CHAT_URL: remote, AKATSUKI_CLIENT_BUNDLE: await bundle() });
	const local = await listen(await createHost(config));
	const html = await (await fetch(local)).text();
	const actual = extractRuntimeConfig(html);
	expect(actual.ROOT_URL).toBe(local);
	expect(actual.DDP_DEFAULT_CONNECTION_URL).toBe(local);
	expect(actual.autoupdateVersion).toBe('server-version');
	expect(html).toContain('/main.js?meteor_js_resource=true');
	expect(await (await fetch(`${local}/main.js`)).text()).toBe('/* forked client */');
	const tree = await (
		await fetch(`${local}/__meteor__/dynamic-import/fetch`, { method: 'POST', body: JSON.stringify({ client: { 'module.js': 1 } }) })
	).json();
	expect(tree.client['module.js']).toContain('local module');
	const info = await (await fetch(`${local}/api/info`)).json();
	expect(info.server).toBe('existing-server');
});

it('publishes the direct destination and does not proxy report bodies to either server', async () => {
	const received: string[] = [];
	const remote = await listen(
		createServer((request, response) => {
			received.push(request.url || '');
			response.end('{}');
		}),
	);
	const config = readEnvironment({
		ROCKET_CHAT_URL: remote,
		AKATSUKI_API_URL: `${remote}/api/reports/text`,
		AKATSUKI_CLIENT_BUNDLE: await bundle(),
	});
	const local = await listen(await createHost(config));
	const publicConfig = await (await fetch(`${local}/_akatsuki/config`)).json();
	expect(publicConfig.akatsukiUrl).toBe(`${remote}/api/reports/text`);
	const response = await fetch(`${local}/_akatsuki/reports/text`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text: '報告' }),
	});
	expect(response.status).toBe(404);
	expect(received).toEqual([]);
});
