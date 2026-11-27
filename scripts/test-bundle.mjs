// The plugin bundle, built with the real build options (esbuild.shared.mjs):
//   1. it loads without any Node module, as on a phone or tablet (the Browser link server and
//      its `ws` are loaded only when the server starts);
//   2. the bundled Browser link server is the real `ws`, not its browser stub: it starts and
//      pairs with a browser extension.
// Run: npm run test:bundle

import esbuild from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import WebSocket from 'ws';
import { pluginBundle } from '../esbuild.shared.mjs';

let failures = 0;
function expect(label, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const build = async (extra) => (await esbuild.build({ ...pluginBundle, ...extra, write: false, minify: true, logLevel: 'silent' })).outputFiles[0].text;
const load = (code, req) => {
	const module = { exports: {} };
	new Function('module', 'exports', 'require', code)(module, module.exports, req);
	return module.exports;
};

// 1. The plugin, with only Obsidian there: no Node module may be asked for while it loads.
const main = await build({});
expect('bundle: the browser stub of ws is not in the plugin', !main.includes('ws does not work in the browser'));
const asked = [];
const anything = new Proxy(class {}, { get: (t, k) => (k === 'prototype' ? t.prototype : k === Symbol.toPrimitive ? undefined : anything) });
let loaded = null;
try {
	loaded = load(main, (name) => {
		if (name === 'obsidian') return anything;
		asked.push(name);
		throw new Error(`no ${name} on a phone`);
	});
} catch (e) {
	expect('phone: the plugin loads', false, e instanceof Error ? e.message : String(e));
}
if (loaded) expect('phone: the plugin loads', typeof loaded.default === 'function');
expect('phone: no Node module is loaded at start', asked.length === 0, asked.join(', '));

// 2. The Browser link server from the same build options, with Node there (a computer).
const nodeRequire = createRequire(import.meta.url);
globalThis.window = globalThis;
globalThis.require = nodeRequire;
const serverCode = await build({ entryPoints: ['src/link/server.ts'] });
expect('bundle: the server bundle carries the real ws', !serverCode.includes('ws does not work in the browser'));
const { LinkServer } = load(serverCode, (name) => {
	if (name === 'bufferutil' || name === 'utf-8-validate') throw new Error('optional');
	if (builtinModules.includes(name.replace(/^node:/, ''))) return nodeRequire(name);
	throw new Error(`unexpected module ${name}`);
});
let token = null;
const server = new LinkServer({ store: { get: () => token, set: (t) => { token = t; } } });
try {
	const port = await server.start();
	expect('computer: the bundled server listens on 127.0.0.1', port > 0 && server.listening);
	const reply = await new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
		ws.on('open', () => ws.send(JSON.stringify({ op: 'pair', code: server.newPairingCode() })));
		ws.on('message', (m) => { resolve(JSON.parse(String(m))); ws.close(); });
		ws.on('error', (e) => resolve({ error: e.message }));
	});
	expect('computer: a browser extension pairs with the bundled server', reply.op === 'paired' && !!token, JSON.stringify(reply.error ?? reply.op));
} finally {
	await server.stop();
}

console.log(failures ? `${failures} bundle check(s) FAILED.` : 'All bundle checks passed.');
process.exit(failures ? 1 : 0);
