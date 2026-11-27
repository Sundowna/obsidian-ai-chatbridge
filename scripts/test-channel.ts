// Browser link channel (Stage 2): the plugin's WebSocket server on 127.0.0.1, pairing, tokens,
// the allow-list, parted binary answers, a browser that goes away. A stand-in extension talks
// to the real server over real sockets. Run: npm run test:channel

// As in Obsidian on a computer: a window with Node's require.
Object.assign(globalThis, { window: globalThis, require });

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { LinkManager } from '../src/link/manager';
import { LinkServer, type TokenStore } from '../src/link/server';
import { LEGACY_BROWSER, readTokens } from '../src/link/account';
import { BrowserLinkError, BrowserLinkUnavailable } from '../src/link/errors';
import { fetchFrames, fromBase64, PART_BYTES, toBase64 } from '../src/link/protocol';
import { isExtensionOrigin, isLinkPage, isLinkTarget } from '../src/link/sites';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const EXT = 'chrome-extension://' + 'abcdefghijklmnopabcdefghijklmnop';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const memStore = (): TokenStore & { value: string | null } => ({ value: null, get() { return this.value; }, set(t) { this.value = t; } });

type Msg = Record<string, unknown> & { id?: number; op?: string };

/** A stand-in browser extension. `answer` plays the browser for each request. */
async function extension(port: number, first: Msg, answer: (m: Msg, ws: WebSocket) => void = () => undefined, opts: { origin?: string; host?: string } = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: opts.origin ?? EXT, headers: opts.host ? { host: opts.host } : {} });
	const seen: Msg[] = [];
	const result = await new Promise<{ ok: boolean; reply?: Msg; code?: number }>((resolve) => {
		ws.on('unexpected-response', (_req, res) => resolve({ ok: false, code: res.statusCode }));
		ws.on('error', () => resolve({ ok: false }));
		ws.on('open', () => ws.send(JSON.stringify(first)));
		ws.once('message', (raw) => resolve({ ok: true, reply: JSON.parse(String(raw)) as Msg }));
		ws.on('close', (code) => resolve({ ok: false, code }));
	});
	ws.on('message', (raw) => {
		const m = JSON.parse(String(raw)) as Msg;
		seen.push(m);
		if (m.id !== undefined) answer(m, ws);
	});
	return { ws, seen, ...result };
}

async function closed(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((r) => ws.once('close', () => r()));
}

/** True when something accepts connections on the port. */
function listeningOn(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const r = httpRequest({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => { res.resume(); resolve(true); });
		r.on('error', () => resolve(false));
		r.end();
	});
}

const messages: string[] = [];
async function rejection(p: Promise<unknown>): Promise<Error | null> {
	try {
		await p;
		return null;
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		messages.push(err.message);
		return err;
	}
}

async function testSites() {
	expect('allow-list: the four sites can be opened', ['https://claude.ai/new', 'https://chatgpt.com/', 'https://gemini.google.com/app', 'https://aistudio.google.com/library'].every(isLinkPage));
	expect('allow-list: AI Studio\'s API is a target, not a page', isLinkTarget('https://alkalimakersuite-pa.clients6.google.com/$rpc/x') && !isLinkPage('https://alkalimakersuite-pa.clients6.google.com/'));
	for (const bad of ['https://example.com/', 'http://claude.ai/', 'https://claude.ai:8443/', 'https://user:pw@claude.ai/', 'https://claude.ai.evil.com/', 'https://evil.com/?https://claude.ai', 'file:///C:/x', 'not a url', 'wss://claude.ai/']) {
		expect(`allow-list: refused ${bad}`, !isLinkTarget(bad) && !isLinkPage(bad));
	}
	expect('origin: Chrome, Edge, Brave extension pages accepted', isExtensionOrigin(EXT));
	expect('origin: Firefox extension pages accepted', isExtensionOrigin('moz-extension://0f9a1c2e-1234-4abc-8def-0123456789ab'));
	for (const bad of [undefined, '', 'null', 'https://claude.ai', 'http://127.0.0.1:5000', 'chrome-extension://short', 'chrome-extension://' + 'z'.repeat(32), EXT + '/x']) {
		expect(`origin: refused ${String(bad)}`, !isExtensionOrigin(bad));
	}
}

async function testProtocol() {
	const bytes = new Uint8Array(randomBytes(PART_BYTES * 2 + 1234));
	const frames = fetchFrames(7, 200, { 'content-type': 'application/octet-stream' }, bytes);
	expect('parts: a large body is cut into parts', frames.length === 3);
	expect('base64: every byte value survives', toBase64(new Uint8Array([0, 1, 127, 128, 255])) === 'AAF/gP8=' && fromBase64('AAF/gP8=').join() === '0,1,127,128,255');
	expect('parts: an empty body is one empty part', fetchFrames(1, 204, {}, new Uint8Array(0)).length === 1);
}

async function testManager() {
	const store = memStore();
	let desktop = true;
	const m = new LinkManager(() => ({ store }), () => desktop);
	await m.update(false);
	expect('manager: no Browser link account = no server', m.server === null);
	await m.update(true);
	const port = m.server?.port ?? 0;
	expect('manager: an account on the Browser link starts the server', port > 0 && await listeningOn(port));
	expect('manager: bound to 127.0.0.1 only', m.server?.listening === true);
	await m.update(true);
	expect('manager: asking twice keeps one server', m.server?.port === port);
	await m.update(false);
	expect('manager: the last such account gone = server stopped, port closed', m.server === null && !(await listeningOn(port)));
	desktop = false;
	await m.update(true);
	expect('manager: never on a phone or tablet', m.server === null);
	desktop = true;
	await m.update(true);
	const p2 = m.server?.port ?? 0;
	await m.stop();
	expect('manager: stopped on unload', m.server === null && !(await listeningOn(p2)));
}

async function testPairing() {
	const store = memStore();
	let t = 1_000_000;
	const s = new LinkServer({ store, now: () => t, helloTimeoutMs: 400 });
	const port = await s.start();
	try {
		const plain = await new Promise<number>((r) => httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); r(res.statusCode ?? 0); }).end());
		expect('server: a plain web request gets nothing (404)', plain === 404);

		const code = s.newPairingCode();
		expect('pairing: code carries the port and 12 letters', new RegExp(`^${port}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$`).test(code), code.replace(/-.*/, '-…'));

		const web = await extension(port, { op: 'pair', code }, undefined, { origin: 'https://evil.example' });
		expect('origin: a web page cannot connect, even with the right code', !web.ok && web.code === 401 && store.value === null);
		const noOrigin = await extension(port, { op: 'pair', code }, undefined, { origin: '' });
		expect('origin: a client without an origin cannot connect', !noOrigin.ok && store.value === null);
		const rebind = await extension(port, { op: 'pair', code }, undefined, { host: `evil.example:${port}` });
		expect('host: a request for another host name is refused (DNS rebinding)', !rebind.ok && store.value === null);

		const a = await extension(port, { op: 'pair', code: code.toLowerCase() });
		const token = String(a.reply?.token ?? '');
		expect('pairing: the right code pairs once and hands out a token', a.ok && a.reply?.op === 'paired' && token.length >= 40 && readTokens(store.value)[LEGACY_BROWSER] === token);
		expect('pairing: the browser is linked', s.linked && s.paired);
		a.ws.close();
		await closed(a.ws);
		await sleep(50);
		expect('link: a closed browser is no longer linked', !s.linked);

		const again = await extension(port, { op: 'pair', code });
		expect('pairing: the same code does not work twice', !again.ok && again.code === 1008);

		const wrongToken = await extension(port, { op: 'hello', token: token.slice(0, -2) + 'xx' });
		expect('token: a wrong token is refused', !wrongToken.ok && wrongToken.code === 1008 && !s.linked);
		const b = await extension(port, { op: 'hello', token });
		expect('token: the saved token links again', b.ok && b.reply?.op === 'welcome' && s.linked);

		const c = await extension(port, { op: 'hello', token });
		await closed(b.ws);
		expect('one browser: a newer connection replaces the older one', c.ok && s.linked && b.ws.readyState === WebSocket.CLOSED);

		c.ws.send(JSON.stringify({ op: 'ping' }));
		await sleep(100);
		expect('keep-alive: a ping gets a pong', c.seen.some((m) => m.op === 'pong'));

		const silent = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXT });
		const silentClose = await new Promise<number>((r) => silent.on('close', (code) => r(code)));
		expect('handshake: no hello in time = closed', silentClose === 1008);

		const tries = s.newPairingCode();
		for (let i = 0; i < 5; i++) await extension(port, { op: 'pair', code: `${port}-AAAA-AAAA-AAAA` });
		const late = await extension(port, { op: 'pair', code: tries });
		expect('pairing: after 5 wrong codes the code is void', !late.ok && readTokens(store.value)[LEGACY_BROWSER] === token);

		const old = s.newPairingCode();
		t += 5 * 60_000 + 1;
		const expired = await extension(port, { op: 'pair', code: old });
		expect('pairing: a code older than 5 minutes is refused', !expired.ok && readTokens(store.value)[LEGACY_BROWSER] === token);

		s.unpair();
		await closed(c.ws);
		expect('unpair: forgets the token and drops the browser', store.value === null && !s.linked && !s.paired);
		const gone = await extension(port, { op: 'hello', token });
		expect('unpair: the old token no longer works', !gone.ok);
		expect('secrets: no thrown message holds the token or a code', messages.every((m) => !m.includes(token) && !/[A-Z2-9]{4}-[A-Z2-9]{4}/.test(m)));
	} finally {
		await s.stop();
	}
}

async function testRequests() {
	const store = memStore();
	const s = new LinkServer({ store });
	const port = await s.start();
	try {
		const notPaired = await rejection(s.fetch('https://claude.ai/api/organizations', 'GET', {}));
		expect('not paired: a request says so', notPaired instanceof BrowserLinkUnavailable && notPaired.reason === 'not-paired');

		const code = s.newPairingCode();
		const big = new Uint8Array(randomBytes(PART_BYTES * 2 + 999));
		let mode = 'echo';
		const ext = await extension(port, { op: 'pair', code }, (m, ws) => {
			const send = (x: unknown) => ws.send(JSON.stringify(x));
			if (m.op === 'fetch' && mode === 'echo') {
				const body = m.body64 ? fromBase64(String(m.body64)) : new TextEncoder().encode(`${String(m.method)} ${String(m.url)}`);
				for (const f of fetchFrames(m.id!, 200, { 'content-type': 'text/plain', 'x-headers': JSON.stringify(m.headers) }, body)) send(f);
			} else if (m.op === 'fetch' && mode === 'big') {
				const frames = fetchFrames(m.id!, 200, { 'content-type': 'application/octet-stream' }, big);
				// parts out of order, as a slow socket might not, but the plugin must cope anyway
				for (const f of [frames[0], frames[2], frames[1]]) send(f);
			} else if (m.op === 'fetch' && mode === 'drop') {
				ws.close();
			} else if (m.op === 'fetch' && mode === 'login') {
				send({ id: m.id, ok: false, error: { kind: 'not-logged-in', message: 'redirected to accounts.google.com/?continue=https://gemini.google.com/app&secret=1' } });
			} else if (m.op === 'fetch' && mode === 'refused') {
				send({ id: m.id, ok: false, error: { kind: 'not-allowed', message: 'x' } });
			} else if (m.op === 'fetch' && mode === 'garbled') {
				send({ id: m.id, ok: true, status: 200, headers: {}, parts: 3, body64: 'AAAA' });
				send({ id: m.id, part: 1, body64: 'AAAA' });
				send({ id: m.id, part: 1, body64: 'BBBB' });
			} else if (m.op === 'open') {
				send({ id: m.id, ok: true, page: 'p1' });
			} else if (m.op === 'call') {
				send({ id: m.id, ok: true, answer: { status: 200, text: `signed ${String((m.call as { sign: string }).sign)}`, headers: {} } });
			} else if (m.op === 'close') {
				send({ id: m.id, ok: true });
			} else if (m.op === 'status') {
				send({ id: m.id, ok: true, tabOpen: true });
			}
		});
		const token = readTokens(store.value)[LEGACY_BROWSER] ?? '';

		const r = await s.fetch('https://claude.ai/api/organizations', 'GET', { Accept: 'application/json' });
		expect('fetch: goes to the browser and comes back', r.status === 200 && new TextDecoder().decode(r.body) === 'GET https://claude.ai/api/organizations');
		expect('fetch: headers reach the browser as given', JSON.parse(r.headers['x-headers'] ?? '{}').Accept === 'application/json');
		const post = await s.fetch('https://claude.ai/api/x', 'POST', {}, new Uint8Array([0, 255, 10]).buffer);
		expect('fetch: a binary POST body arrives byte for byte', post.body.join() === '0,255,10');

		mode = 'big';
		const b = await s.fetch('https://chatgpt.com/backend-api/estuary/content?id=file_1', 'GET', {});
		expect('parts: a 1 MB+ binary answer comes back identical', b.body.length === big.length && Buffer.from(b.body).equals(Buffer.from(big)));

		mode = 'echo';
		const before = ext.seen.length;
		for (const bad of ['https://example.com/', 'http://claude.ai/api', 'https://claude.ai:444/', 'https://user@claude.ai/']) {
			const e = await rejection(s.fetch(bad, 'GET', {}));
			expect(`allow-list: ${bad} refused before sending`, e instanceof BrowserLinkError && /Blocked/.test(e.message));
		}
		expect('allow-list: open of another site refused', (await rejection(s.open('https://example.com/', 'gemini-signed-in', 1000))) instanceof BrowserLinkError);
		expect('allow-list: a signed call to another site refused', (await rejection(s.call('p1', { url: 'https://example.com/x', method: 'POST', headers: {}, body: '', sign: 'wiz-at' }))) instanceof BrowserLinkError);
		expect('allow-list: nothing refused reached the browser', ext.seen.length === before);

		const page = await s.open('https://gemini.google.com/app', 'gemini-signed-in', 5000);
		const answer = await s.call(page, { url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc', method: 'POST', headers: {}, body: 'f.req=1', sign: 'wiz-at' });
		await s.closePage(page);
		expect('pages: open, signed call and close go through', page === 'p1' && answer.text === 'signed wiz-at' && ext.seen.some((m) => m.op === 'close' && m.page === 'p1'));
		expect('status: asks whether a tab of the site is open', await s.status('https://claude.ai/'));

		mode = 'login';
		const nl = await rejection(s.fetch('https://gemini.google.com/app', 'GET', {}));
		expect('not logged in: reported as a skip reason, not an error', nl instanceof BrowserLinkUnavailable && nl.reason === 'not-logged-in' && !nl.message.includes('secret'));
		mode = 'refused';
		const no = await rejection(s.fetch('https://claude.ai/api/x', 'GET', {}));
		expect('refused by the browser: a plain error', no instanceof BrowserLinkError && !(no instanceof BrowserLinkUnavailable));
		mode = 'garbled';
		const gb = await rejection(s.fetch('https://claude.ai/api/x', 'GET', {}));
		expect('garbled answer: a repeated part is refused, not glued in', gb instanceof BrowserLinkError);

		mode = 'drop';
		const dropped = await rejection(s.fetch('https://claude.ai/api/organizations', 'GET', {}));
		expect('browser closed mid-request: rejected as browser-closed', dropped instanceof BrowserLinkUnavailable && dropped.reason === 'browser-closed');
		const after = await rejection(s.fetch('https://claude.ai/api/organizations', 'GET', {}));
		expect('browser closed: later requests say so at once', after instanceof BrowserLinkUnavailable && after.reason === 'browser-closed');

		const quiet = new LinkServer({ store: memStore() });
		await quiet.start();
		quiet.newPairingCode();
		const qExt = await extension(quiet.port, { op: 'pair', code: '' });
		expect('pairing: an empty code is refused', !qExt.ok);
		await quiet.stop();

		const timeout = new LinkServer({ store });
		const tp = await timeout.start();
		const silentExt = await extension(tp, { op: 'hello', token });
		const slow = await rejection(timeout.fetch('https://claude.ai/api/x', 'GET', {}, undefined, undefined, 300));
		expect('no answer: times out with a plain message', slow instanceof BrowserLinkError && /did not answer within/.test(slow.message), `${slow?.name}: ${slow?.message}`);
		silentExt.ws.close();
		await timeout.stop();

		expect('secrets: no thrown message holds the token, a body or a query', messages.every((m) => !m.includes(token) && !m.includes('secret=1') && !m.includes('?')));
	} finally {
		await s.stop();
	}
	expect('stop: the port is closed afterwards', !(await listeningOn(port)));
}

(async () => {
	await testSites();
	await testProtocol();
	await testManager();
	await testPairing();
	await testRequests();
	if (failures) {
		console.log(`${failures} channel check(s) failed.`);
		process.exit(1);
	}
	console.log('All channel checks passed.');
	process.exit(0);
})();
