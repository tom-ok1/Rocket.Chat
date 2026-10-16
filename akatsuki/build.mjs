import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meteor = process.env.METEOR_BINARY || path.join(os.homedir(), '.meteor/meteor');
try {
	await access(meteor, constants.X_OK);
} catch {
	throw new Error(
		'Meteor 3.3 is required. Run: npm_config_global=true npm_config_ignore_meteor_setup_exec_path=true mise exec node@22.16.0 npm:meteor@3.3.0 -- meteor-installer install',
	);
}
const run = (command, args, cwd = root) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, PATH: `${path.dirname(meteor)}${path.delimiter}${process.env.PATH || ''}` },
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
	});
const yarn = path.join(root, '.yarn/releases/yarn-4.9.2.cjs');
await run(process.execPath, [yarn, 'install', '--immutable']);
await run(process.execPath, [yarn, 'exec', 'turbo', 'run', 'build', '--filter=@rocket.chat/meteor^...']);
await run(meteor, ['build', path.join(root, 'akatsuki/.build'), '--directory', '--server-only'], path.join(root, 'apps/meteor'));
const manifest = JSON.parse(await readFile(path.join(root, 'akatsuki/.build/bundle/programs/web.browser/program.json'), 'utf8'));
console.info(`Built forked browser client: ${manifest.manifest.length} manifest entries. Start with npm --prefix akatsuki start.`);
