// Browser link extension in Firefox, end to end: extension/dist-firefox installed as a temporary
// add-on in a real Firefox with a fresh, logged-out throwaway profile (driven through WebDriver
// BiDi, built into Firefox), talking to the plugin's real link server. The pairing code is typed
// into the options page like a person would. Logged out, the sites answer "not logged in"; this
// proves the mechanics, not the logins. Needs Firefox 138+ and internet, so not part of test:ci.
//
//   npm run test:extension-firefox            (FIREFOX=<path to firefox.exe> if it is elsewhere)

// As in Obsidian on a computer: a window with Node's require.
Object.assign(globalThis, { window: globalThis, require });

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
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

const firefox = [process.env.FIREFOX, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe', '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox']
	.find((p): p is string => !!p && existsSync(p));
if (!firefox) {
	console.log('NOT RUN  No Firefox found. Set FIREFOX to the Firefox binary and run again.');
	process.exit(1);
}
const extDir = resolve(__dirname, '..', 'extension', 'dist-firefox');
const ADDON_ID = 'ai-chatbridge-browser-link@sundowna';
const uuid = randomUUID();

// ---- Firefox over WebDriver BiDi ------------------------------------------------------------

let browser: ChildProcess | undefined;
let bidi: WebSocket;
let nextId = 1;
const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: string; message?: string }) => void>();
function send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown>; error?: string; message?: string }> {
	return new Promise((r) => {
		const id = nextId++;
		waiting.set(id, r);
		bidi.send(JSON.stringify({ id, method, params }));
	});
}

async function startFirefox(profile: string): Promise<void> {
	// The add-on gets a known internal address, so the test can open its options page.
	writeFileSync(join(profile, 'user.js'), [
		`user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: uuid }))});`,
		'user_pref("browser.shell.checkDefaultBrowser", false);',
		'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
		'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
		'user_pref("browser.aboutwelcome.enabled", false);',
	].join('\n'));
	browser = spawn(firefox!, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port=0', 'about:blank'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		// Lets the remote protocol act on extension pages; this throwaway Firefox only.
		env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
	});
	const url = await new Promise<string>((res, rej) => {
		let buf = '';
		const look = (d: Buffer) => {
			buf += d.toString();
			const m = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(buf);
			if (m) res(m[1]!);
		};
		browser!.stdout!.on('data', look);
		browser!.stderr!.on('data', look);
		browser!.on('exit', () => rej(new Error('Firefox exited early')));
		setTimeout(() => rej(new Error('Firefox did not start its remote protocol in 60 s')), 60_000);
	});
	bidi = new WebSocket(`${url}/session`);
	await new Promise<void>((res, rej) => { bidi.on('open', () => res()); bidi.on('error', rej); });
	bidi.on('message', (raw) => {
		const m = JSON.parse(String(raw)) as { id?: number };
		if (m.id && waiting.has(m.id)) {
			waiting.get(m.id)!(m as never);
			waiting.delete(m.id);
		}
	});
	const s = await send('session.new', { capabilities: {} });
	if (s.error) throw new Error(`session.new: ${s.message}`);
}

async function evalIn(context: string, expression: string): Promise<unknown> {
	const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
	const v = (r.result as { result?: { value?: unknown } } | undefined)?.result?.value;
	return v;
}

/** Addresses of the open tabs. */
async function tabUrls(): Promise<string[]> {
	const r = await send('browsingContext.getTree', {});
	return ((r.result?.contexts ?? []) as { url: string }[]).map((c) => c.url);
}
const tabsOn = async (host: string) => (await tabUrls()).filter((u) => u.includes(host)).length;

// ---- the run --------------------------------------------------------------------------------

const store: TokenStore & { value: string | null } = { value: null, get() { return this.value; }, set(t) { this.value = t; } };
const profile = mkdtempSync(join(tmpdir(), 'chatbridge-ff-test-'));
let server = new LinkServer({ store });

async function run(): Promise<void> {
	const port = await server.start();
	await startFirefox(profile);

	const inst = await send('webExtension.install', { extensionData: { type: 'path', path: extDir } });
	expect('install: the Firefox build installs as a temporary add-on', !inst.error && (inst.result as { extension?: string } | undefined)?.extension === ADDON_ID, inst.message ?? '');
	if (inst.error) return;

	// The extension opens its options page itself after installing (Firefox's remote protocol
	// may not navigate a tab to an extension page).
	let tab = '';
	await until(async () => {
		const r = await send('browsingContext.getTree', {});
		const opt = ((r.result?.contexts ?? []) as { context: string; url: string }[]).find((c) => c.url.startsWith('moz-extension://') && c.url.endsWith('/options.html'));
		tab = opt?.context ?? '';
		return !!tab;
	}, 15_000);
	expect('install: the options page opens by itself', !!tab, JSON.stringify(await tabUrls()));
	if (!tab) return;
	// Firefox's remote protocol runs no scripts in extension pages, so the test types like a
	// person: the code field has the focus when the page opens, and Enter pairs.
	await send('browsingContext.activate', { context: tab });
	await sleep(1000);
	const keys = (text: string) => [...text].flatMap((ch) => [{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }]);
	const type = (text: string) => send('input.performActions', { context: tab, actions: [{ type: 'key', id: 'kb', actions: keys(text) }] });
	const ENTER = '';
	const TAB = '';
	await type('hello' + ENTER);
	await sleep(1000);
	expect('pairing: a malformed code reaches nothing', !server.paired && !server.linked);
	const code = server.newPairingCode();
	// Clear the field (select all, delete), type the code, Enter.
	await send('input.performActions', { context: tab, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: '' }, { type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '' }, { type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }] }] });
	const typed = await type(code + ENTER);
	if (process.env.DEBUG_FF) {
		console.log('TYPE', JSON.stringify(typed).slice(0, 300));
		await sleep(3000);
		const shot = await send('browsingContext.captureScreenshot', { context: tab });
		const data = (shot.result as { data?: string } | undefined)?.data;
		if (data) writeFileSync(process.env.DEBUG_FF, Buffer.from(data, 'base64'));
		console.log('SHOT', data ? 'saved' : JSON.stringify(shot).slice(0, 300));
	}
	expect('pairing: the code from the plugin, typed in the options page, links Firefox', await until(() => server.linked && server.paired, 15_000));
	const token = store.value;

	// Obsidian's "Open in browser": the local page turns into the extension's page.
	const op = (await send('browsingContext.create', { type: 'tab' })).result!.context as string;
	await send('browsingContext.navigate', { context: op, url: `http://127.0.0.1:${port}/chatbridge-browser-link` });
	const turned = await until(async () => {
		const r = await send('browsingContext.getTree', {});
		return ((r.result?.contexts ?? []) as { context: string; url: string }[]).some((c) => c.context === op && c.url.startsWith('moz-extension://') && c.url.endsWith('/options.html'));
	}, 10_000);
	expect("open in browser: the local page becomes the extension's page in the same tab", turned, JSON.stringify(await tabUrls()));
	await send('browsingContext.close', { context: op });

	const page = (await send('browsingContext.create', { type: 'tab' })).result!.context as string;
	const probe = await evalIn(page, `new Promise((r) => { const s = new WebSocket('ws://127.0.0.1:${port}'); s.onopen = () => s.send(JSON.stringify({op:'hello', token:'guess'})); s.onclose = (e) => r('closed ' + e.code); setTimeout(() => r('still open'), 4000); })`);
	expect('security: a web page cannot use the port', probe !== 'still open', String(probe));
	await send('browsingContext.close', { context: page });

	expect('tabs: no claude.ai tab before the first request', (await tabsOn('claude.ai')) === 0);
	const org = await rejection(server.fetch('https://claude.ai/api/organizations', 'GET', { Accept: 'application/json' }).then((r) => {
		expect('fetch: claude.ai answers through Firefox', r.status > 0, `status ${r.status}, ${r.body.length} bytes`);
	}));
	expect('fetch: no error', !org, org?.message);
	expect('tabs: the extension opened one background claude.ai tab', (await tabsOn('claude.ai')) === 1);
	const fav = await rejection(server.fetch('https://claude.ai/favicon.ico', 'GET', {}).then(async (r) => {
		const direct = new Uint8Array(await (await fetch('https://claude.ai/favicon.ico')).arrayBuffer());
		expect('fetch: a binary answer arrives byte for byte', r.status === 200 && direct.length === r.body.length && direct.every((b, i) => b === r.body[i]), `${r.body.length} vs ${direct.length} bytes`);
	}));
	expect('fetch: binary request had no error', !fav, fav?.message);

	const raw = (server as unknown as { send(req: unknown, ms: number): Promise<unknown> }).send.bind(server);
	for (const [label, req] of [
		['a fetch to another site', { op: 'fetch', url: 'https://example.com/', method: 'GET', headers: {} }],
		['opening another site', { op: 'open', url: 'https://example.com/', ready: 'loaded', timeoutMs: 5000 }],
		['a site value on the wrong site', { op: 'read', site: 'https://chatgpt.com/', value: 'claude-org' }],
		['an unknown request', { op: 'eval', code: '1' }],
	] as const) {
		const e = await rejection(raw(req, 15_000));
		expect(`extension refuses ${label}`, !!e && /not on its list of allowed sites/.test(e.message), e?.message);
	}

	const g = await rejection(server.open('https://gemini.google.com/app', 'gemini-signed-in', 30_000));
	expect('open: a logged-out Gemini is "not logged in", a skip', g instanceof BrowserLinkUnavailable && g.reason === 'not-logged-in', g instanceof BrowserLinkUnavailable ? g.reason : g?.message);
	await until(async () => (await tabsOn('gemini.google.com')) === 0, 5000);
	expect('tabs: the Gemini tab it opened is closed again', (await tabsOn('gemini.google.com')) === 0);

	await server.stop();
	await until(async () => (await tabsOn('claude.ai')) === 0, 5000);
	expect('plugin closed: tabs the extension opened are closed', (await tabsOn('claude.ai')) === 0);
	server = new LinkServer({ store, port });
	await server.start();
	expect('reconnect: linked again within 70 s, with the saved token (Firefox suspends idle backgrounds)', await until(() => server.linked, 70_000) && store.value === token);

	// Unpair from the options page: from the code field, Tab to Pair, Tab to Unpair, Enter.
	await send('browsingContext.activate', { context: tab });
	await send('browsingContext.reload', { context: tab, wait: 'complete' });
	await sleep(1000);
	await type(TAB + TAB + ENTER);
	expect('unpair: the plugin is no longer linked', await until(() => !server.linked, 10_000));
}

const watchdog = setTimeout(() => {
	console.log('FAIL  the run took longer than 5 minutes');
	failures++;
	void finish();
}, 5 * 60_000);

async function finish(): Promise<void> {
	clearTimeout(watchdog);
	await server.stop().catch(() => undefined);
	try { bidi?.close(); } catch { /* gone */ }
	browser?.kill();
	await sleep(2000);
	rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	console.log(failures ? `${failures} Firefox extension check(s) FAILED.` : 'All Firefox extension checks passed.');
	process.exit(failures ? 1 : 0);
}

run().catch((e: unknown) => {
	console.log(`FAIL  the run stopped: ${e instanceof Error ? e.message : String(e)}`);
	failures++;
}).finally(() => void finish());
