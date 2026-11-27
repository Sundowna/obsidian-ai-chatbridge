// Developer check of the spike without a person: starts server.mjs, launches Chrome with a fresh,
// logged-out throwaway profile, loads the spike through the DevTools pipe (Extensions.loadUnpacked,
// which also works in branded Chrome 137+ where --load-extension no longer does), pairs it through
// the options page and prints the server's results. Logged out, the site checks are expected to
// report "not logged in"; this proves the mechanics (pairing, tabs, refusal, idle survival), not the logins.
//
//   CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node drive-headless.mjs [--idle=300] [--only=claude,chatgpt,gemini,studio] [--show]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to the Chrome binary');
const idle = (process.argv.find((a) => a.startsWith('--idle=')) || '--idle=300').split('=')[1];
const headless = !process.argv.includes('--show');

const only = process.argv.filter((a) => a.startsWith('--only='));
const server = spawn(process.execPath, [join(here, 'server.mjs'), `--idle=${idle}`, ...only], { cwd: here });
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
	'--remote-debugging-pipe',
	'--enable-unsafe-extension-debugging',
	'--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const toChrome = browser.stdio[3];
const fromChrome = browser.stdio[4];

const cleanup = () => {
	browser.kill();
	setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
};
server.on('exit', (c) => { cleanup(); setTimeout(() => process.exit(c ?? 0), 2000); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let next = 1;
const pending = new Map();
let inbuf = '';
fromChrome.on('data', (d) => {
	inbuf += d;
	let i;
	while ((i = inbuf.indexOf('\0')) >= 0) {
		const m = JSON.parse(inbuf.slice(0, i));
		inbuf = inbuf.slice(i + 1);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	}
});
const send = (method, params = {}, sessionId) => new Promise((r) => {
	const id = next++;
	pending.set(id, r);
	toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});

const loaded = await send('Extensions.loadUnpacked', { path: here });
if (loaded.error) throw new Error('loadUnpacked failed: ' + loaded.error.message);
const extId = loaded.result.id;
console.log(`(driver) extension loaded: ${extId}`);

const { result: { targetId } } = await send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await sleep(1500);
const evalIn = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
await evalIn(`document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('pair').click(); 'ok'`);
await sleep(2500);
const st = await evalIn(`document.getElementById('status').textContent`);
console.log(`(driver) options page says: ${st.result?.result?.value}`);

// Safety check the server cannot make by itself: a web page (not the extension) tries the port.
const page = await send('Target.createTarget', { url: 'about:blank' });
const ps = await send('Target.attachToTarget', { targetId: page.result.targetId, flatten: true });
const port = code.split('-')[0];
const probe = await send('Runtime.evaluate', {
	expression: `new Promise((r) => { const s = new WebSocket('ws://127.0.0.1:${port}'); s.onopen = () => s.send(JSON.stringify({op:'hello', token:'guess'})); s.onclose = (e) => r('closed ' + e.code); setTimeout(() => r('still open'), 4000); })`,
	awaitPromise: true, returnByValue: true,
}, ps.result.sessionId);
console.log(`(driver) web page probe of the port: ${probe.result?.result?.value}`);
