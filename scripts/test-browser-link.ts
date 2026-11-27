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
import { browserKind, isMadeUpBrowserName, kindName, linkState, loginMethodOf, pairButtonText, pickBrowser, readTokens, unpairForgetsAll, secretTokenStore, usesBrowserLink, writeTokens, LINK_SECRET_ID } from '../src/link/account';
import { BrowserLinkTransport } from '../src/transport/browser-link';
import { setBrowserLink, transportFor, type PageCall } from '../src/transport';
import { pageCallCode, READ_CODE, READY_CODE, SITE_VALUE_COOKIE } from '../src/transport/login-window';
import type { SiteValue } from '../src/transport';
import { BROWSER_LINK_KEY, claudeAuth } from '../src/claude-auth';
import { ACCOUNT, ClaudeApi } from '../src/api';
import { GptApi } from '../src/chatgpt/api';
import { runSync } from '../src/sync';
import { runGptSync } from '../src/chatgpt/sync';
import { asFirefoxHeaders, isGoogleSignIn, openLogin } from '../src/login';
import { isLinkOpenPage, LINK_OPEN_PATH } from '../src/link/sites';
import { pageCall, pageRead, readyCheck } from '../extension/src/page';
import { GeminiApi, geminiBase } from '../src/gemini/api';
import { checkLogin, forgetLogin } from '../src/login-check';
import { StopError } from '../src/api';
import { StudioApi } from '../src/studio/api';
import { runGeminiSync } from '../src/gemini/sync';
import { runStudioSync } from '../src/studio/sync';
import { addAccount } from '../src/accounts';
import { netRetry } from '../src/net-retry';
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
async function browser(port: number, code: string, answer: (m: Msg) => unknown[]): Promise<{ ws: WebSocket; seen: Msg[]; answer: (m: Msg) => unknown[] }> {
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
	return { ws, seen, answer };
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
	expect('setting: Claude and ChatGPT accounts can use it too', usesBrowserLink('claude', gemini('browser')) && usesBrowserLink('chatgpt', gemini('browser')));
	expect('setting: Lumo never uses it', !usesBrowserLink('lumo', gemini('browser')));
	expect('setting: Claude and ChatGPT accounts without a choice keep the login window', loginMethodOf('claude', gemini()) === 'window' && loginMethodOf('chatgpt', gemini()) === 'window');

	setBrowserLink((l) => l.provider !== 'claude' && l.id === 'linked', () => null);
	expect('switch: a linked Google account gets the Browser link', transportFor({ provider: 'gemini', id: 'linked' }).kind === 'browser-link');
	expect('switch: another Google account keeps its login window', transportFor({ provider: 'gemini', id: 'other' }).kind === 'login-window');
	expect('switch: Lumo always uses its login window', transportFor({ provider: 'lumo', id: 'linked' }).kind === 'login-window');
	expect('switch: a linked ChatGPT account gets the Browser link', transportFor({ provider: 'chatgpt', id: 'linked' }).kind === 'browser-link');
	expect('switch: Claude follows what the plugin says (here: no)', transportFor({ provider: 'claude', id: 'linked' }).kind === 'login-window');
	setBrowserLink(() => false, () => null);
	expect('switch: nothing uses the link once the plugin says so', transportFor({ provider: 'gemini', id: 'linked' }).kind === 'login-window');

	const { settings } = normalizeSettings({ claude: [{}], gemini: [{ id: 'g1', label: 'Home', web: { loginMethod: 'browser' } }], browserLinkPort: 48213 });
	expect('settings: the login method survives a reload', settings.gemini[0]!.web.loginMethod === 'browser');
	expect('settings: the link port survives a reload', settings.browserLinkPort === 48213);
	const fresh = normalizeSettings(undefined).settings;
	expect('settings: the first Google account of a new install keeps the login window', loginMethodOf('gemini', fresh.gemini[0]!) === 'window');
	const added = addAccount(fresh, 'gemini', 'Work') as GeminiAccount;
	expect('settings: a Google account added later uses the Browser link', added.web.loginMethod === 'browser');
	const claudeAdded = addAccount(fresh, 'claude', 'Work') as { web: { loginMethod?: string } };
	expect('settings: a Claude account added later keeps the login window (the Browser link is offered)', claudeAdded.web.loginMethod === undefined);
	const kept = normalizeSettings({ claude: [{ id: 'c1', label: 'Home', web: { loginMethod: 'browser' } }], chatgpt: [{ id: 'o1', label: 'Home', web: { loginMethod: 'browser' } }] }).settings;
	expect('settings: the Claude and ChatGPT login method survives a reload', kept.claude[0]!.web.loginMethod === 'browser' && kept.chatgpt[0]!.web.loginMethod === 'browser');

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

		let mode: 'ok' | 'logged-out' | 'close-on-call' = 'ok';
		const b = await browser(port, server.newPairingCode(), (m) => {
			if (m.op === 'fetch') return fetchFrames(m.id!, 200, { 'content-type': 'application/json' }, new TextEncoder().encode('{"ok":true}'));
			if (m.op === 'open') return [mode === 'ok' ? { id: m.id, ok: true, page: 'p1' } : { id: m.id, ok: false, error: { kind: 'not-logged-in', message: 'sign-in page' } }];
			if (m.op === 'call' && mode === 'close-on-call') {
				b.ws.close();
				return [];
			}
			if (m.op === 'call') return [{ id: m.id, ok: true, answer: { status: 200, text: geminiReply('MaZiqc', [null, null, [['c_0123abcd', 'A chat', null, null, null, [1735689600, 0]]]]), headers: { 'content-type': 'application/json' } } }];
			if (m.op === 'read') return [{ id: m.id, ok: true, value: m.value === 'google-account-id' ? '123456789012345678901' : '' }];
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
		expect('Gemini: the Google account number is read from the page by name', (await api.accountId()) === '123456789012345678901' && b.seen.some((m) => m.op === 'read' && m.page === 'p1' && m.value === 'google-account-id'));
		const items = await api.listChats(async () => undefined, () => undefined);
		const call = b.seen.find((m) => m.op === 'call')!.call as PageCall;
		expect('Gemini: the list call goes to the browser to be signed there', call.sign === 'wiz-at' && call.url.startsWith('https://gemini.google.com/_/BardChatUi/data/batchexecute'));
		expect('Gemini: the chat list comes back through the link', items.length >= 1 && items.some((i) => i.uuid === 'c_0123abcd'), JSON.stringify(items.map((i) => i.uuid)));
		api.close();
		await sleep(50);
		expect('Gemini: closing the API closes the browser tab', b.seen.some((m) => m.op === 'close' && m.page === 'p1'));

		// The browser goes away in the middle of a sync: after the network retries, still a skip.
		const mid = await GeminiApi.connect({ provider: 'gemini', id: 'g' });
		mode = 'close-on-call';
		const realPause = netRetry.pause;
		netRetry.pause = async () => undefined;
		const gone = await rejection(mid.listChats(async () => undefined, () => undefined));
		netRetry.pause = realPause;
		expect('browser closed mid-sync: a skip (browser closed), not a network error', gone instanceof BrowserLinkUnavailable && gone.reason === 'browser-closed', gone?.message);
		mid.close();
		const back = await browser(port, server.newPairingCode(), b.answer);
		b.ws = back.ws;
		b.seen = back.seen;
		await sleep(50);
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

	for (const [label, page, want] of [['signed in', { WIZ_global_data: { S06Grb: '123456789012345678901' } }, '123456789012345678901'], ['no number', { WIZ_global_data: {} }, ''], ['no page data', {}, '']] as const) {
		const viaWindow = await inPage(page as Record<string, unknown>, async () => String((0, eval)(READ_CODE['google-account-id'])));
		const viaLink = await inPage(page as Record<string, unknown>, async () => pageRead('google-account-id'));
		expect(`same page value (Google account number, ${label}): extension and login window agree`, viaWindow.result === want && viaLink.result === want, `${viaWindow.result} / ${viaLink.result}`);
	}

	for (const [value, cookie] of Object.entries(SITE_VALUE_COOKIE) as [SiteValue, string][]) {
		const page = { document: { cookie: `a=1; ${cookie}=v-${value}; b=2` } };
		const got = await inPage(page, async () => pageRead(value));
		expect(`same site value (${value}): the extension reads the cookie the login window reads (${cookie})`, got.result === `v-${value}`);
		const none = await inPage({ document: { cookie: 'a=1' } }, async () => pageRead(value));
		expect(`same site value (${value}): none there = empty`, none.result === '');
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

// ---- 5. Claude and ChatGPT through the link -------------------------------------------------

const ORG = '11111111-2222-4333-8444-555555555555';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoid3MtMSJ9fQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU';

async function testClaudeAndGpt() {
	const store = memStore();
	const server = new LinkServer({ store });
	const port = await server.start();
	const fake = (provider: 'claude' | 'chatgpt', web: Record<string, unknown>) => {
		const settings = normalizeSettings({ [provider]: [{ id: 'x1', label: 'Home', web: { loginMethod: 'browser', ...web } }] }).settings;
		settings.delaySeconds = 0;
		const plugin = { app: { secretStorage: { getSecret: () => null }, vault: { adapter: {} } }, settings, saveSettings: async () => undefined } as unknown as AIChatBridge;
		return { plugin, account: (provider === 'claude' ? settings.claude[0] : settings.chatgpt[0])! };
	};
	setBrowserLink((l) => l.provider === 'claude' || l.provider === 'chatgpt', () => server);
	const realError = console.error;
	console.error = () => undefined;
	testHooks.requestUrl = async () => { throw new Error('requestUrl was called directly, not through the link'); };
	try {
		// Not paired: both are skipped, not stopped.
		const c0 = fake('claude', {});
		const r0 = await runSync(c0.plugin, c0.account as never);
		expect('Claude, not paired: skipped, not stopped', !!r0.linkSkipped && !r0.stopped && /not paired/.test(r0.linkSkipped), r0.linkSkipped ?? r0.stopped);
		const g0 = fake('chatgpt', { folder: 'AI chats/ChatGPT' });
		const s0 = await runGptSync(g0.plugin, g0.account as never);
		expect('ChatGPT, not paired: skipped, not stopped', !!s0.linkSkipped && !s0.stopped && /not paired/.test(s0.linkSkipped), s0.linkSkipped ?? s0.stopped);

		let claudeOrg = ORG;
		let gptHtml = `<script>window.__x={"accessToken":"${JWT}"}</script>`;
		const b = await browser(port, server.newPairingCode(), (m) => {
			if (m.op === 'read' && m.site) {
				const v = m.value === 'claude-org' ? claudeOrg : m.value === 'chatgpt-device-id' ? 'device-123' : m.value === 'chatgpt-workspace' ? 'ws-1' : '';
				return [{ id: m.id, ok: true, value: v }];
			}
			if (m.op === 'fetch') {
				const url = String(m.url);
				const body = url === 'https://chatgpt.com/' ? gptHtml : url.includes('/backend-api/conversations') ? '{"items":[],"total":0,"limit":20,"offset":0}' : '[]';
				return fetchFrames(m.id!, 200, { 'content-type': url === 'https://chatgpt.com/' ? 'text/html' : 'application/json' }, new TextEncoder().encode(body));
			}
			return [];
		});
		await sleep(50);

		// Claude: organization from the browser, requests without the login window's cookie.
		const c1 = fake('claude', {});
		const auth = await claudeAuth(c1.plugin, c1.account as never);
		expect('Claude: the organization is read from the browser', auth.orgId === ORG && (c1.account.web as { orgId?: string }).orgId === ORG && !auth.linkProblem);
		expect('Claude: no session key is read; the browser sends its own', auth.source === 'browser link' && auth.getKey() === BROWSER_LINK_KEY);
		const api = new ClaudeApi(auth.orgId, auth.getKey, { provider: 'claude', accountId: 'x1' }, auth.transport);
		await api.get(api.listPath(0));
		const sent = b.seen.filter((m) => m.op === 'fetch').pop()!;
		const h = sent.headers as Record<string, string>;
		expect('Claude: the chat list goes through the browser', String(sent.url).startsWith(`https://claude.ai/api/organizations/${ORG}/`), String(sent.url));
		expect('Claude: no Cookie header leaves the plugin', !Object.keys(h).some((k) => k.toLowerCase() === 'cookie') && !JSON.stringify(h).includes(BROWSER_LINK_KEY));
		// The login check asks who is signed in; the request guard must let that one address through (0.54.0 stopped every Claude account).
		const who = await rejection(api.get(ACCOUNT));
		expect('Claude: the login check may ask who is signed in', !who && String(b.seen.filter((m) => m.op === 'fetch').pop()!.url) === 'https://claude.ai/api/account', who?.message);
		expect('Claude: other account addresses stay blocked', !!(await rejection(api.get('/api/account/settings'))) && !!(await rejection(api.get(`${ACCOUNT}?x=1`))));
		claudeOrg = '';
		const c2 = fake('claude', {});
		const r2 = await runSync(c2.plugin, c2.account as never);
		expect('Claude, not logged in in the browser: skipped, named', !!r2.linkSkipped && /claude\.ai in your browser/.test(r2.linkSkipped) && !r2.stopped, r2.linkSkipped ?? r2.stopped);

		// ChatGPT: login key from the page fetched in the browser, device and workspace from the browser.
		const gpt = await GptApi.connect({ provider: 'chatgpt', id: 'x1' });
		const page = b.seen.find((m) => m.op === 'fetch' && m.url === 'https://chatgpt.com/')!;
		const ph = page.headers as Record<string, string>;
		expect('ChatGPT: the start page is fetched in the browser, without cookie or browser name', !Object.keys(ph).some((k) => /^(cookie|user-agent)$/i.test(k)) && page.redirect === 'manual', JSON.stringify(Object.keys(ph)));
		expect('ChatGPT: the device ID is read from the browser', Object.entries(ph).some(([k, v]) => k.toLowerCase() === 'oai-device-id' && v === 'device-123'), JSON.stringify(Object.keys(ph)));
		expect('ChatGPT: the workspace is read from the browser', gpt.workspaceId === 'ws-1' || b.seen.some((m) => m.op === 'read' && m.value === 'chatgpt-workspace'));
		await gpt.get(gpt.listPath(0, false));
		const list = b.seen.filter((m) => m.op === 'fetch').pop()!;
		const lh = list.headers as Record<string, string>;
		expect('ChatGPT: requests carry the login key, not the cookie or browser name', lh.Authorization === `Bearer ${JWT}` && !('Cookie' in lh) && !('User-Agent' in lh), JSON.stringify(Object.keys(lh)));
		gptHtml = '<html>logged out</html>';
		const lo = await rejection(GptApi.connect({ provider: 'chatgpt', id: 'x1' }));
		expect('ChatGPT, not logged in in the browser: a skip, named', lo instanceof BrowserLinkUnavailable && /ChatGPT in your browser/.test(lo.message), lo?.message);
		b.ws.close();
	} finally {
		console.error = realError;
		testHooks.requestUrl = null;
		setBrowserLink(() => false, () => null);
		await server.stop();
	}
}

// ---- 6. Login windows: Google mode on Google's sign-in pages ----------------------------------

async function testGoogleMode() {
	expect('Google mode: accounts.google.com is Google sign-in', isGoogleSignIn('https://accounts.google.com/v3/signin/identifier?x=1') && isGoogleSignIn('https://accounts.youtube.com/accounts/SetSID'));
	expect('Google mode: claude.ai, chatgpt.com, auth.openai.com and lookalikes are not', !['https://claude.ai/login', 'https://chatgpt.com/', 'https://auth.openai.com/log-in', 'https://accounts.google.com.evil.com/', 'http://accounts.google.com/', 'not a url'].some(isGoogleSignIn));
	const ff = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
	const h = asFirefoxHeaders({ 'User-Agent': 'Chrome', 'sec-ch-ua': 'x', 'Sec-CH-UA-Platform': 'y', Accept: 'text/html' }, ff);
	expect('Google mode: requests to Google say Firefox and carry no client hints', h['User-Agent'] === ff && h.Accept === 'text/html' && Object.keys(h).length === 2);

	// The real openLogin against a stand-in Electron.
	const filters: { urls: string[] | null; listener: (d: { requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void }[] = [];
	const sessionUA: string[] = [];
	const ses = {
		cookies: { get: async () => [], set: async () => undefined },
		clearStorageData: async () => undefined,
		setPermissionRequestHandler: () => undefined,
		setPermissionCheckHandler: () => undefined,
		setUserAgent: (ua: string) => void sessionUA.push(ua),
		getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.11.4 Chrome/142.0.0.0 Electron/39.0.0 Safari/537.36',
		webRequest: {
			onBeforeSendHeaders: (a: unknown, b?: unknown) => void filters.push(typeof a === 'function' ? { urls: null, listener: a as never } : { urls: (a as { urls: string[] }).urls, listener: b as never }),
			onSendHeaders: () => undefined,
			onCompleted: () => undefined,
		},
	};
	const pageUA: string[] = [];
	let navigate: ((e: { url?: string; isMainFrame?: boolean }, url?: string, inPlace?: boolean, main?: boolean) => void) | null = null;
	let destroyed = false;
	class FakeWin {
		webContents = {
			removeAllListeners: () => undefined,
			on: (_ev: string, l: typeof navigate) => { navigate = l; },
			setUserAgent: (ua: string) => void pageUA.push(ua),
			setWindowOpenHandler: () => undefined,
			executeJavaScript: async () => false,
		};
		loadURL = async () => undefined;
		isDestroyed = () => destroyed;
		close = () => { destroyed = true; };
		focus = () => undefined;
	}
	const g = globalThis as unknown as Record<string, unknown>;
	const keepElectron = g.electron;
	g.electron = { remote: { BrowserWindow: FakeWin, session: { fromPartition: () => ses } } };
	try {
		const done = openLogin({ provider: 'claude', id: 'gm' });
		await sleep(50);
		const plain = sessionUA[0] ?? '';
		expect('claude.ai window: keeps its own browser name (no Firefox for the site)', !!plain && !/Firefox|Electron|obsidian/.test(plain));
		const google = filters.find((f) => f.urls?.includes('https://accounts.google.com/*'));
		expect('claude.ai window: a header rule for Google sign-in pages only', !!google && filters.every((f) => f.urls !== null));
		let rewritten: Record<string, string> = {};
		google?.listener({ requestHeaders: { 'User-Agent': plain, 'sec-ch-ua': '"Chromium"' } }, (r) => { rewritten = r.requestHeaders; });
		expect('claude.ai window: requests to Google say Firefox, no client hints', /Firefox\//.test(rewritten['User-Agent'] ?? '') && !('sec-ch-ua' in rewritten));
		navigate?.({}, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', false, true);
		navigate?.({}, 'https://accounts.google.com/frame', false, false);
		navigate?.({ url: 'https://claude.ai/new', isMainFrame: true });
		expect('claude.ai window: the page says Firefox on Google, its own name back on claude.ai', pageUA.length === 2 && /Firefox\//.test(pageUA[0] ?? '') && pageUA[1] === plain, JSON.stringify(pageUA.map((u) => u.slice(-20))));
		destroyed = true;
		await done;

		filters.length = 0;
		sessionUA.length = 0;
		pageUA.length = 0;
		navigate = null;
		destroyed = false;
		const gem = openLogin({ provider: 'gemini', id: 'gm' });
		await sleep(50);
		expect('Gemini window: unchanged, Firefox everywhere for its whole storage', /Firefox\//.test(sessionUA[0] ?? '') && filters.length === 1 && filters[0]!.urls === null && navigate === null);
		destroyed = true;
		await gem;
	} finally {
		if (keepElectron === undefined) delete g.electron; else g.electron = keepElectron;
	}
}

// ---- 7. The local page behind "Open in browser" ----------------------------------------------

async function testOpenPage() {
	const { request } = await import('node:http');
	const get = (port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET') => new Promise<{ status: number; type: string; csp: string; body: string }>((resolve) => {
		const r = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
			let body = '';
			res.on('data', (d: Buffer) => { body += d.toString(); });
			res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), csp: String(res.headers['content-security-policy'] ?? ''), body }));
		});
		r.on('error', () => resolve({ status: 0, type: '', csp: '', body: '' }));
		r.end();
	});
	const server = new LinkServer({ store: memStore() });
	const port = await server.start();
	try {
		const ok = await get(port, LINK_OPEN_PATH);
		expect('open page: served at 127.0.0.1 as a plain HTML page', ok.status === 200 && ok.type.startsWith('text/html'));
		expect('open page: no browser linked yet = no script at all (strict content policy)', ok.csp.includes("default-src 'none'") && !ok.csp.includes('script-src') && !/<script/i.test(ok.body));
		const b = await browser(port, server.newPairingCode(), () => []);
		await sleep(50);
		const linked = await get(port, LINK_OPEN_PATH);
		const script = /<script>([^<]*)<\/script>/.exec(linked.body)?.[1] ?? '';
		const { createHash } = await import('node:crypto');
		const hash = createHash('sha256').update(script).digest('base64');
		expect('open page: once a Chrome extension is linked, one script asks that extension to open its page', script.includes(JSON.stringify(EXT.slice('chrome-extension://'.length))) && script.includes('open-options') && (linked.body.match(/<script/g) ?? []).length === 1, script);
		expect('open page: only that script may run (allowed by its hash)', linked.csp.includes(`script-src 'sha256-${hash}'`) && linked.csp.includes("default-src 'none'"), linked.csp);
		b.ws.close();
		expect('open page: says to keep the browser open while syncing', /Keep that browser open while Obsidian syncs/.test(ok.body));
		expect('open page: a query string is fine', (await get(port, `${LINK_OPEN_PATH}?x=1`)).status === 200);
		expect('open page: any other path is 404', (await get(port, '/')).status === 404 && (await get(port, '/chatbridge-browser-link/x')).status === 404);
		expect('open page: another host name is 404 (DNS rebinding)', (await get(port, LINK_OPEN_PATH, `evil.example:${port}`)).status === 404);
		expect('open page: only GET', (await get(port, LINK_OPEN_PATH, undefined, 'POST')).status === 404);
		expect('open page: the extension knows it on any port, http on 127.0.0.1 only', isLinkOpenPage(`http://127.0.0.1:${port}${LINK_OPEN_PATH}`) && isLinkOpenPage('http://127.0.0.1:1234/chatbridge-browser-link?a') && !isLinkOpenPage('https://127.0.0.1:1/chatbridge-browser-link') && !isLinkOpenPage('http://localhost:1/chatbridge-browser-link') && !isLinkOpenPage('http://evil.com/chatbridge-browser-link') && !isLinkOpenPage(undefined));
	} finally {
		await server.stop();
	}
}

// ---- Several browsers (personal and work in two browsers or profiles) ----------------------

/** A stand-in extension with its own browser ID: pairs (or says hello with a token) and answers. */
async function namedBrowser(port: number, first: Record<string, unknown>, answer: (m: Msg) => unknown[], userAgent?: string): Promise<{ ws: WebSocket; reply: Record<string, unknown> }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXT, ...(userAgent ? { headers: { 'User-Agent': userAgent } } : {}) });
	const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.on('open', () => ws.send(JSON.stringify(first)));
		ws.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
		ws.on('error', reject);
		ws.on('close', () => resolve({ closed: true }));
	});
	ws.on('message', (raw) => {
		const m = JSON.parse(String(raw)) as Msg;
		if (m.id === undefined) return;
		for (const f of answer(m)) ws.send(JSON.stringify(f));
	});
	return { ws, reply };
}

async function testSeveralBrowsers() {
	const store = memStore();
	const named: string[] = [];
	const kinds: string[] = [];
	const server = new LinkServer({ store, onPaired: (b) => named.push(b), onLinked: (b, k) => kinds.push(`${b}=${k ?? '?'}`) });
	const port = await server.start();
	const val = (who: string) => (m: Msg) => (m.op === 'read' ? [{ id: m.id, ok: true, value: who }] : []);
	try {
		const home = await namedBrowser(port, { op: 'pair', code: server.newPairingCode(), browser: 'personal-1' }, val('home-org'), 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
		const work = await namedBrowser(port, { op: 'pair', code: server.newPairingCode(), browser: 'work-0001' }, val('work-org'), 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0');
		await sleep(50);
		expect('several browsers: each pairs with its own ID and both stay connected', home.reply.op === 'paired' && work.reply.op === 'paired' && server.linkedBrowsers().sort().join() === 'personal-1,work-0001' && named.join() === 'personal-1,work-0001', server.linkedBrowsers().join());
		expect('several browsers: each connection says which browser it is (from its User-Agent)', kinds.join() === 'personal-1=Chrome,work-0001=Edge', kinds.join());
		expect('several browsers: each has its own saved token', Object.keys(readTokens(store.value)).sort().join() === 'personal-1,work-0001' && readTokens(store.value)['personal-1'] !== readTokens(store.value)['work-0001']);
		const toHome = await server.siteValue('https://claude.ai/', 'claude-org', 5000, 'personal-1');
		const toWork = await server.siteValue('https://claude.ai/', 'claude-org', 5000, 'work-0001');
		expect('several browsers: each request goes to the browser the account names', toHome === 'home-org' && toWork === 'work-org', `${toHome} ${toWork}`);
		home.ws.close();
		await sleep(80);
		const stillWork = await server.siteValue('https://claude.ai/', 'claude-org', 5000, 'work-0001');
		const homeGone = await rejection(server.siteValue('https://claude.ai/', 'claude-org', 5000, 'personal-1'));
		expect('several browsers: one closing does not touch the other; its own account is skipped as closed', stillWork === 'work-org' && homeGone instanceof BrowserLinkUnavailable && homeGone.reason === 'browser-closed', homeGone?.message);
		const tokenOf = (id: string) => readTokens(store.value)[id]!;
		const back = await namedBrowser(port, { op: 'hello', token: tokenOf('personal-1'), browser: 'personal-1' }, val('home-org'));
		const wrong = await namedBrowser(port, { op: 'hello', token: tokenOf('work-0001'), browser: 'personal-1' }, val('x'));
		expect('several browsers: a browser comes back with its own token; another browser\'s token is refused', back.reply.op === 'welcome' && wrong.reply.closed === true);
		server.unpair('work-0001');
		await sleep(50);
		expect('several browsers: unpairing one forgets only that one', Object.keys(readTokens(store.value)).join() === 'personal-1' && server.linkedBrowsers().join() === 'personal-1');
		const t = new BrowserLinkTransport(() => server, 'work-0001');
		const notPaired = await rejection(t.siteValue('claude-org'));
		expect('several browsers: an account whose browser was unpaired is skipped as not paired', notPaired instanceof BrowserLinkUnavailable && notPaired.reason === 'not-paired');
		back.ws.close();
	} finally {
		await server.stop();
	}

	// An older extension (one token, no ID) keeps working, and an updated one keeps its pairing.
	const old = memStore();
	old.value = 'legacy-token-value';
	const s2 = new LinkServer({ store: old });
	const p2 = await s2.start();
	try {
		const legacy = await namedBrowser(p2, { op: 'hello', token: 'legacy-token-value' }, val('legacy'));
		expect('older extension: says hello without an ID and is let in with the one saved token', legacy.reply.op === 'welcome' && s2.linkedBrowsers().join() === 'default');
		legacy.ws.close();
		await sleep(50);
		const updated = await namedBrowser(p2, { op: 'hello', token: 'legacy-token-value', browser: 'upgraded-01' }, val('u'));
		expect('updated extension: keeps the old pairing under its new ID', updated.reply.op === 'welcome' && Object.keys(readTokens(old.value)).join() === 'upgraded-01');
		updated.ws.close();
		await sleep(50);
		// Seen live 27.11.2026: one Chrome made a second ID at start-up and was refused with its own token.
		const second = await namedBrowser(p2, { op: 'hello', token: 'legacy-token-value', browser: 'second-id-02' }, val('s'));
		expect('a paired extension that sends a new ID stays the same paired browser', second.reply.op === 'welcome' && s2.linkedBrowsers().join() === 'upgraded-01' && Object.keys(readTokens(old.value)).join() === 'upgraded-01');
		second.ws.close();
		await sleep(50);
		const wrong = await namedBrowser(p2, { op: 'hello', token: 'not-the-token-value', browser: 'upgraded-01' }, val('w'));
		expect('a known ID with the wrong token is still refused', wrong.reply.op !== 'welcome' && s2.linkedBrowsers().length === 0);
		wrong.ws.close();
	} finally {
		await s2.stop();
	}
	expect('tokens: a plain older token reads as the default browser; odd saved text reads as none', readTokens('abc').default === 'abc' && Object.keys(readTokens('{"x":1')).length === 0 && writeTokens({}) === null);
}

// ---- Which login an account reads (login-check.ts), and the Google account number ----------

function testPickBrowser() {
	expect('browser names: the kind is read from the User-Agent', browserKind('… Chrome/140.0 Safari/537.36') === 'Chrome' && browserKind('… Chrome/140.0 Safari/537.36 Edg/140.0') === 'Edge' && browserKind('Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0') === 'Firefox' && browserKind('… Chrome/140 OPR/120') === 'Opera' && browserKind(undefined) === undefined);
	expect('browser names: only made-up names are replaced, never one you chose', isMadeUpBrowserName('Browser 2') && isMadeUpBrowserName(undefined) && isMadeUpBrowserName('Browser (paired before names)') && !isMadeUpBrowserName('Work') && !isMadeUpBrowserName('Chrome'));
	expect('browser names: a second browser of the same kind gets a number', kindName('Chrome', ['Edge']) === 'Chrome' && kindName('Chrome', ['Chrome', 'Chrome 2']) === 'Chrome 3');
	expect('any browser: an account\'s own browser wins', pickBrowser('edge', ['edge'], ['chrome', 'edge']) === 'edge');
	expect('any browser: a browser another account picked is passed over', pickBrowser(undefined, ['edge'], ['edge', 'chrome']) === 'chrome');
	expect('any browser: when every connected browser is picked, any one will do', pickBrowser(undefined, ['edge'], ['edge']) === undefined);
	expect('pairing: a linked account offers to pair another browser (no unpair needed)', pairButtonText('linked') === 'Pair another browser…' && pairButtonText('not-paired') === 'Pair browser…' && pairButtonText('browser-closed') === 'Pair again…');
	expect('unpair: without its own browser and with several paired, it would forget all, so it asks first', unpairForgetsAll(undefined, 2) && !unpairForgetsAll(undefined, 1) && !unpairForgetsAll('edge', 2));
}

function testLoginCheck() {
	const bound: { loginUser?: string; loginEmail?: string } = {};
	expect('login check: the first login is remembered', checkLogin('claude.ai', bound, { id: 'u-home', email: 'me@home.example' }, [], true) && bound.loginUser === 'u-home' && bound.loginEmail === 'me@home.example');
	expect('login check: the same login again changes nothing', checkLogin('claude.ai', bound, { id: 'u-home', email: 'me@home.example' }, [], true) === false);
	let skipped: unknown = null;
	try { checkLogin('claude.ai', bound, { id: 'u-work', email: 'me@work.example' }, [], true); } catch (e) { skipped = e; }
	expect('login check: another login in the browser is skipped, naming who is logged in and who is expected', skipped instanceof BrowserLinkUnavailable && skipped.reason === 'other-login' && skipped.message.includes('me@work.example') && skipped.message.includes('me@home.example') && bound.loginUser === 'u-home', skipped instanceof Error ? skipped.message : '');
	let stopped: unknown = null;
	try { checkLogin('claude.ai', bound, { id: 'u-work' }, [], false); } catch (e) { stopped = e; }
	expect('login check: another login in the login window stops the sync', stopped instanceof StopError && !(stopped instanceof BrowserLinkUnavailable));
	let twin: unknown = null;
	try { checkLogin('claude.ai', {}, { id: 'u-home' }, [{ label: 'Personal', web: bound }], true); } catch (e) { twin = e; }
	expect('login check: a login another account already holds stops, naming that account', twin instanceof StopError && (twin as Error).message.includes('"Personal"'));
	forgetLogin(bound);
	expect('login check: "Accept this login" forgets it, and the next sync takes the new one', !bound.loginUser && checkLogin('claude.ai', bound, { id: 'u-work' }, [], true) && bound.loginUser === 'u-work');
	expect('Google account number: Gemini uses /u/N/ for the Nth account, nothing for the default one', geminiBase(undefined) === 'https://gemini.google.com' && geminiBase(2) === 'https://gemini.google.com/u/2');
}

async function main() {
	testSwitch();
	await testTransport();
	await testSamePage();
	await testSkip();
	await testClaudeAndGpt();
	await testGoogleMode();
	await testOpenPage();
	await testSeveralBrowsers();
	testLoginCheck();
	testPickBrowser();
	console.log(failures ? `${failures} Browser link check(s) FAILED.` : 'All Browser link checks passed.');
	process.exit(failures ? 1 : 0);
}
void main();
