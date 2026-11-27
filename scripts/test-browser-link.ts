// Browser link, Stage 4: the switch per account, the Browser link transport over the real link
// server (a stand-in extension plays the browser), the extension's page functions against the
// login window's page code (same requests, same answers), and Gemini / AI Studio syncs that are
// skipped, not failed, when the browser cannot be reached.
// Run: npm run test:browser-link

// As in Obsidian on a computer: a window with Node's require.
Object.assign(globalThis, { window: globalThis, require });

import WebSocket from 'ws';
import { testHooks } from 'obsidian';
import { LinkServer, type TokenStore } from '../src/link/server';
import { BrowserLinkUnavailable } from '../src/link/errors';
import { fetchFrames, fromBase64 } from '../src/link/protocol';
import { linkState, loginMethodOf, secretTokenStore, usesBrowserLink, LINK_SECRET_ID } from '../src/link/account';
import { setBrowserLink, transportFor, type PageCall } from '../src/transport';
import { pageCallCode, READY_CODE } from '../src/transport/login-window';
import { pageCall, readyCheck } from '../extension/src/page';
import { GeminiApi } from '../src/gemini/api';
import { StudioApi } from '../src/studio/api';
import { runGeminiSync } from '../src/gemini/sync';
import { runStudioSync } from '../src/studio/sync';
import { addAccount } from '../src/accounts';
import { normalizeSettings } from '../src/migrate';
import type { GeminiAccount } from '../src/settings';
import type AIChatBridge from '../src/main';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
async function rejection(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return e instanceof Error ? e : new Error(String(e));
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXT = 'chrome-extension://' + 'abcdefghijklmnopabcdefghijklmnop';
const memStore = (): TokenStore & { value: string | null } => ({ value: null, get() { return this.value; }, set(t) { this.value = t; } });
type Msg = Record<string, unknown> & { id?: number; op?: string };

/** A stand-in extension: pairs with `code`, then `answer` plays the browser. */
async function browser(port: number, code: string, answer: (m: Msg) => unknown[]): Promise<{ ws: WebSocket; seen: Msg[] }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXT });
	const seen: Msg[] = [];
	await new Promise<void>((resolve, reject) => {
		ws.on('open', () => ws.send(JSON.stringify({ op: 'pair', code })));
		ws.once('message', () => resolve());
		ws.on('error', reject);
	});
	ws.on('message', (raw) => {
		const m = JSON.parse(String(raw)) as Msg;
		if (m.id === undefined) return;
		seen.push(m);
		for (const f of answer(m)) ws.send(JSON.stringify(f));
	});
	return { ws, seen };
}

/** A batchexecute reply around one payload, the way Google frames it. */
function geminiReply(rpcId: string, payload: unknown): string {
	const row = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic'], ['di', 109], ['af.httprm', 109, '1', 4]]);
	return `)]}'\n\n${row.length}\n${row}\n25\n[["e",4,null,null,740]]\n`;
}

// ---- 1. Which accounts use the link ---------------------------------------------------------

function testSwitch() {
	const gemini = (loginMethod?: 'window' | 'browser') => ({ web: { loginMethod } });
	expect('setting: a Google account without a choice uses the login window', loginMethodOf('gemini', gemini()) === 'window');
	expect('setting: a Google account set to the Browser link uses it', usesBrowserLink('gemini', gemini('browser')));
	expect('setting: Claude, ChatGPT and Lumo cannot use it yet', !usesBrowserLink('claude', gemini('browser')) && !usesBrowserLink('chatgpt', gemini('browser')) && !usesBrowserLink('lumo', gemini('browser')));

	setBrowserLink((l) => l.provider !== 'claude' && l.id === 'linked', () => null);
	expect('switch: a linked Google account gets the Browser link', transportFor({ provider: 'gemini', id: 'linked' }).kind === 'browser-link');
	expect('switch: another Google account keeps its login window', transportFor({ provider: 'gemini', id: 'other' }).kind === 'login-window');
	expect('switch: Lumo always uses its login window', transportFor({ provider: 'lumo', id: 'linked' }).kind === 'login-window');
	setBrowserLink(() => false, () => null);
	expect('switch: nothing uses the link once the plugin says so', transportFor({ provider: 'gemini', id: 'linked' }).kind === 'login-window');

	const { settings } = normalizeSettings({ claude: [{}], gemini: [{ id: 'g1', label: 'Home', web: { loginMethod: 'browser' } }], browserLinkPort: 48213 });
	expect('settings: the login method survives a reload', settings.gemini[0]!.web.loginMethod === 'browser');
	expect('settings: the link port survives a reload', settings.browserLinkPort === 48213);
	const fresh = normalizeSettings(undefined).settings;
	expect('settings: the first Google account of a new install keeps the login window', loginMethodOf('gemini', fresh.gemini[0]!) === 'window');
	const added = addAccount(fresh, 'gemini', 'Work') as GeminiAccount;
	expect('settings: a Google account added later uses the Browser link', added.web.loginMethod === 'browser');

	const secrets = new Map<string, string>();
	const store = secretTokenStore({ getSecret: (id) => secrets.get(id) ?? null, setSecret: (id, v) => void secrets.set(id, v) });
	store.set('tok');
	expect('token: kept in secret storage under its own name', secrets.get(LINK_SECRET_ID) === 'tok' && store.get() === 'tok');
	store.set(null);
	expect('token: forgetting it leaves an empty secret, read as none', secrets.get(LINK_SECRET_ID) === '' && store.get() === null);
	expect('state: not paired / browser closed / linked', linkState(null, false) === 'not-paired' && linkState(null, true) === 'browser-closed');
}

// ---- 2. The transport over the real link server --------------------------------------------

async function testTransport() {
	const store = memStore();
	const server = new LinkServer({ store });
	const port = await server.start();
	setBrowserLink((l) => l.provider === 'gemini', () => server);
	const t = transportFor({ provider: 'gemini', id: 'g' });
	try {
		const np = await rejection(t.isLoggedIn());
		expect('not paired: says so, as a skip reason', np instanceof BrowserLinkUnavailable && np.reason === 'not-paired', np?.message);

		let mode: 'ok' | 'logged-out' = 'ok';
		const b = await browser(port, server.newPairingCode(), (m) => {
			if (m.op === 'fetch') return fetchFrames(m.id!, 200, { 'content-type': 'application/json' }, new TextEncoder().encode('{"ok":true}'));
			if (m.op === 'open') return [mode === 'ok' ? { id: m.id, ok: true, page: 'p1' } : { id: m.id, ok: false, error: { kind: 'not-logged-in', message: 'sign-in page' } }];
			if (m.op === 'call') return [{ id: m.id, ok: true, answer: { status: 200, text: geminiReply('MaZiqc', [null, null, [['c_0123abcd', 'A chat', null, null, null, [1735689600, 0]]]]), headers: { 'content-type': 'application/json' } } }];
			if (m.op === 'close') return [{ id: m.id, ok: true }];
			return [];
		});
		await sleep(50);
		expect('linked: the account counts as ready', await t.isLoggedIn());

		const r = await t.request({ url: 'https://gemini.google.com/x', method: 'POST', headers: { Cookie: 'a=b', 'User-Agent': 'u', Accept: 'application/json' }, contentType: 'application/json', body: '{}', loginOnly: ['Cookie', 'User-Agent'] });
		const sent = b.seen.find((m) => m.op === 'fetch')!;
		const h = sent.headers as Record<string, string>;
		expect('request: login-window-only headers are not sent to the browser', !('Cookie' in h) && !('User-Agent' in h) && h.Accept === 'application/json' && h['Content-Type'] === 'application/json');
		expect('request: the body reaches the browser', new TextDecoder().decode(fromBase64(sent.body64 as string)) === '{}');
		expect('request: status, headers, text and JSON come back', r.status === 200 && r.headers['content-type'] === 'application/json' && r.text === '{"ok":true}' && (r.json as { ok: boolean }).ok && r.arrayBuffer.byteLength === 11);

		const api = await GeminiApi.connect({ provider: 'gemini', id: 'g' });
		const open = b.seen.find((m) => m.op === 'open')!;
		expect('Gemini: opens gemini.google.com with the named ready check', open.url === 'https://gemini.google.com/app' && open.ready === 'gemini-signed-in');
		const items = await api.listChats(async () => undefined, () => undefined);
		const call = b.seen.find((m) => m.op === 'call')!.call as PageCall;
		expect('Gemini: the list call goes to the browser to be signed there', call.sign === 'wiz-at' && call.url.startsWith('https://gemini.google.com/_/BardChatUi/data/batchexecute'));
		expect('Gemini: the chat list comes back through the link', items.length >= 1 && items.some((i) => i.uuid === 'c_0123abcd'), JSON.stringify(items.map((i) => i.uuid)));
		api.close();
		await sleep(50);
		expect('Gemini: closing the API closes the browser tab', b.seen.some((m) => m.op === 'close' && m.page === 'p1'));

		mode = 'logged-out';
		const lo = await rejection(GeminiApi.connect({ provider: 'gemini', id: 'g' }));
		expect('not logged in to Gemini in the browser: a skip, named', lo instanceof BrowserLinkUnavailable && lo.reason === 'not-logged-in' && /Gemini in your browser/.test(lo.message), lo?.message);
		const los = await rejection(StudioApi.connect({ provider: 'gemini', id: 'g' }));
		expect('not logged in to AI Studio in the browser: a skip, named', los instanceof BrowserLinkUnavailable && /AI Studio in your browser/.test(los?.message ?? ''), los?.message);

		b.ws.close();
		await sleep(100);
		const bc = await rejection(t.isLoggedIn());
		expect('browser closed: says so, as a skip reason', bc instanceof BrowserLinkUnavailable && bc.reason === 'browser-closed', bc?.message);
		expect('state: closed browser after pairing', linkState(server, server.paired) === 'browser-closed');
	} finally {
		setBrowserLink(() => false, () => null);
		await server.stop();
	}
}

// ---- 3. The extension's page functions do what the login window's page code does ----------

type Sent = { url: string; init: RequestInit };
async function inPage<R>(page: Record<string, unknown>, run: () => Promise<R>): Promise<{ result: R; sent: Sent[] }> {
	const g = globalThis as unknown as Record<string, unknown>;
	const keep = { location: g.location, document: g.document, fetch: g.fetch, WIZ_global_data: g.WIZ_global_data };
	const sent: Sent[] = [];
	Object.assign(g, page, {
		fetch: async (url: string, init: RequestInit) => { sent.push({ url: String(url), init }); return new Response(')]}\'\nanswer', { status: 200, headers: { 'content-type': 'application/json' } }); },
	});
	try {
		return { result: await run(), sent };
	} finally {
		for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete g[k]; else g[k] = v; }
	}
}
const evalCode = (code: string) => async () => JSON.parse(String(await (0, eval)(code))) as { status: number; text: string; headers?: Record<string, string> };
const plain = (s: Sent) => ({ url: s.url, method: s.init.method, credentials: s.init.credentials, headers: s.init.headers, body: String(s.init.body) });

async function testSamePage() {
	const gLoc = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };
	const gemini = { location: gLoc, WIZ_global_data: { SNlM0e: 'AT-TOKEN', cfb2h: 'BL-1', FdrFJe: 'SID-2' } };
	const call: PageCall = { url: '/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp&hl=en&rt=c', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' }, body: 'f.req=%5B%5D', sign: 'wiz-at' };
	const viaWindow = await inPage(gemini, evalCode(pageCallCode(call)));
	const viaLink = await inPage(gemini, () => pageCall(call));
	expect('same page (Gemini): the extension sends exactly what the login window sends', JSON.stringify(viaLink.sent.map(plain)) === JSON.stringify(viaWindow.sent.map(plain)), JSON.stringify(viaLink.sent.map(plain)));
	expect('same page (Gemini): same answer back', JSON.stringify(viaLink.result) === JSON.stringify(viaWindow.result));
	const noLogin = await inPage({ location: gLoc, WIZ_global_data: {} }, () => pageCall(call));
	expect('same page (Gemini): no login in the page = 401, nothing sent', noLogin.result.status === 401 && noLogin.sent.length === 0);

	const sLoc = { href: 'https://aistudio.google.com/library', origin: 'https://aistudio.google.com' };
	const key = 'AIza' + 'B'.repeat(35);
	const studio = { location: sLoc, document: { cookie: 'a=1; SAPISID=sid-value; b=2', documentElement: { innerHTML: `x "WIu0Nc":"${key}" y` } } };
	const sCall: PageCall = { url: 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts', method: 'POST', headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-AuthUser': '0' }, body: '[100]', sign: 'sapisidhash' };
	const realNow = Date.now;
	Date.now = () => 1_764_000_000_000;
	try {
		const w = await inPage(studio, evalCode(pageCallCode(sCall)));
		const l = await inPage(studio, () => pageCall(sCall));
		expect('same page (AI Studio): the extension sends exactly what the login window sends', JSON.stringify(l.sent.map(plain)) === JSON.stringify(w.sent.map(plain)), JSON.stringify(l.sent.map(plain)));
		expect('same page (AI Studio): same answer back', JSON.stringify(l.result) === JSON.stringify(w.result));
	} finally {
		Date.now = realNow;
	}

	for (const [name, page, want] of [
		['gemini-signed-in', gemini, true],
		['gemini-signed-in', { location: gLoc, WIZ_global_data: {} }, false],
		['studio-ready', studio, true],
		['studio-ready', { ...studio, document: { ...studio.document, cookie: 'a=1' } }, false],
		['studio-ready', { ...studio, location: { href: 'https://accounts.google.com/', origin: 'https://accounts.google.com' } }, false],
	] as const) {
		const viaWindow = await inPage(page as Record<string, unknown>, async () => (0, eval)(READY_CODE[name]) as boolean);
		const viaLink = await inPage(page as Record<string, unknown>, async () => readyCheck(name));
		expect(`same ready check (${name}, ${want ? 'ready' : 'not ready'}): extension and login window agree`, !!viaWindow.result === want && viaLink.result === want);
	}
}

// ---- 4. A sync that cannot reach the browser is skipped, not failed ------------------------

async function testSkip() {
	const account = normalizeSettings({ claude: [{}], gemini: [{ id: 'g1', label: 'Home', web: { loginMethod: 'browser', folder: 'AI chats/Gemini' } }] }).settings.gemini[0]!;
	const settings = normalizeSettings({ claude: [{}] }).settings;
	settings.gemini = [account];
	settings.delaySeconds = 0;
	const logged: string[] = [];
	const plugin = { app: { secretStorage: { getSecret: () => null }, vault: { adapter: {} } }, settings } as unknown as AIChatBridge;
	testHooks.requestUrl = async () => { throw new Error('no network in this test'); };
	const realError = console.error;
	console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
	const store = memStore();
	const server = new LinkServer({ store });
	await server.start();
	setBrowserLink((l) => l.provider === 'gemini' && l.id === 'g1', () => server);
	try {
		const g = await runGeminiSync(plugin, account);
		expect('skip (Gemini, not paired): reported as skipped, not stopped', !!g.linkSkipped && !g.stopped && /not paired/.test(g.linkSkipped), g.linkSkipped ?? g.stopped);
		expect('skip (Gemini): nothing written', g.written.length === 0 && g.newCount === 0);
		const s = await runStudioSync(plugin, account);
		expect('skip (AI Studio, not paired): reported as skipped, not stopped', !!s.linkSkipped && !s.stopped, s.linkSkipped ?? s.stopped);

		store.set('a-token'); // paired earlier, browser not running now
		const closed = await runGeminiSync(plugin, account);
		expect('skip (browser closed): says to open the browser', !!closed.linkSkipped && /browser is closed/.test(closed.linkSkipped) && !closed.stopped, closed.linkSkipped);
		expect('secrets: no skip message holds the token', ![g, s, closed].some((r) => (r.linkSkipped ?? '').includes('a-token')));
	} finally {
		console.error = realError;
		testHooks.requestUrl = null;
		setBrowserLink(() => false, () => null);
		await server.stop();
	}
}

async function main() {
	testSwitch();
	await testTransport();
	await testSamePage();
	await testSkip();
	console.log(failures ? `${failures} Browser link check(s) FAILED.` : 'All Browser link checks passed.');
	process.exit(failures ? 1 : 0);
}
void main();
