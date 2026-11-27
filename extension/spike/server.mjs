// Stage 0 spike: a stand-in for the plugin's local channel. Run it, paste the code into the
// extension's options page, and it runs one check per site through your real browser.
// It prints only statuses, sizes and yes/no answers. Never bodies, cookies or tokens.
//
//   node server.mjs [--port=48213] [--idle=300] [--only=claude,chatgpt,gemini,studio]

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const arg = (name, def) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || def;
const PORT = Number(arg('port', '48213'));
const IDLE_S = Number(arg('idle', '300'));
const ONLY = new Set(arg('only', 'claude,chatgpt,gemini,studio').split(','));
const TOKEN = randomBytes(18).toString('base64url');

const results = [];
const note = (site, check, result, detail = '') => {
	results.push({ site, check, result, detail });
	console.log(`  ${result === 'OK' ? '✓' : result === 'FAIL' ? '✗' : '·'} ${site.padEnd(9)} ${check.padEnd(34)} ${result}${detail ? '  ' + detail : ''}`);
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 64 * 1024 * 1024 });
console.log(`\nListening on 127.0.0.1:${PORT}\n\nPairing code:  ${PORT}-${TOKEN}\n\nPaste it in the extension's options page, then wait.\n`);

let busy = false;
wss.on('connection', (sock, req) => {
	const origin = req.headers.origin || '';
	if (!/^(chrome|moz)-extension:\/\//.test(origin)) {
		console.log(`Rejected a connection from origin "${origin || 'none'}"`);
		sock.close(1008);
		return;
	}
	const hello = setTimeout(() => sock.close(1008), 5000);
	sock.once('message', (raw) => {
		clearTimeout(hello);
		let msg;
		try { msg = JSON.parse(String(raw)); } catch { msg = {}; }
		const a = Buffer.from(String(msg.token || '')), b = Buffer.from(TOKEN);
		if (msg.op !== 'hello' || a.length !== b.length || !timingSafeEqual(a, b)) {
			console.log('Rejected a connection with a wrong token');
			sock.close(1008);
			return;
		}
		console.log(`Linked: ${/Edg\//.test(msg.ua) ? 'Edge' : /Brave/.test(msg.ua) ? 'Brave' : 'Chrome'} ${(msg.ua.match(/Chrome\/([\d.]+)/) || [])[1] || ''}\n`);
		if (busy) return;
		busy = true;
		run(link(sock)).catch((e) => console.log('Stopped:', e.message)).finally(() => finish(sock));
	});
});

function link(sock) {
	let next = 1;
	const waiting = new Map();
	let pings = 0;
	sock.on('message', (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.op === 'ping') { pings++; sock.send(JSON.stringify({ op: 'pong' })); return; }
		const w = waiting.get(msg.id);
		if (w) { waiting.delete(msg.id); w(msg); }
	});
	sock.on('close', () => { for (const w of waiting.values()) w({ ok: false, error: { kind: 'browser-closed', message: 'connection closed' } }); waiting.clear(); });
	const call = (op, data = {}, timeoutMs = 90_000) => new Promise((resolve) => {
		const id = next++;
		const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { kind: 'timeout', message: 'no answer' } }); }, timeoutMs);
		waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
		sock.send(JSON.stringify({ id, op, ...data }));
	});
	return { call, sock, pings: () => pings };
}

const text = (r) => Buffer.from(r.body64 || '', 'base64').toString('utf8');
const err = (r) => `${r.error?.kind}: ${r.error?.message}`;

async function open(l, site, url, ready) {
	const r = await l.call('open', { url, ready, timeoutMs: 45_000 }, 60_000);
	note(site, `open ${new URL(url).host} (${ready})`, r.ok ? 'OK' : 'FAIL', r.ok ? '' : err(r));
	return r.ok ? r.page : null;
}

async function cookies(l, site, page, wanted) {
	const r = await l.call('cookie-names', { page });
	if (!r.ok) return note(site, 'cookie names visible to page', 'FAIL', err(r));
	for (const name of wanted) note(site, `cookie "${name}" readable by page`, r.names.includes(name) ? 'yes' : 'no');
}

async function run(l) {
	if (ONLY.has('claude')) {
		const p = await open(l, 'Claude', 'https://claude.ai/new', 'loaded');
		if (p) {
			const r = await l.call('fetch', { page: p, url: 'https://claude.ai/api/organizations', method: 'GET', headers: { Accept: 'application/json' } });
			let orgs = null;
			try { orgs = JSON.parse(text(r)); } catch { /* not JSON */ }
			note('Claude', 'fetch /api/organizations', r.ok && r.status === 200 && Array.isArray(orgs) ? 'OK' : 'FAIL', r.ok ? `status ${r.status}, ${Array.isArray(orgs) ? orgs.length + ' org(s)' : 'not a list'}` : err(r));
			await cookies(l, 'Claude', p, ['lastActiveOrg', 'sessionKey']);
			const fav = await l.call('fetch', { page: p, url: 'https://claude.ai/favicon.ico', method: 'GET' });
			await binaryCheck('Claude', fav, 'https://claude.ai/favicon.ico');
			await l.call('close', { page: p });
		}
	}
	if (ONLY.has('chatgpt')) {
		const p = await open(l, 'ChatGPT', 'https://chatgpt.com/', 'loaded');
		if (p) {
			const home = await l.call('fetch', { page: p, url: 'https://chatgpt.com/', method: 'GET' });
			note('ChatGPT', 'fetch / (HTML)', home.ok && home.status === 200 ? 'OK' : 'FAIL', home.ok ? `status ${home.status}, ${Math.round(text(home).length / 1024)} KB, accessToken in HTML: ${/"accessToken"/.test(text(home)) ? 'yes' : 'no'}` : err(home));
			const s = await l.call('fetch', { page: p, url: 'https://chatgpt.com/api/auth/session', method: 'GET' });
			let j = null;
			try { j = JSON.parse(text(s)); } catch { /* not JSON */ }
			note('ChatGPT', 'fetch /api/auth/session', s.ok && s.status === 200 && j ? 'OK' : 'FAIL', s.ok ? `status ${s.status}, accessToken: ${j && typeof j.accessToken === 'string' ? 'yes' : 'no'}` : err(s));
			await cookies(l, 'ChatGPT', p, ['oai-did', '_account']);
			const fav = await l.call('fetch', { page: p, url: 'https://chatgpt.com/favicon.ico', method: 'GET' });
			await binaryCheck('ChatGPT', fav, 'https://chatgpt.com/favicon.ico');
			await l.call('close', { page: p });
		}
	}
	if (ONLY.has('gemini')) {
		const p = await open(l, 'Gemini', 'https://gemini.google.com/app', 'gemini-signed-in');
		if (p) {
			const rpc = 'MaZiqc';
			const q = new URLSearchParams({ rpcids: rpc, 'source-path': '/app', hl: 'en', _reqid: String(100000 + Math.floor(Math.random() * 900000)), rt: 'c' });
			const bodyText = new URLSearchParams({ 'f.req': JSON.stringify([[[rpc, JSON.stringify([5, null, [0, null, 1]]), null, 'generic']]]) }).toString();
			const r = await l.call('fetch', { page: p, url: '/_/BardChatUi/data/batchexecute?' + q, method: 'POST', sign: 'wiz-at', bodyText, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' } });
			const t = r.ok ? text(r) : '';
			note('Gemini', 'signed list-chats call (no eval)', r.ok && r.status === 200 && t.startsWith(")]}'") && t.includes(rpc) ? 'OK' : 'FAIL', r.ok ? `status ${r.status}, ${t.length} bytes` : err(r));
			await cookies(l, 'Gemini', p, ['SAPISID']);
			await l.call('close', { page: p });
		}
	}
	if (ONLY.has('studio')) {
		const p = await open(l, 'AI Studio', 'https://aistudio.google.com/library', 'studio-ready');
		if (p) {
			const url = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts';
			const r = await l.call('fetch', { page: p, url, method: 'POST', sign: 'sapisidhash', bodyText: '[5]', headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-AuthUser': '0' } });
			let ok = false;
			try { JSON.parse(text(r)); ok = true; } catch { /* not JSON */ }
			note('AI Studio', 'signed list-prompts call (no eval)', r.ok && r.status === 200 && ok ? 'OK' : 'FAIL', r.ok ? `status ${r.status}, ${text(r).length} bytes` : err(r));
			await l.call('close', { page: p });
		}
	}
	const bad = await l.call('open', { url: 'https://example.com/', ready: 'loaded' });
	note('Safety', 'extension refuses example.com', !bad.ok && bad.error.kind === 'not-allowed' ? 'OK' : 'FAIL');

	if (IDLE_S > 0) {
		console.log(`\nIdle test: waiting ${IDLE_S} s with only keep-alive pings…`);
		await new Promise((r) => setTimeout(r, IDLE_S * 1000));
		const alive = l.sock.readyState === l.sock.OPEN;
		const p = alive ? await l.call('open', { url: 'https://claude.ai/new', ready: 'loaded' }, 60_000) : { ok: false };
		if (p.ok) await l.call('close', { page: p.page });
		note('Link', `same connection after ${IDLE_S} s idle`, alive && p.ok ? 'OK' : 'FAIL', `${l.pings()} pings`);
	}
}

async function binaryCheck(site, r, url) {
	if (!r.ok || r.status !== 200) return note(site, 'binary download', 'FAIL', r.ok ? `status ${r.status}` : err(r));
	const viaBrowser = Buffer.from(r.body64, 'base64');
	let detail = `${viaBrowser.length} bytes`;
	try {
		const direct = Buffer.from(await (await fetch(url)).arrayBuffer());
		const same = createHash('sha256').update(direct).digest('hex') === createHash('sha256').update(viaBrowser).digest('hex');
		detail += same ? ', identical to a direct download' : ', differs from a direct download (may be a different file version)';
	} catch {
		detail += ', direct download for comparison not possible';
	}
	note(site, 'binary download (base64 round trip)', 'OK', detail);
}

async function finish(sock) {
	await new Promise((r) => { sock.send(JSON.stringify({ id: 0, op: 'close-all' })); setTimeout(r, 500); });
	writeFileSync(new URL('./spike-results.json', import.meta.url), JSON.stringify({ when: new Date().toISOString(), results }, null, '\t'));
	console.log('\nDone. Results saved to spike-results.json (no secrets in it). You can close this window.');
	wss.close();
	process.exit(0);
}
