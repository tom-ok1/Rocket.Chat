import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const readEnvironment = (env) => {
	if (!env.ROCKET_CHAT_URL) throw new Error('Set ROCKET_CHAT_URL to the existing Rocket.Chat server');
	const server = new URL(env.ROCKET_CHAT_URL);
	const akatsuki = new URL(env.AKATSUKI_API_URL || 'http://127.0.0.1:8000/api/reports/text');
	for (const url of [server, akatsuki]) {
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
			throw new Error('Use HTTP(S) URLs without credentials, query or fragment');
	}
	if (server.pathname !== '/') throw new Error('ROCKET_CHAT_URL must be a server origin, without a subpath');
	if (akatsuki.pathname !== '/api/reports/text') throw new Error('AKATSUKI_API_URL must point to /api/reports/text');
	const initialSince = env.AKATSUKI_SINCE ? new Date(env.AKATSUKI_SINCE).toISOString() : null;
	const port = Number(env.AKATSUKI_CLIENT_PORT || 3200);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AKATSUKI_CLIENT_PORT');
	return {
		server,
		port,
		bundle: path.resolve(env.AKATSUKI_CLIENT_BUNDLE || path.join(directory, '.build/bundle/programs/web.browser')),
		publicConfig: {
			version: 1,
			serverUrl: server.origin,
			akatsukiUrl: akatsuki.href,
			roomIds: (env.AKATSUKI_ROOM_IDS || '')
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean),
			initialSince,
		},
	};
};
const json = (response, status, value) => {
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(value));
};
const body = async (request) => {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > 4 * 1024 * 1024) throw new Error('Request body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
};
const escaped = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export const extractRuntimeConfig = (javascript) => {
	const encoded = javascript.match(/__meteor_runtime_config__\s*=\s*JSON\.parse\(decodeURIComponent\((['"])(.*?)\1\)\)/s);
	if (encoded) return JSON.parse(decodeURIComponent(encoded[2]));
	const direct = javascript.match(/^\s*__meteor_runtime_config__\s*=\s*(\{.*\})\s*;?\s*$/s);
	if (direct) return JSON.parse(direct[1]);
	throw new Error('Rocket.Chat runtime configuration was not found');
};
const upstreamText = async (url) => {
	const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
	if (!response.ok) throw new Error(`Rocket.Chat bootstrap HTTP ${response.status}`);
	return response.text();
};
const runtimeConfig = async (server) => {
	const html = await upstreamText(server);
	try {
		return extractRuntimeConfig(html);
	} catch {
		const reference = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
			.map((match) => match[1])
			.find((url) => url.includes('meteor_runtime_config'));
		if (!reference) throw new Error('No Meteor runtime configuration script in Rocket.Chat bootstrap');
		const url = new URL(reference.replaceAll('&amp;', '&'), server);
		if (url.origin !== server.origin) throw new Error('Unexpected runtime configuration origin');
		return extractRuntimeConfig(await upstreamText(url));
	}
};
const proxy = (incoming, outgoing, target) => {
	const headers = { ...incoming.headers, host: target.host, origin: target.origin };
	delete headers.connection;
	delete headers['accept-encoding'];
	const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
		target,
		{
			method: incoming.method,
			headers,
			timeout: 30000,
		},
		(response) => {
			const headers = { ...response.headers };
			if (headers.location?.startsWith(target.origin)) headers.location = headers.location.slice(target.origin.length) || '/';
			outgoing.writeHead(response.statusCode || 502, headers);
			response.pipe(outgoing);
		},
	);
	upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
	upstream.on('error', (error) => {
		if (!outgoing.headersSent) json(outgoing, 502, { error: error.message });
		else outgoing.destroy(error);
	});
	incoming.on('aborted', () => upstream.destroy());
	incoming.pipe(upstream);
};
const mime = (filename) =>
	({
		'.js': 'application/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.woff': 'font/woff',
		'.woff2': 'font/woff2',
		'.ico': 'image/x-icon',
	})[path.extname(filename)] || 'application/octet-stream';

export const createHost = async (config) => {
	const program = JSON.parse(await readFile(path.join(config.bundle, 'program.json'), 'utf8'));
	if (program.format !== 'web-program-pre1' || !Array.isArray(program.manifest))
		throw new Error('Unsupported Meteor client program manifest');
	const files = new Map(
		program.manifest
			.filter((entry) => typeof entry.url === 'string')
			.map((entry) => [new URL(entry.url, 'http://localhost').pathname, entry]),
	);
	const readAsset = async (entry) => {
		const filename = path.resolve(config.bundle, entry.path);
		if (!filename.startsWith(`${config.bundle}${path.sep}`)) throw new Error('Invalid client asset path');
		return readFile(filename);
	};
	const dynamic = async (tree, parts = []) => {
		if (!tree) return null;
		if (typeof tree !== 'object') {
			const entry = files.get(`/dynamic/${parts.join('/').replaceAll(':', '_')}`);
			return entry?.type === 'dynamic js' ? (await readAsset(entry)).toString('utf8') : null;
		}
		if (Array.isArray(tree)) throw new Error('Invalid dynamic import tree');
		const result = Object.create(null);
		for (const [key, value] of Object.entries(tree)) {
			if (key === '..' || key.includes('/') || key.includes('\\')) throw new Error('Invalid dynamic import path');
			const source = await dynamic(value, [...parts, key]);
			if (source !== null) result[key] = source;
		}
		return Object.keys(result).length ? result : null;
	};
	const server = createServer(async (request, response) => {
		// A missing upstream Date must not be replaced with this PC's clock.
		response.sendDate = false;
		try {
			if (!request.headers.host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host)) {
				json(response, 403, { error: 'Use the loopback client host' });
				return;
			}
			const url = new URL(request.url || '/', `http://${request.headers.host}`);
			if (url.pathname === '/_akatsuki/config') {
				json(response, 200, config.publicConfig);
				return;
			}
			if (url.pathname.startsWith('/_akatsuki/')) {
				json(response, 404, { error: 'Unknown collector route' });
				return;
			}
			if (url.pathname === '/__meteor__/dynamic-import/fetch') {
				if (request.method !== 'POST') {
					json(response, 405, { error: 'POST required' });
					return;
				}
				json(response, 200, await dynamic(JSON.parse(await body(request))));
				return;
			}
			const entry = files.get(url.pathname);
			if (entry) {
				response.writeHead(200, { 'Content-Type': mime(entry.path) });
				response.end(await readAsset(entry));
				return;
			}
			if (request.method === 'GET' && (url.pathname === '/' || request.headers.accept?.includes('text/html'))) {
				const runtime = await runtimeConfig(config.server);
				runtime.ROOT_URL = url.origin;
				runtime.ROOT_URL_PATH_PREFIX = '';
				runtime.DDP_DEFAULT_CONNECTION_URL = url.origin;
				// Keep the remote runtime's autoupdate version so its publication does not force reload loops.
				const bootstrap = `__meteor_runtime_config__ = JSON.parse(decodeURIComponent(${JSON.stringify(encodeURIComponent(JSON.stringify(runtime)))}));`;
				const css = program.manifest
					.filter((entry) => entry.type === 'css')
					.map((entry) => `<link rel="stylesheet" href="${escaped(entry.url)}">`)
					.join('');
				const scripts = program.manifest
					.filter((entry) => entry.type === 'js')
					.map((entry) => `<script src="${escaped(entry.url)}"></script>`)
					.join('');
				response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
				response.end(
					`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="/"><script>${bootstrap}</script>${css}</head><body><div id="react-root"></div>${scripts}</body></html>`,
				);
				return;
			}
			proxy(request, response, new URL(`${url.pathname}${url.search}`, config.server));
		} catch (error) {
			if (!response.headersSent) json(response, 502, { error: error instanceof Error ? error.message : 'Client host failed' });
			else response.destroy();
		}
	});
	server.on('upgrade', (request, socket, head) => {
		const localOrigin = `http://${request.headers.host}`;
		if (
			!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host || '') ||
			(request.headers.origin && request.headers.origin !== localOrigin)
		) {
			socket.destroy();
			return;
		}
		if (!request.url?.startsWith('/websocket') && !request.url?.startsWith('/sockjs/')) {
			socket.destroy();
			return;
		}
		const target = new URL(request.url, config.server);
		const headers = { ...request.headers, host: target.host, origin: target.origin };
		const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { headers, timeout: 30000 });
		upstream.on('upgrade', (response, remote, remoteHead) => {
			remote.setTimeout(0);
			socket.setTimeout(0);
			socket.write(
				`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers)
					.map(([key, value]) => `${key}: ${value}`)
					.join('\r\n')}\r\n\r\n`,
			);
			if (remoteHead.length) socket.write(remoteHead);
			if (head.length) remote.write(head);
			remote.pipe(socket);
			socket.pipe(remote);
			socket.on('error', () => remote.destroy());
			remote.on('error', () => socket.destroy());
			socket.on('close', () => remote.destroy());
			remote.on('close', () => socket.destroy());
		});
		upstream.on('response', () => socket.destroy());
		upstream.on('timeout', () => upstream.destroy());
		upstream.on('error', () => socket.destroy());
		upstream.end();
	});
	return server;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const config = readEnvironment(process.env);
	const server = await createHost(config);
	server.listen(config.port, '127.0.0.1', () =>
		console.info(`Rocket.Chat client: http://localhost:${config.port} → ${config.server.origin}`),
	);
}
