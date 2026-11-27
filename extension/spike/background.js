// Stage 0 spike: the extension's remote hand. Connects to the local app on 127.0.0.1,
// opens its own background tabs of the supported sites and runs packaged page functions there.
// Never parses, stores or logs what the sites answer.

import { pageFetch, readyCheck, cookieNames } from './recipes.js';

const ALLOWED_ORIGINS = new Set([
	'https://claude.ai',
	'https://chatgpt.com',
	'https://gemini.google.com',
	'https://aistudio.google.com',
]);
// Hosts a page may call besides its own origin (AI Studio's API).
const ALLOWED_TARGETS = new Set([...ALLOWED_ORIGINS, 'https://alkalimakersuite-pa.clients6.google.com']);
const READY_CHECKS = new Set(['gemini-signed-in', 'studio-ready', 'loaded']);
const PING_MS = 20_000;

let ws = null;
let pingTimer = null;
const pages = new Map(); // page id -> tab id (only tabs this extension opened)
let nextPage = 1;

function originOf(url) {
	try {
		const u = new URL(url);
		return u.protocol === 'https:' ? u.origin : null;
	} catch {
		return null;
	}
}

async function connect() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const { pairing } = await chrome.storage.local.get('pairing');
	if (!pairing) return;
	const sock = new WebSocket(`ws://127.0.0.1:${pairing.port}`);
	ws = sock;
	sock.onopen = () => {
		sock.send(JSON.stringify({ op: 'hello', token: pairing.token, ua: navigator.userAgent }));
		clearInterval(pingTimer);
		pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ op: 'ping' })), PING_MS);
		setStatus('connected');
	};
	sock.onmessage = (ev) => onMessage(sock, ev.data);
	sock.onclose = () => {
		clearInterval(pingTimer);
		if (ws === sock) ws = null;
		setStatus('not connected');
		closeAllPages();
	};
	sock.onerror = () => {};
}

function setStatus(s) {
	chrome.storage.session?.set({ status: s }).catch(() => {});
}

async function onMessage(sock, raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	if (msg.op === 'pong') return;
	const reply = (data) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ id: msg.id, ...data }));
	try {
		reply({ ok: true, ...(await handle(msg)) });
	} catch (e) {
		reply({ ok: false, error: { kind: e.kind || 'failed', message: String(e.message || e) } });
	}
}

function fail(kind, message) {
	const e = new Error(message);
	e.kind = kind;
	return e;
}

async function handle(msg) {
	switch (msg.op) {
		case 'open': return openPage(msg.url, msg.ready, msg.timeoutMs || 45_000);
		case 'fetch': return runFetch(msg);
		case 'cookie-names': return { names: await inPage(tabOf(msg.page), cookieNames, []) };
		case 'close': closePage(msg.page); return {};
		case 'close-all': closeAllPages(); return {};
		default: throw fail('not-allowed', 'unknown op');
	}
}

function tabOf(page) {
	const tab = pages.get(page);
	if (tab == null) throw fail('no-tab', 'no such page');
	return tab;
}

async function inPage(tabId, func, args) {
	const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
	if (!res) throw fail('failed', 'no result from the page');
	return res.result;
}

async function openPage(url, ready, timeoutMs) {
	const origin = originOf(url);
	if (!origin || !ALLOWED_ORIGINS.has(origin)) throw fail('not-allowed', 'site not allowed');
	if (!READY_CHECKS.has(ready)) throw fail('not-allowed', 'unknown ready check');
	const tab = await chrome.tabs.create({ url, active: false });
	const id = 'p' + nextPage++;
	pages.set(id, tab.id);
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const t = await chrome.tabs.get(tab.id);
			if (originOf(t.url || '') !== origin) continue; // still redirecting, or sent to a login page
			if (t.status === 'complete' && await inPage(tab.id, readyCheck, [ready])) return { page: id };
		} catch {
			// tab still loading or navigating; try again
		}
	}
	const t = await chrome.tabs.get(tab.id).catch(() => null);
	closePage(id);
	throw fail('not-logged-in', `page did not become ready (ended on ${t ? originOf(t.url || '') : 'a closed tab'})`);
}

async function runFetch(msg) {
	const tabId = tabOf(msg.page);
	const tab = await chrome.tabs.get(tabId);
	const here = originOf(tab.url || '');
	if (!here || !ALLOWED_ORIGINS.has(here)) throw fail('not-logged-in', 'the tab left the site');
	let url;
	try {
		url = new URL(msg.url, here).toString();
	} catch {
		throw fail('not-allowed', 'bad address');
	}
	const target = originOf(url);
	if (!target || !ALLOWED_TARGETS.has(target)) throw fail('not-allowed', 'target not allowed');
	if (msg.sign && msg.sign !== 'wiz-at' && msg.sign !== 'sapisidhash') throw fail('not-allowed', 'unknown signing');
	const { method, headers, body64, bodyText, redirect, sign } = msg;
	return inPage(tabId, pageFetch, [{ url, method, headers, body64, bodyText, redirect, sign }]);
}

function closePage(id) {
	const tab = pages.get(id);
	pages.delete(id);
	if (tab != null) chrome.tabs.remove(tab).catch(() => {});
}

function closeAllPages() {
	for (const id of [...pages.keys()]) closePage(id);
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
	if (m?.op === 'reconnect') {
		ws?.close();
		ws = null;
		connect().then(() => send({ ok: true }));
		return true;
	}
	return false;
});
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'reconnect' && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
