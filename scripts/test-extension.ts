// Browser link extension (Stage 3), end to end: the real extension (extension/dist) in a real
// Chrome with a fresh, logged-out throwaway profile, talking to the plugin's real link server.
// The pairing code is typed into the extension's options page like a person would.
// Logged out, the sites answer "not logged in"; this proves the mechanics, not the logins.
// Needs Chrome and an internet connection, so it is not part of test:ci.
//
//   npm run test:extension            (CHROME=<path to chrome.exe> if Chrome is elsewhere)

// As in Obsidian on a computer: a window with Node's require.
Object.assign(globalThis, { window: globalThis, require });

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { LinkServer, type TokenStore } from '../src/link/server';
import { BrowserLinkUnavailable } from '../src/link/errors';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await sleep(250);
	}
	return check();
}
async function rejection(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return e instanceof Error ? e : new Error(String(e));
	}
}

const CHROME_PATHS = [
	process.env.CHROME,
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
];
const chromePath = CHROME_PATHS.find((p): p is string => !!p && existsSync(p));
if (!chromePath) {
	console.log('NOT RUN  No Chrome found. Set CHROME to the Chrome binary and run again.');
	process.exit(1);
}
const extDir = resolve(__dirname, '..', 'extension', 'dist');

// ---- Chrome over the DevTools pipe ----------------------------------------------------------

type Cdp = { id?: number; result?: Record<string, unknown>; error?: { message: string } };
let browser: ChildProcess;
let toChrome: Writable;
let nextId = 1;
const waiting = new Map<number, (m: Cdp) => void>();

function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Cdp> {
	return new Promise((r) => {
		const id = nextId++;
		waiting.set(id, r);
		toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
	});
}

function startChrome(profile: string): void {
	browser = spawn(chromePath!, [
		'--headless=new',
		`--user-data-dir=${profile}`,
		'--remote-debugging-pipe',
		'--enable-unsafe-extension-debugging',
		'--no-first-run', '--no-default-browser-check', 'about:blank',
	], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
	toChrome = browser.stdio[3] as Writable;
	let buf = '';
	(browser.stdio[4] as Readable).on('data', (d: Buffer) => {
		buf += d.toString();
		let i;
		while ((i = buf.indexOf('\0')) >= 0) {
			const m = JSON.parse(buf.slice(0, i)) as Cdp;
			buf = buf.slice(i + 1);
			if (m.id && waiting.has(m.id)) {
				waiting.get(m.id)!(m);
				waiting.delete(m.id);
			}
		}
	});
}

async function evalIn(sessionId: string, expression: string): Promise<unknown> {
	const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
	return (r.result?.result as { value?: unknown } | undefined)?.value;
}

/** Addresses of the open tabs (pages only). */
async function tabUrls(): Promise<string[]> {
	const r = await cdp('Target.getTargets');
	return ((r.result?.targetInfos ?? []) as { type: string; url: string }[]).filter((t) => t.type === 'page').map((t) => t.url);
}
const tabsOn = async (host: string) => (await tabUrls()).filter((u) => u.includes(host)).length;

// ---- the run --------------------------------------------------------------------------------

const store: TokenStore & { value: string | null } = { value: null, get() { return this.value; }, set(t) { this.value = t; } };
const profile = mkdtempSync(join(tmpdir(), 'chatbridge-ext-test-'));
let server = new LinkServer({ store });

async function run(): Promise<void> {
	const port = await server.start();
	startChrome(profile);

	const loaded = await cdp('Extensions.loadUnpacked', { path: extDir });
	const extId = loaded.result?.id as string | undefined;
	expect('install: the built extension loads unpacked', !!extId, loaded.error?.message);
	if (!extId) return;

	const opt = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
	const optSession = (await cdp('Target.attachToTarget', { targetId: opt.result?.targetId, flatten: true })).result?.sessionId as string;
	const stateText = () => evalIn(optSession, `document.getElementById('state-text').textContent`) as Promise<string>;
	const stateName = () => evalIn(optSession, `document.getElementById('state').dataset.state`) as Promise<string>;
	await until(async () => (await stateName()) === 'not-paired', 5000);
	expect('options: a new install says "Not paired"', (await stateText()) === 'Not paired', await stateText());

	// A code that is not a pairing code is refused on the page itself.
	await evalIn(optSession, `document.getElementById('code').value = 'hello'; document.getElementById('pair').click(); 'ok'`);
	expect('options: a malformed code is refused on the page', /does not look like a pairing code/.test(await stateText()));
	expect('options: nothing reached the plugin', !server.linked && !server.paired);

	// A wrong code with the right port: the plugin refuses it.
	server.newPairingCode();
	await evalIn(optSession, `document.getElementById('code').value = '${port}-AAAA-AAAA-AAAA'; document.getElementById('pair').click(); 'ok'`);
	await until(async () => (await stateName()) === 'refused', 10_000);
	expect('pairing: a wrong code is refused by the plugin', (await stateName()) === 'refused' && !server.paired, await stateText());

	// The right code, typed as a person would.
	const code = server.newPairingCode();
	await evalIn(optSession, `document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('pair').click(); 'ok'`);
	await until(async () => (await stateName()) === 'linked', 10_000);
	expect('pairing: the code from the plugin links the browser', (await stateName()) === 'linked' && server.linked && server.paired, await stateText());
	expect('options: "Linked to Obsidian" shown', (await stateText()) === 'Linked to Obsidian');
	expect('options: the code field is emptied after pairing', (await evalIn(optSession, `document.getElementById('code').value`)) === '');
	const token = store.value;

	// A web page (not the extension) tries the port.
	const pg = await cdp('Target.createTarget', { url: 'about:blank' });
	const pgSession = (await cdp('Target.attachToTarget', { targetId: pg.result?.targetId, flatten: true })).result?.sessionId as string;
	const probe = await evalIn(pgSession, `new Promise((r) => { const s = new WebSocket('ws://127.0.0.1:${port}'); s.onopen = () => s.send(JSON.stringify({op:'hello', token:'guess'})); s.onclose = (e) => r('closed ' + e.code); setTimeout(() => r('still open'), 4000); })`);
	expect('security: a web page cannot use the port', probe !== 'still open', String(probe));
	expect('security: the extension stays linked meanwhile', server.linked);
	await cdp('Target.closeTarget', { targetId: pg.result?.targetId });

	// Fetch with no tab of the site open: the extension opens a background tab for it.
	expect('tabs: no claude.ai tab before the first request', (await tabsOn('claude.ai')) === 0);
	const t0 = Date.now();
	const org = await rejection(server.fetch('https://claude.ai/api/organizations', 'GET', { Accept: 'application/json' }).then((r) => {
		expect('fetch: claude.ai answers through the browser', r.status > 0, `status ${r.status}, ${r.body.length} bytes, ${Date.now() - t0} ms`);
		expect('fetch: answer headers come back', Object.keys(r.headers).length > 0);
	}));
	expect('fetch: no error', !org, org?.message);
	expect('tabs: the extension opened one background claude.ai tab', (await tabsOn('claude.ai')) === 1);

	// Binary answer, byte for byte, against a direct download.
	const fav = await rejection(server.fetch('https://claude.ai/favicon.ico', 'GET', {}).then(async (r) => {
		const direct = new Uint8Array(await (await fetch('https://claude.ai/favicon.ico')).arrayBuffer());
		const same = direct.length > 0 && direct.length === r.body.length && direct.every((b, i) => b === r.body[i]);
		expect('fetch: a binary answer arrives byte for byte', r.status === 200 && same, `${r.body.length} vs ${direct.length} bytes`);
	}));
	expect('fetch: binary request had no error', !fav, fav?.message);
	expect('tabs: the same background tab is reused', (await tabsOn('claude.ai')) === 1);

	// The extension's own allow-list (the plugin's is tested in test:channel): send past the plugin.
	const raw = (server as unknown as { send(req: unknown, ms: number): Promise<unknown> }).send.bind(server);
	for (const [label, req] of [
		['a fetch to another site', { op: 'fetch', url: 'https://example.com/', method: 'GET', headers: {} }],
		['a fetch over plain http', { op: 'fetch', url: 'http://claude.ai/', method: 'GET', headers: {} }],
		['a fetch with another method', { op: 'fetch', url: 'https://claude.ai/', method: 'DELETE', headers: {} }],
		['opening another site', { op: 'open', url: 'https://example.com/', ready: 'loaded', timeoutMs: 5000 }],
		['an unknown ready check', { op: 'open', url: 'https://gemini.google.com/app', ready: 'document.cookie', timeoutMs: 5000 }],
		['a signed call in a page it did not open', { op: 'call', page: 'p999', call: { url: 'https://gemini.google.com/', method: 'POST', headers: {}, body: '', sign: 'wiz-at' } }],
		['a page value in a page it did not open', { op: 'read', page: 'p999', value: 'google-account-id' }],
		['an unknown request', { op: 'eval', code: '1' }],
	] as const) {
		const e = await rejection(raw(req, 15_000));
		// Refused by the extension's own check, not failed later for some other reason.
		const want = req.op === 'call' || req.op === 'read' ? /could not open the site/ : /not on its list of allowed sites/;
		expect(`extension refuses ${label}`, !!e && want.test(e.message), e?.message);
	}
	expect('tabs: nothing was opened for refused requests', (await tabsOn('example.com')) === 0);

	// Status: is a tab of the site open?
	expect('status: a claude.ai tab is reported open', await server.status('https://claude.ai/'));
	expect('status: no chatgpt.com tab is reported', !(await server.status('https://chatgpt.com/')));

	// A page that never becomes signed in (logged out): a skip reason, and the tab is closed.
	const g = await rejection(server.open('https://gemini.google.com/app', 'gemini-signed-in', 30_000));
	const reason = g instanceof BrowserLinkUnavailable ? g.reason : g?.message;
	expect('open: a logged-out Gemini is "not logged in", a skip', reason === 'not-logged-in', String(reason));
	await until(async () => (await tabsOn('google.com')) === 0, 5000);
	expect('tabs: the Gemini tab it opened is closed again', (await tabsOn('google.com')) === 0);

	// Obsidian quits and comes back on the same port: the extension reconnects by itself.
	await server.stop();
	await until(async () => (await stateName()) === 'plugin-closed', 10_000);
	expect('plugin closed: the options page says so', (await stateName()) === 'plugin-closed', await stateText());
	await until(async () => (await tabsOn('claude.ai')) === 0, 5000);
	expect('plugin closed: tabs the extension opened are closed', (await tabsOn('claude.ai')) === 0);
	server = new LinkServer({ store, port });
	await server.start();
	const back = await until(() => server.linked, 70_000);
	expect('reconnect: linked again within a minute, with the saved token', back && store.value === token);
	await until(async () => (await stateName()) === 'linked', 5000);
	expect('reconnect: the options page says linked again', (await stateName()) === 'linked');

	// Unpair from the extension: the plugin no longer sees a browser.
	await evalIn(optSession, `document.getElementById('unpair').click(); 'ok'`);
	await until(async () => (await stateName()) === 'not-paired', 5000);
	expect('unpair: the options page says "Not paired"', (await stateName()) === 'not-paired');
	expect('unpair: the plugin is no longer linked', await until(() => !server.linked, 5000));
	const after = await rejection(server.fetch('https://claude.ai/api/organizations', 'GET', {}));
	expect('unpair: a request now says the browser is closed', after instanceof BrowserLinkUnavailable && after.reason === 'browser-closed', after?.message);
	expect('secrets: no error message holds the token', ![org, fav, g, after].some((e) => e && token && e.message.includes(token)));
}

const watchdog = setTimeout(() => {
	console.log('FAIL  the run took longer than 5 minutes');
	failures++;
	void finish();
}, 5 * 60_000);

async function finish(): Promise<void> {
	clearTimeout(watchdog);
	await server.stop().catch(() => undefined);
	browser?.kill();
	await sleep(1500);
	rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	console.log(failures ? `${failures} extension check(s) FAILED.` : 'All extension checks passed.');
	process.exit(failures ? 1 : 0);
}

run().catch((e: unknown) => {
	console.log(`FAIL  the run stopped: ${e instanceof Error ? e.message : String(e)}`);
	failures++;
}).finally(() => void finish());
