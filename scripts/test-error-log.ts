// Error log: whole failed answers per account, secrets removed, capped, saved in the plugin folder.
// Run: npm run test:error-log

(globalThis as unknown as { window: unknown }).window = globalThis;

import {
	cleanText, clearErrors, recordFetchAnswer, entryMarkdown, errorEntries, errorLogAccounts, flushErrorLog, initErrorLog, pruneErrors, recordError, type ErrorSource,
} from '../src/error-log';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { ClaudeApi } from '../src/api';
import { GptApi } from '../src/chatgpt/api';
import { testHooks } from 'obsidian';
import { GeminiApi } from '../src/gemini/api';
import { StudioApi } from '../src/studio/api';
import { LumoApi } from '../src/lumo/api';
import { ERROR_LOG_EMPTY, ERROR_LOG_WARNING } from '../src/ui/error-logs-tab';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

/** In-memory stand-in for Obsidian's vault adapter. */
function memAdapter(failWrites = false) {
	const files = new Map<string, string>();
	return {
		files,
		exists: async (p: string) => files.has(p),
		read: async (p: string) => {
			const t = files.get(p);
			if (t === undefined) throw new Error('missing');
			return t;
		},
		write: async (p: string, t: string) => {
			if (failWrites) throw new Error('read-only');
			files.set(p, t);
		},
	};
}

const A: ErrorSource = { provider: 'chatgpt', accountId: 'a' };
const B: ErrorSource = { provider: 'claude', accountId: 'b' };
const DIR = '.obsidian/plugins/ai-chatbridge';
const FILE = `${DIR}/error-log.json`;
const ENV = 'AI ChatBridge 0.38.0 · Obsidian test · Windows';

async function main() {
	// --- cleaning ---
	const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';
	const uuid = '0b3c9a52-7e1d-4c2a-9f3e-5d6b7a8c9e01';
	const raw = [
		'key sk-ant-sid01-SECRETSECRET here',
		'Cookie: sessionKey=xyz123abc; other=1',
		`token ${jwt}`,
		'{"accessToken":"abcdefghijklmnop","user":"x"}',
		'Authorization: Bearer abc.def.ghi',
		'__Secure-next-auth.session-token.0=longsessionvalue',
		`chat ${uuid}`,
		'cf-ray: 8f2a1c3b9d4e5f60-FRA',
	].join('\n');
	const c = cleanText(raw, ['sk-ant-sid01-SECRETSECRET', null, 'short']);
	expect('passed secret hidden', !c.includes('SECRETSECRET') && c.includes('key [hidden] here'), c);
	expect('sessionKey= hidden', c.includes('sessionKey=[hidden]') && !c.includes('xyz123abc'));
	expect('JWT hidden', !c.includes(jwt));
	expect('accessToken value hidden', c.includes('"accessToken":"[hidden]"') && !c.includes('abcdefghijklmnop'));
	expect('Bearer hidden', c.includes('Bearer [hidden]') && !c.includes('abc.def.ghi'));
	expect('ChatGPT session cookie hidden', !c.includes('longsessionvalue'));
	expect('UUID kept', c.includes(uuid));
	expect('cf-ray kept', c.includes('cf-ray: 8f2a1c3b9d4e5f60-FRA'));
	expect('short secret (<8) not split-joined', c.includes('chat '));

	// review fixes: signed links, encrypted session tokens, escaped JSON
	const signed = cleanText('https://chatgpt.com/backend-api/estuary/content?id=file_00000000abc&ts=123&p=fs&sig=0a1b2c3d4e5f60718293');
	expect('link signature hidden, file ID kept', signed.includes('sig=[hidden]') && !signed.includes('0a1b2c3d4e5f') && signed.includes('id=file_00000000abc'), signed);
	const amz = cleanText('https://files.example.com/x?X-Amz-Signature=abcdef123456&X-Goog-Signature=fedcba654321&se=2026&sp=r&sv=1');
	expect('S3/GCS/SAS signatures hidden', !amz.includes('abcdef123456') && !amz.includes('fedcba654321') && amz.includes('sv=1'), amz);
	const jwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYxMjNhYmM.Y2lwaGVyNDU2ZGVmZ2hp.dGFnNzg5';
	expect('encrypted session token (JWE) hidden', !cleanText(`v=${jwe}`).includes('Y2lwaGVyNDU2ZGVmZ2hp'), cleanText(`v=${jwe}`));
	const escaped = cleanText('{\\"accessToken\\":\\"escapedsecret123\\",\\"x\\":1}');
	expect('escaped JSON token hidden', !escaped.includes('escapedsecret123'), escaped);
	const quoteInside = cleanText('{"token":"ab\\"cdsecretrest","n":1}');
	expect('token with escaped quote hidden whole', !quoteInside.includes('cdsecretrest'), quoteInside);

	// a body that never ends must not hold up the stop
	const endless = new Response(new ReadableStream({ start() { /* never closes */ } }), { status: 502, headers: { 'content-type': 'text/html' } });
	const t0 = Date.now();
	const slowAd = memAdapter();
	await initErrorLog(slowAd as never, DIR, ENV);
	await recordFetchAnswer(A, 'ChatGPT', 'GET', 'https://chatgpt.com/', endless, 'start page answered 502', [], 50);
	expect('stalled body: returns after the time limit', Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
	expect('stalled body: still recorded', errorEntries(A)[0]?.status === 502 && errorEntries(A)[0]?.headers['content-type'] === 'text/html');

	// --- recording, before init: nothing, no throw ---
	let threw = false;
	try {
		recordError(A, { service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/', status: 403 });
	} catch {
		threw = true;
	}
	expect('record before init does not throw', !threw);

	const ad = memAdapter();
	await initErrorLog(ad as never, DIR, ENV);
	expect('record before init kept nothing', errorEntries(A).length === 0);
	recordError(undefined, { service: 'x', method: 'GET', url: 'u', status: 500 });

	recordError(A, {
		service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/backend-api/conversations?offset=0', status: 403,
		headers: { 'Set-Cookie': 'a=b', 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', Authorization: 'Bearer x' },
		body: '<!DOCTYPE html><title>Just a moment...</title>',
	});
	let e = errorEntries(A)[0];
	expect('entry saved', !!e && e.status === 403);
	expect('set-cookie hidden', e?.headers['set-cookie'] === '[hidden]');
	expect('authorization hidden', e?.headers['authorization'] === '[hidden]');
	expect('other headers kept', e?.headers['cf-mitigated'] === 'challenge' && e?.headers['content-type'] === 'text/html; charset=UTF-8');
	expect('body kept whole', e?.body === '<!DOCTYPE html><title>Just a moment...</title>');
	expect('env kept', e?.env === ENV);

	// cap 20, newest first
	for (let i = 0; i < 25; i++) recordError(A, { service: 'ChatGPT', method: 'GET', url: `https://chatgpt.com/n${i}`, status: 500 });
	const list = errorEntries(A);
	expect('20 kept', list.length === 20, String(list.length));
	expect('newest first', list[0]?.url === 'https://chatgpt.com/n24' && list[19]?.url === 'https://chatgpt.com/n5');
	expect('other account empty', errorEntries(B).length === 0);

	// big body
	recordError(B, { service: 'claude.ai', method: 'GET', url: 'https://claude.ai/api/x', status: 500, body: 'x'.repeat(70_000) });
	e = errorEntries(B)[0];
	expect('body cut at 64 KB', !!e && e.body.startsWith('x'.repeat(65_536)) && e.body.length < 65_536 + 40, String(e?.body.length));
	expect('cut marker', !!e && e.body.endsWith('… cut, 5 KB more'), e?.body.slice(-30));
	expect('bodyBytes original', e?.bodyBytes === 70_000);

	// binary body
	recordError(B, { service: 'claude.ai', method: 'POST', url: 'https://claude.ai/rpc', status: 403, body: new Uint8Array([1, 2, 3, 4]).buffer, contentType: 'application/proto' });
	e = errorEntries(B)[0];
	expect('binary body summarised', e?.body === '[binary, 4 bytes]', e?.body);
	// JSON in an ArrayBuffer is text
	recordError(B, { service: 'claude.ai', method: 'POST', url: 'https://claude.ai/rpc', status: 403, body: new TextEncoder().encode('{"code":"permission_denied"}').buffer, contentType: 'application/json' });
	expect('text in ArrayBuffer decoded', errorEntries(B)[0]?.body === '{"code":"permission_denied"}');

	// secrets passed with the input are removed from body and message
	recordError(B, { service: 'claude.ai', method: 'GET', url: 'https://claude.ai/api/organizations', status: 401, body: 'key=sk-ant-REALKEY123', message: 'refused sk-ant-REALKEY123', secrets: ['sk-ant-REALKEY123'] });
	e = errorEntries(B)[0];
	expect('secret removed from body and message', !!e && !e.body.includes('REALKEY') && !e.message.includes('REALKEY'));

	// saved to the plugin folder file; a second load restores it
	await flushErrorLog();
	expect('file written', ad.files.has(FILE));
	expect('file holds no secret', !(ad.files.get(FILE) ?? '').includes('REALKEY'));
	await initErrorLog(ad as never, DIR, ENV);
	expect('reload restores entries', errorEntries(A).length === 20 && errorEntries(B).length === 4);

	// corrupt file → empty
	const bad = memAdapter();
	bad.files.set(FILE, '{not json');
	await initErrorLog(bad as never, DIR, ENV);
	expect('corrupt file starts empty', errorEntries(A).length === 0);

	// failing writes never throw
	const ro = memAdapter(true);
	await initErrorLog(ro as never, DIR, ENV);
	threw = false;
	try {
		recordError(A, { service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/', status: 403 });
		await flushErrorLog();
	} catch {
		threw = true;
	}
	expect('failing write does not throw', !threw);
	expect('entry still in memory', errorEntries(A).length === 1);

	// prune and clear
	const pa = memAdapter();
	await initErrorLog(pa as never, DIR, ENV);
	recordError(A, { service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/', status: 403 });
	recordError(B, { service: 'claude.ai', method: 'GET', url: 'https://claude.ai/', status: 403 });
	await pruneErrors([A]);
	expect('prune drops removed account', errorEntries(B).length === 0 && errorEntries(A).length === 1);
	await clearErrors(A);
	expect('clear empties account', errorEntries(A).length === 0);

	// Markdown for an issue
	recordError(A, {
		service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/backend-api/conversations', status: 403,
		headers: { 'content-type': 'application/json' }, body: '{"detail":"Unusual activity"}',
	});
	let md = entryMarkdown(errorEntries(A)[0]!, 'ChatGPT · Default');
	expect('markdown title', md.startsWith('### ChatGPT · Default'), md.split('\n')[0]);
	expect('markdown request line', md.includes('GET https://chatgpt.com/backend-api/conversations → **403**'));
	expect('markdown env', md.includes(ENV));
	expect('markdown headers block', md.includes('```\ncontent-type: application/json\n```'));
	expect('markdown json body fence', md.includes('```json\n{"detail":"Unusual activity"}\n```'));
	recordError(A, { service: 'ChatGPT', method: 'GET', url: 'https://chatgpt.com/', status: 403, headers: { 'content-type': 'text/html' }, body: '<html></html>' });
	md = entryMarkdown(errorEntries(A)[0]!, 'ChatGPT · Default');
	expect('markdown html fence', md.includes('```html\n<html></html>\n```'));
	recordError(A, { service: 'Lumo', method: 'GET', url: 'https://lumo.proton.me/api', status: null, message: 'Network error while talking to Lumo.' });
	md = entryMarkdown(errorEntries(A)[0]!, 'Lumo · Default');
	expect('markdown no answer', md.includes('→ **no answer**') && md.includes('Network error while talking to Lumo.'));
	recordError(A, { service: 'x', method: 'GET', url: 'u', status: 500, body: 'a ``` b' });
	md = entryMarkdown(errorEntries(A)[0]!, 'x');
	expect('fence longer than backticks in body', md.includes('````\na ``` b\n````'));

	// accounts for the tab
	const s = structuredClone(DEFAULT_SETTINGS) as Settings;
	s.chatgpt.push({ ...s.chatgpt[0]!, id: 'a', label: 'Work' });
	const accounts = errorLogAccounts(s);
	expect('every account listed in order', accounts.map((x) => `${x.source.provider}:${x.source.accountId}`).join(',') === `claude:${s.claude[0]!.id},chatgpt:${s.chatgpt[0]!.id},chatgpt:a,lumo:${s.lumo[0]!.id},gemini:${s.gemini[0]!.id}`, accounts.map((x) => x.title).join(','));
	const work = accounts.find((x) => x.source.accountId === 'a');
	expect('title and count', work?.title === 'ChatGPT · Work' && work.count === errorEntries(A).length, `${work?.title} ${work?.count}`);
	s.chatgpt[1]!.label = 'Job';
	expect('rename keeps entries', errorLogAccounts(s).find((x) => x.source.accountId === 'a')?.title === 'ChatGPT · Job' && errorEntries(A).length > 0);

	expect('tab warning text', ERROR_LOG_WARNING === 'Remove all personal data (email addresses, names, chat titles and chat text) before you paste this into a GitHub issue. Cookies and login keys are removed automatically.');
	expect('tab empty text', ERROR_LOG_EMPTY === 'No errors saved for this account.');

	await apiChecks();

	console.log(failures ? `\n${failures} FAILED` : '\nAll error log checks passed.');
	if (failures) process.exit(1);
}

/** A requestUrl answer as Obsidian gives it. */
function answer(status: number, headers: Record<string, string>, text: string) {
	const bytes = new TextEncoder().encode(text);
	return { status, headers, text, arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), json: null };
}

/** The real Claude and ChatGPT request code, answered by the test. */
async function apiChecks() {
	const ad = memAdapter();
	await initErrorLog(ad as never, DIR, ENV);
	const org = '11111111-2222-4333-8444-555555555555';
	const chat = '66666666-7777-4888-9999-aaaaaaaaaaaa';
	const key = 'sk-ant-sid01-TESTKEYVALUE';
	const claude: ErrorSource = { provider: 'claude', accountId: 'c1' };
	let reply = answer(403, { 'content-type': 'application/json' }, JSON.stringify({ code: 'permission_denied', message: 'This isn’t available for your account.', details: [{ debug: { subReason: 'blocked_by_org_tier' } }], echo: `sessionKey=${key}` }));
	testHooks.requestUrl = async () => reply;

	const api = new ClaudeApi(org, () => key, claude);
	let stop = '';
	try {
		await api.readConversation(chat);
	} catch (e) {
		stop = e instanceof Error ? e.message : String(e);
	}
	let e = errorEntries(claude)[0];
	expect('Claude: stop message unchanged', stop === 'claude.ai answered 403 (forbidden) to ReadConversation.', stop);
	expect('Claude: 403 to ReadConversation recorded', e?.status === 403 && e.method === 'POST' && e.url.endsWith('.ConversationService/ReadConversation'));
	expect('Claude: whole body kept', !!e && e.body.includes('blocked_by_org_tier') && e.body.includes('This isn’t available for your account.'));
	expect('Claude: session key not kept', !!e && !e.body.includes('TESTKEYVALUE'));

	reply = answer(403, { 'content-type': 'text/html' }, '<title>Just a moment...</title>');
	try {
		await api.get(api.chatPath(chat));
	} catch {
		// expected stop
	}
	e = errorEntries(claude)[0];
	expect('Claude: 403 on GET recorded', e?.status === 403 && e.method === 'GET' && e.url.includes(`/chat_conversations/${chat}`) && e.body.includes('Just a moment'));

	reply = answer(200, { 'content-type': 'text/html' }, '<html>check</html>');
	try {
		await api.get(api.chatPath(chat));
	} catch {
		// expected stop
	}
	expect('Claude: 200 that is not JSON recorded', errorEntries(claude)[0]?.status === 200 && errorEntries(claude)[0]?.message.includes('expected JSON'));

	const before = errorEntries(claude).length;
	reply = answer(404, { 'content-type': 'application/json' }, '{}');
	await api.getFile(chat);
	reply = answer(200, { 'content-type': 'application/json' }, '{"ok":true}');
	await api.get(api.chatPath(chat));
	expect('Claude: allowed 404 and 200 not recorded', errorEntries(claude).length === before);

	testHooks.requestUrl = async () => {
		throw new Error(`socket hang up sessionKey=${key}`);
	};
	try {
		await api.get(api.chatPath(chat));
	} catch {
		// expected stop
	}
	e = errorEntries(claude)[0];
	expect('Claude: network error recorded without the key', e?.status === null && e.message.startsWith('Network error') && !e.message.includes('TESTKEYVALUE'));

	// ChatGPT: the constructor is private; the test builds the API the way connect() does.
	const gptSource: ErrorSource = { provider: 'chatgpt', accountId: 'g1' };
	const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXRlc3Q';
	type Ctor = new (login: unknown, cookie: string, deviceId: string | null, ua: string, token: string | null) => GptApi;
	const gpt = new (GptApi as unknown as Ctor)({ provider: 'chatgpt', id: 'g1' }, '__Secure-next-auth.session-token=SESSIONCOOKIEVALUE; cf_clearance=CLEARANCEVALUE1', null, 'UA', token);
	testHooks.requestUrl = async () => answer(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', 'set-cookie': '__cf_bm=abc' }, '<!DOCTYPE html><title>Just a moment...</title>');
	try {
		await gpt.get(gpt.listPath(0, false));
	} catch (x) {
		stop = x instanceof Error ? x.message : String(x);
	}
	e = errorEntries(gptSource)[0];
	expect('ChatGPT: stop message unchanged', stop === 'chatgpt.com answered 403 (forbidden). Login expired, or Cloudflare blocked the request – log in again.', stop);
	expect('ChatGPT: Cloudflare 403 recorded with headers and body', e?.status === 403 && e.headers['cf-mitigated'] === 'challenge' && e.headers['set-cookie'] === '[hidden]' && e.body.includes('Just a moment'));
	expect('ChatGPT: address kept', !!e && e.url.startsWith('https://chatgpt.com/backend-api/conversations?'));

	testHooks.requestUrl = async () => answer(403, { 'content-type': 'application/json' }, `{"detail":"Unusual activity","echo":"${token}","c":"SESSIONCOOKIEVALUE"}`);
	try {
		await gpt.get(gpt.listPath(0, false));
	} catch {
		// expected stop
	}
	e = errorEntries(gptSource)[0];
	expect('ChatGPT: JSON refusal kept, login removed', !!e && e.body.includes('Unusual activity') && !e.body.includes(token) && !e.body.includes('SESSIONCOOKIEVALUE'));

	const n = errorEntries(gptSource).length;
	testHooks.requestUrl = async () => answer(404, { 'content-type': 'application/json' }, '{}');
	await gpt.fileInfo('file-AAAAAAAAAAAAAAAAAAAAAAAA', '67e1a2b3-0000-4000-8000-000000000000');
	testHooks.requestUrl = async () => answer(200, { 'content-type': 'application/json' }, '{"items":[]}');
	await gpt.get(gpt.listPath(0, false));
	expect('ChatGPT: allowed 404 and 200 not recorded', errorEntries(gptSource).length === n);

	testHooks.requestUrl = async () => answer(403, { 'content-type': 'application/xml' }, '<Error>AccessDenied</Error>');
	try {
		await gpt.fileBytes('/backend-api/estuary/content?id=file_00000000abc&ts=1&p=fs&sig=99887766554433221100');
	} catch {
		// expected stop
	}
	e = errorEntries(gptSource)[0];
	expect('ChatGPT: estuary link saved without its signature', !!e && e.url.includes('estuary/content') && !e.url.includes('99887766554433221100'), e?.url);
	testHooks.requestUrl = null;

	// Gemini, AI Studio and Lumo: the page sends the request; the test plays the page.
	const page = (status: number, text: string, headers: Record<string, string>) => ({
		uid: 'LUMOUIDVALUE123', appVersion: 'web-lumo@1', close: () => undefined, goTo: async () => true,
		run: async () => JSON.stringify({ status, text, headers }),
	});
	const none = async () => undefined;
	const gem: ErrorSource = { provider: 'gemini', accountId: 'm1' };
	type PageCtor<T> = new (page: unknown, source: ErrorSource) => T;
	const gemini = new (GeminiApi as unknown as PageCtor<GeminiApi>)(page(403, ')]}\'\nforbidden', { 'content-type': 'application/json' }), gem);
	try {
		await gemini.listChats(none, () => undefined);
	} catch {
		// expected stop
	}
	e = errorEntries(gem)[0];
	expect('Gemini: 403 recorded with headers and body', e?.service === 'Gemini' && e.status === 403 && e.body.includes('forbidden') && e.headers['content-type'] === 'application/json');

	const studio = new (StudioApi as unknown as PageCtor<StudioApi>)(page(500, '{"error":{"message":"Internal"}}', { 'content-type': 'application/json' }), gem);
	try {
		await studio.listPrompts(none, () => undefined);
	} catch {
		// expected stop
	}
	e = errorEntries(gem)[0];
	expect('AI Studio: 500 recorded under the Google account', e?.service === 'AI Studio' && e.status === 500 && e.body.includes('Internal'));

	const lumoSource: ErrorSource = { provider: 'lumo', accountId: 'l1' };
	const lumo = new (LumoApi as unknown as PageCtor<LumoApi>)(page(422, '{"Code":2501,"Error":"Conversation does not exist","Echo":"LUMOUIDVALUE123"}', { 'content-type': 'application/json' }), lumoSource);
	try {
		await lumo.conversation('abc123');
	} catch (x) {
		stop = x instanceof Error ? x.message : String(x);
	}
	e = errorEntries(lumoSource)[0];
	expect('Lumo: stop message unchanged', stop === 'Lumo answered 422, so the sync stopped. Its explanation: Conversation does not exist', stop);
	expect('Lumo: whole answer kept, session ID removed', e?.status === 422 && e.body.includes('"Code":2501') && !e.body.includes('LUMOUIDVALUE123'));

	const okLumo = new (LumoApi as unknown as PageCtor<LumoApi>)(page(200, '{"Code":1000}', {}), lumoSource);
	const count = errorEntries(lumoSource).length;
	try {
		await okLumo.conversation('abc123');
	} catch {
		// shape check may refuse it; only the log matters here
	}
	expect('Lumo: 200 not recorded', errorEntries(lumoSource).length === count);

	await flushErrorLog();
	const saved = ad.files.get(FILE) ?? '';
	expect('saved file holds no login value', !saved.includes('TESTKEYVALUE') && !saved.includes('SESSIONCOOKIEVALUE') && !saved.includes('CLEARANCEVALUE1') && !saved.includes(token));
}

let finished = false;
// A promise that never settles lets Node quit early with code 0; count that as a failure.
process.on('beforeExit', () => {
	if (finished) return;
	console.log('FAIL  the checks never finished (something waited forever)');
	process.exitCode = 1;
	finished = true;
});
void main().then(() => {
	finished = true;
});
