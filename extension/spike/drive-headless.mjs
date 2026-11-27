// Developer check of the spike without a person: starts server.mjs, launches Chrome for Testing
// with the spike loaded (fresh, logged-out profile), pairs it through the options page and
// prints the server's results. Logged out, the site checks are expected to report "not logged in";
// this proves the mechanics (pairing, tabs, refusal, idle survival), not the logins.
//
//   CHROME=~/.local/chrome-for-testing/chrome-linux64/chrome node drive-headless.mjs [--idle=300] [--show]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to the Chrome for Testing binary');
const idle = (process.argv.find((a) => a.startsWith('--idle=')) || '--idle=300').split('=')[1];
const headless = !process.argv.includes('--show');
const DEBUG_PORT = 9333;

const server = spawn(process.execPath, [join(here, 'server.mjs'), `--idle=${idle}`], { cwd: here });
const code = await new Promise((resolve, reject) => {
	let buf = '';
	server.stdout.on('data', (d) => {
		buf += d;
		const m = buf.match(/Pairing code:\s+(\S+)/);
		if (m) resolve(m[1]);
	});
	server.on('exit', () => reject(new Error('server exited early')));
});
// From here on, pass the server's output through, minus the pairing code.
server.stdout.on('data', (d) => process.stdout.write(String(d).replace(/Pairing code:\s+\S+/, 'Pairing code: [hidden]')));
server.stderr.pipe(process.stderr);

const profile = mkdtempSync(join(tmpdir(), 'chatbridge-spike-'));
const browser = spawn(chrome, [
	...(headless ? ['--headless=new'] : []),
	`--user-data-dir=${profile}`,
	`--remote-debugging-port=${DEBUG_PORT}`,
	`--load-extension=${here}`,
	`--disable-extensions-except=${here}`,
	'--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
	browser.kill();
	setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000);
};
server.on('exit', (c) => { cleanup(); setTimeout(() => process.exit(c ?? 0), 1500); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
	try { wsUrl = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
}
const cdp = new WebSocket(wsUrl);
await new Promise((r) => (cdp.onopen = r));
let next = 1;
const pending = new Map();
cdp.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((r) => {
	const id = next++;
	pending.set(id, r);
	cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

let extId;
for (let i = 0; i < 50 && !extId; i++) {
	const { result } = await send('Target.getTargets');
	const sw = result.targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
	if (sw) extId = new URL(sw.url).host;
	else await sleep(200);
}
if (!extId) throw new Error('the spike extension did not load');
console.log(`(driver) extension loaded: ${extId}`);

const { result: { targetId } } = await send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await sleep(1000);
const evalIn = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
await evalIn(`document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('pair').click(); 'ok'`);
await sleep(2500);
const st = await evalIn(`document.getElementById('status').textContent`);
console.log(`(driver) options page says: ${st.result.result.value}`);
