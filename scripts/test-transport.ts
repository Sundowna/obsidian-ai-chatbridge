// Transport switch (Browser link, Stage 1): every Claude, ChatGPT, Gemini and AI Studio request
// goes through the account's transport. Today that is always the login window, and it must send
// exactly what the plugin sent before: same addresses, headers, bodies and page code effects.
// Run: npm run test:transport

(globalThis as unknown as { window: unknown }).window = globalThis;

import { createHash } from 'node:crypto';
import { testHooks, type RequestUrlResponse } from 'obsidian';
import { ClaudeApi } from '../src/api';
import { GptApi } from '../src/chatgpt/api';
import { GeminiApi } from '../src/gemini/api';
import { StudioApi } from '../src/studio/api';
import { GEMINI_SIGNED_IN, type Provider } from '../src/login';
import { transportFor, type PageAnswer, type PageCall, type SiteRequest, type Transport } from '../src/transport';
import { loginWindowRequest, pageCallCode, READY_CODE } from '../src/transport/login-window';
import type { ErrorSource } from '../src/error-log';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const ORG = '11111111-2222-4333-8444-555555555555';
const enc = (s: string) => new TextEncoder().encode(s).buffer;
const answer = (status: number, headers: Record<string, string>, text: string) =>
	({ status, headers, text, arrayBuffer: enc(text), json: null }) as unknown as RequestUrlResponse;

/** A transport that records what sync code asks for and answers with `reply`. */
function fakeTransport(reply: RequestUrlResponse) {
	const sent: SiteRequest[] = [];
	const fetched: { url: string; init: RequestInit; timeoutMs?: number }[] = [];
	const t: Transport = {
		kind: 'login-window',
		request: async (req) => { sent.push(req); return reply; },
		canFetchInBrowser: () => true,
		fetchInBrowser: async (url, init, timeoutMs) => { fetched.push({ url, init, timeoutMs }); return new Response('', { status: 404 }); },
		isLoggedIn: async () => true,
		openPage: async () => null,
	};
	return { t, sent, fetched };
}

function noNetwork() {
	testHooks.requestUrl = async () => { throw new Error('requestUrl was called directly, not through the transport'); };
}

async function testSwitch() {
	for (const provider of ['claude', 'chatgpt', 'gemini', 'lumo'] as Provider[]) {
		expect(`switch: ${provider} uses the login window`, transportFor({ provider, id: 'a' }).kind === 'login-window');
	}
}

async function testLoginWindowRequest() {
	const asked: Record<string, unknown>[] = [];
	const reply = answer(200, { 'content-type': 'application/json' }, '{}');
	testHooks.requestUrl = async (r) => { asked.push(r as Record<string, unknown>); return reply; };
	try {
		const got = await loginWindowRequest({ url: 'https://claude.ai/api/x', method: 'GET', headers: { Cookie: 'sessionKey=k', Accept: 'application/json' }, loginOnly: ['Cookie'] });
		const get = asked[0]!;
		expect('login window: GET goes to requestUrl as before', get.url === 'https://claude.ai/api/x' && get.method === 'GET' && get.throw === false);
		expect('login window: login headers are sent', (get.headers as Record<string, string>).Cookie === 'sessionKey=k');
		expect('login window: a GET carries no body or content type keys', !('body' in get) && !('contentType' in get));
		expect('login window: the answer is handed back as it came', got === reply);
		await loginWindowRequest({ url: 'https://claude.ai/api/y', method: 'POST', headers: {}, contentType: 'application/json', body: '{"a":1}' });
		const post = asked[1]!;
		expect('login window: a POST keeps its body and content type', post.method === 'POST' && post.body === '{"a":1}' && post.contentType === 'application/json');
	} finally {
		testHooks.requestUrl = null;
	}
}

async function testClaude() {
	noNetwork();
	try {
		const { t, sent } = fakeTransport(answer(200, { 'content-type': 'application/json' }, '{}'));
		const api = new ClaudeApi(ORG, () => 'session-key-123', { provider: 'claude', accountId: 'c1' }, t);
		await api.get(api.listPath(0));
		const g = sent[0]!;
		expect('Claude: chat list GET goes through the transport', g.method === 'GET' && g.url === `https://claude.ai${api.listPath(0)}`);
		expect('Claude: same headers as before', g.headers.Cookie === 'sessionKey=session-key-123' && g.headers.Accept === 'application/json' && Object.keys(g.headers).length === 2);
		expect('Claude: the cookie is marked as login-window only', JSON.stringify(g.loginOnly) === '["Cookie"]');

		await api.rpc('ReadConversation', '{"conversationId":"x"}');
		const r = sent[1]!;
		expect('Claude: ReadConversation POST through the transport', r.method === 'POST' && r.url.startsWith('https://claude.ai/') && r.url.endsWith('/ReadConversation'), r.url);
		expect('Claude: RPC body, type and headers unchanged', r.body === '{"conversationId":"x"}' && r.contentType === 'application/json'
			&& r.headers.Cookie === `sessionKey=session-key-123; lastActiveOrg=${ORG}` && r.headers['Connect-Protocol-Version'] === '1' && r.headers['anthropic-client-platform'] === 'web_claude_ai');

		await api.memory('list', {});
		const m = sent[2]!;
		expect('Claude: memory POST through the transport', m.method === 'POST' && m.url === `https://claude.ai/api/organizations/${ORG}/melange/list` && m.body === '{}' && m.headers.Cookie === `sessionKey=session-key-123; lastActiveOrg=${ORG}`);

		await api.probe(api.codeSessionsPath());
		const c = sent[3]!;
		expect('Claude: Claude Code list keeps its extra headers', c.headers['anthropic-version'] === '2023-06-01' && c.headers['x-organization-uuid'] === ORG && c.headers.Cookie === `sessionKey=session-key-123; lastActiveOrg=${ORG}`);

		const blocked = await api.get('https://example.com/api/organizations/x').then(() => 'sent', (e: unknown) => (e instanceof Error ? e.message : ''));
		expect('Claude: the address guard still runs before the transport', /Blocked/.test(blocked) && sent.length === 4);
	} finally {
		testHooks.requestUrl = null;
	}
}

async function testChatGpt() {
	noNetwork();
	try {
		const { t, sent, fetched } = fakeTransport(answer(200, { 'content-type': 'application/json' }, '{"items":[]}'));
		const api = Object.create(GptApi.prototype) as GptApi;
		Object.assign(api, { cookie: '__Secure-next-auth.session-token=cookie-value-123', deviceId: 'dev-1', ua: 'Browser/1', token: 'login-key-456', login: { provider: 'chatgpt', id: 'g1' }, chosen: t });
		await api.get(api.listPath(0, false));
		const g = sent[0]!;
		expect('ChatGPT: chat list GET goes through the transport', g.method === 'GET' && g.url === `https://chatgpt.com${api.listPath(0, false)}`);
		expect('ChatGPT: same headers as before', g.headers.Accept === 'application/json' && g.headers.Cookie === '__Secure-next-auth.session-token=cookie-value-123'
			&& g.headers['User-Agent'] === 'Browser/1' && g.headers['OAI-Language'] === 'en-US' && g.headers['OAI-Device-Id'] === 'dev-1' && g.headers.Authorization === 'Bearer login-key-456');
		expect('ChatGPT: cookie and browser name are login-window only', JSON.stringify(g.loginOnly) === '["Cookie","User-Agent"]');

		await api.memorySummaryStream().catch(() => undefined);
		expect('ChatGPT: the memory summary stays an empty POST', sent[1]?.method === 'POST' && sent[1]?.body === undefined);

		const href = 'https://chatgpt.com/backend-api/conversation/x/interpreter/download?message_id=m';
		await (api as unknown as { sandboxFetch(h: string): Promise<Response> }).sandboxFetch(href);
		const f = fetched[0]!;
		const h = f.init.headers as Record<string, string>;
		expect('ChatGPT: generated files go through the browser storage, redirects left to the caller', f.url === href && f.init.redirect === 'manual' && h.Authorization === 'Bearer login-key-456');
	} finally {
		testHooks.requestUrl = null;
	}
}

type PageCtor<T> = new (page: unknown, source: ErrorSource) => T;
function fakePage(reply: PageAnswer) {
	const calls: PageCall[] = [];
	return { calls, page: { close: () => undefined, call: async (c: PageCall) => { calls.push(c); return reply; } } };
}
const none = async () => undefined;

async function testGoogle() {
	const g = fakePage({ status: 500, text: 'stop here' });
	const gemini = new (GeminiApi as unknown as PageCtor<GeminiApi>)(g.page, { provider: 'gemini', accountId: 'm1' });
	await gemini.listChats(none, () => undefined).catch(() => undefined);
	const c = g.calls[0]!;
	const u = new URL(c.url);
	const form = new URLSearchParams(c.body);
	expect('Gemini: list call signed by the page (wiz-at)', c.sign === 'wiz-at' && c.method === 'POST');
	expect('Gemini: same address and query as before', u.origin + u.pathname === 'https://gemini.google.com/_/BardChatUi/data/batchexecute'
		&& u.searchParams.get('rpcids') === 'MaZiqc' && u.searchParams.get('source-path') === '/app' && u.searchParams.get('hl') === 'en' && u.searchParams.get('rt') === 'c' && /^\d{6}$/.test(u.searchParams.get('_reqid') ?? ''));
	expect('Gemini: body carries the request, the page adds its token', form.get('f.req') === JSON.stringify([[['MaZiqc', JSON.stringify([50, null, [1, null, 1]]), null, 'generic']]]) && !form.has('at'));
	expect('Gemini: same headers as before', c.headers['Content-Type'] === 'application/x-www-form-urlencoded;charset=UTF-8' && c.headers['X-Same-Domain'] === '1');

	const s = fakePage({ status: 500, text: 'stop here' });
	const studio = new (StudioApi as unknown as PageCtor<StudioApi>)(s.page, { provider: 'gemini', accountId: 'm1' });
	await studio.listPrompts(none, () => undefined).catch(() => undefined);
	const sc = s.calls[0]!;
	expect('AI Studio: list call signed by the page (sapisidhash)', sc.sign === 'sapisidhash' && sc.method === 'POST'
		&& sc.url === 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts' && sc.body === '[100]');
	expect('AI Studio: the page adds key and hash, not the plugin', sc.headers['Content-Type'] === 'application/json+protobuf' && sc.headers['X-Goog-AuthUser'] === '0' && !('Authorization' in sc.headers) && !('X-Goog-Api-Key' in sc.headers));
}

/** Runs page code the way a login window does, in a stand-in page. */
async function inPage(code: string, page: Record<string, unknown>): Promise<{ result: PageAnswer; sent: { url: string; init: RequestInit }[] }> {
	const g = globalThis as unknown as Record<string, unknown>;
	const keep = { location: g.location, document: g.document, fetch: g.fetch, WIZ_global_data: g.WIZ_global_data };
	const sent: { url: string; init: RequestInit }[] = [];
	Object.assign(g, page, {
		fetch: async (url: string, init: RequestInit) => { sent.push({ url: String(url), init }); return new Response(')]}\'\nanswer', { status: 200, headers: { 'content-type': 'application/json' } }); },
	});
	try {
		const run = eval;
		return { result: JSON.parse(String(await run(code))) as PageAnswer, sent };
	} finally {
		for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete g[k]; else g[k] = v; }
	}
}

async function testPageCode() {
	const gem: PageCall = { url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&rt=c', method: 'POST', headers: { 'X-Same-Domain': '1' }, body: 'f.req=%5B%5D', sign: 'wiz-at' };
	const loc = { href: 'https://gemini.google.com/app', origin: 'https://gemini.google.com' };
	const ok = await inPage(pageCallCode(gem), { location: loc, WIZ_global_data: { SNlM0e: 'AT-TOKEN', cfb2h: 'BL-1', FdrFJe: 'SID-2' } });
	const u = new URL(ok.sent[0]!.url);
	const body = new URLSearchParams(ok.sent[0]!.init.body as URLSearchParams);
	expect('page code (Gemini): the page adds bl and f.sid to the query', u.searchParams.get('bl') === 'BL-1' && u.searchParams.get('f.sid') === 'SID-2' && u.searchParams.get('rpcids') === 'MaZiqc');
	expect('page code (Gemini): the page adds its token to the body', body.get('at') === 'AT-TOKEN' && body.get('f.req') === '[]');
	expect('page code (Gemini): same-origin cookies, headers kept', ok.sent[0]!.init.credentials === 'same-origin' && (ok.sent[0]!.init.headers as Record<string, string>)['X-Same-Domain'] === '1');
	expect('page code (Gemini): answer comes back whole', ok.result.status === 200 && ok.result.text === ')]}\'\nanswer' && ok.result.headers?.['content-type'] === 'application/json');
	const out = await inPage(pageCallCode(gem), { location: loc, WIZ_global_data: {} });
	expect('page code (Gemini): no token in the page = 401, nothing sent', out.result.status === 401 && out.sent.length === 0);

	const key = 'AIza' + 'k'.repeat(35);
	const studio: PageCall = { url: 'https://alkalimakersuite-pa.clients6.google.com/$rpc/x/ListPrompts', method: 'POST', headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-AuthUser': '0' }, body: '[100]', sign: 'sapisidhash' };
	const sLoc = { href: 'https://aistudio.google.com/library', origin: 'https://aistudio.google.com' };
	const doc = { cookie: 'a=1; SAPISID=sapisid-value; b=2', documentElement: { innerHTML: `<script>x={"WIu0Nc":"${key}"}</script>` } };
	const s = await inPage(pageCallCode(studio), { location: sLoc, document: doc });
	const h = s.sent[0]!.init.headers as Record<string, string>;
	const m = /^SAPISIDHASH (\d+)_([0-9a-f]{40}) SAPISID1PHASH \1_\2 SAPISID3PHASH \1_\2$/.exec(h.Authorization ?? '');
	const want = m ? createHash('sha1').update(`${m[1]} sapisid-value https://aistudio.google.com`).digest('hex') : '';
	expect('page code (AI Studio): hash of the login cookie and origin, as AI Studio sends it', !!m && m[2] === want, h.Authorization);
	expect('page code (AI Studio): the page adds its API key, caller headers kept', h['X-Goog-Api-Key'] === key && h['Content-Type'] === 'application/json+protobuf' && h['X-Goog-AuthUser'] === '0');
	expect('page code (AI Studio): sent with cookies to the service, body as given', s.sent[0]!.url === studio.url && s.sent[0]!.init.credentials === 'include' && s.sent[0]!.init.body === '[100]');
	const noKey = await inPage(pageCallCode(studio), { location: sLoc, document: { cookie: 'SAPISID=x', documentElement: { innerHTML: '' } } });
	expect('page code (AI Studio): no key in the page = 401, nothing sent', noKey.result.status === 401 && noKey.sent.length === 0);

	expect('ready check: Gemini is the same test as before', READY_CODE['gemini-signed-in'] === GEMINI_SIGNED_IN);
	const ready = async (page: Record<string, unknown>) => (await inPage(`JSON.stringify({ status: (${READY_CODE['studio-ready']}) ? 1 : 0, text: '' })`, page)).result.status === 1;
	expect('ready check: AI Studio open and signed in', await ready({ location: sLoc, document: doc }));
	expect('ready check: AI Studio without the login cookie is not ready', !(await ready({ location: sLoc, document: { ...doc, cookie: 'a=1' } })));
	expect('ready check: AI Studio on another site is not ready', !(await ready({ location: { href: 'https://accounts.google.com/', origin: 'https://accounts.google.com' }, document: doc })));
}

(async () => {
	await testSwitch();
	await testLoginWindowRequest();
	await testClaude();
	await testChatGpt();
	await testGoogle();
	await testPageCode();
	if (failures) {
		console.log(`${failures} transport check(s) failed.`);
		process.exit(1);
	}
	console.log('All transport checks passed.');
})();
