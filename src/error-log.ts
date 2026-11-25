// Error log: every answer a provider refused or that failed, kept whole per account so it can be
// pasted into a GitHub issue. Lives in the plugin's own folder (error-log.json), never in
// data.json or a note. Cookies, session keys and login keys are removed before anything is kept;
// request headers are never kept. Recording never throws and never waits on the sync.

import type { DataAdapter } from 'obsidian';
import type { Provider } from './login';
import type { Settings } from './settings';

export interface ErrorSource {
	provider: Provider;
	accountId: string;
}

export interface ErrorInput {
	/** Who answered, as shown: "claude.ai", "ChatGPT", "Gemini", "AI Studio", "Lumo", "Codex cloud". */
	service: string;
	method: string;
	url: string;
	/** null: no HTTP answer (network error, page did not open, no status to show). */
	status: number | null;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	/** What the plugin said (the stop text), if any. */
	message?: string;
	/** Values to remove wherever they appear (session key, cookie values, login key). */
	secrets?: (string | null | undefined)[];
}

export interface ErrorEntry {
	at: string;
	service: string;
	method: string;
	url: string;
	status: number | null;
	headers: Record<string, string>;
	body: string;
	/** Size of the body before it was cut. */
	bodyBytes: number;
	message: string;
	env: string;
}

interface LogFile {
	version: 1;
	accounts: Record<string, ErrorEntry[]>;
}

export const MAX_ENTRIES = 20;
export const MAX_BODY = 65_536;
const FILE_NAME = 'error-log.json';
const SAVE_DELAY_MS = 500;
const HIDDEN_HEADERS = new Set(['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'x-auth-token']);
const PROVIDER_TITLE: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', lumo: 'Lumo', gemini: 'Gemini' };

let adapter: DataAdapter | null = null;
let path: string | null = null;
let env = '';
let log: LogFile = { version: 1, accounts: {} };
let timer: number | null = null;
let saving: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const TOKEN_FIELDS = 'accessToken|access_token|refreshToken|refresh_token|sessionToken|session_token|token|id_token|sessionKey|AccessToken|RefreshToken|UID';
/** How long a failed answer's body may take to arrive before the stop goes ahead without it. */
const BODY_WAIT_MS = 5_000;

const keyOf = (s: ErrorSource) => `${s.provider}:${s.accountId}`;

/**
 * Removes secrets: the passed values (8+ characters), session cookies, login keys (JWTs),
 * token fields in JSON and Bearer values. IDs (UUIDs, Cloudflare ray IDs) stay, a report needs them.
 */
export function cleanText(text: string, secrets: (string | null | undefined)[] = []): string {
	let t = text;
	for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join('[hidden]');
	return t
		.replace(/sessionKey=[^;\s"'&]+/gi, 'sessionKey=[hidden]')
		.replace(/(__Secure-next-auth\.[\w.-]*=)[^;\s"'&]+/gi, '$1[hidden]')
		.replace(/(__Secure-[13]PSID[\w-]*=|SAPISID=|AUTH-[\w-]+=|REFRESH-[\w-]+=)[^;\s"'&]+/g, '$1[hidden]')
		// Signed links: the signature (or a key) in the query grants access on its own.
		.replace(/([?&](?:sig|signature|X-Amz-Signature|X-Amz-Security-Token|X-Amz-Credential|X-Goog-Signature|X-Goog-Credential|token|access_token|key)=)[^&\s"'#<]+/gi, '$1[hidden]')
		// JWTs, and encrypted ones (JWE: five parts, the second may be empty).
		.replace(/eyJ[\w-]{5,}\.[\w-]*\.[\w-]+(?:\.[\w-]+)*/g, '[key]')
		.replace(new RegExp(`("(?:${TOKEN_FIELDS})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, 'g'), '$1[hidden]"')
		// The same inside JSON that sits in a string (escaped quotes), as in a page's script.
		.replace(new RegExp(`(\\\\"(?:${TOKEN_FIELDS})\\\\"\\s*:\\s*\\\\")(?:(?!\\\\").)*\\\\"`, 'g'), '$1[hidden]\\"')
		.replace(/\b(Bearer|SAPISIDHASH|SAPISID1PHASH|SAPISID3PHASH)\s+[^\s"',]+/g, '$1 [hidden]');
}

function decodeBody(body: string | ArrayBuffer | undefined, contentType: string): { text: string; bytes: number } {
	if (body === undefined) return { text: '', bytes: 0 };
	if (typeof body === 'string') return { text: body, bytes: body.length };
	const bytes = body.byteLength;
	if (!/json|text|html|xml|javascript/i.test(contentType)) return { text: `[binary, ${bytes} bytes]`, bytes };
	try {
		return { text: new TextDecoder('utf-8', { fatal: false }).decode(body), bytes };
	} catch {
		return { text: `[binary, ${bytes} bytes]`, bytes };
	}
}

function cut(text: string): string {
	if (text.length <= MAX_BODY) return text;
	return `${text.slice(0, MAX_BODY)}\n… cut, ${Math.ceil((text.length - MAX_BODY) / 1024)} KB more`;
}

/** Loads the saved log. Call once on load; until then recording keeps nothing. */
export async function initErrorLog(a: DataAdapter, dir: string | undefined, environment: string): Promise<void> {
	adapter = a;
	path = dir ? `${dir}/${FILE_NAME}` : null;
	env = environment;
	log = { version: 1, accounts: {} };
	if (!path) return;
	try {
		if (!(await a.exists(path))) return;
		const parsed = JSON.parse(await a.read(path)) as Partial<LogFile>;
		if (parsed && typeof parsed.accounts === 'object' && parsed.accounts) {
			for (const [k, v] of Object.entries(parsed.accounts)) if (Array.isArray(v)) log.accounts[k] = v.slice(0, MAX_ENTRIES);
		}
	} catch {
		log = { version: 1, accounts: {} };
	}
}

function scheduleSave(): void {
	for (const l of listeners) {
		try {
			l();
		} catch {
			// a closed settings page must not break recording
		}
	}
	if (!adapter || !path) return;
	if (timer) window.clearTimeout(timer);
	timer = window.setTimeout(() => {
		timer = null;
		void writeNow();
	}, SAVE_DELAY_MS);
}

function writeNow(): Promise<void> {
	const a = adapter;
	const p = path;
	if (!a || !p) return saving;
	const text = JSON.stringify(log);
	saving = saving.then(() => a.write(p, text)).catch(() => undefined);
	return saving;
}

/** Writes a pending save now (tests, unload). Never throws. */
export async function flushErrorLog(): Promise<void> {
	if (timer) {
		window.clearTimeout(timer);
		timer = null;
		await writeNow();
	}
	await saving;
}

/** Keeps one failed answer for this account. Never throws. */
export function recordError(source: ErrorSource | undefined, input: ErrorInput): void {
	if (!source || !adapter) return;
	try {
		const secrets = input.secrets ?? [];
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(input.headers ?? {})) {
			const name = k.toLowerCase();
			headers[name] = HIDDEN_HEADERS.has(name) ? '[hidden]' : cleanText(String(v), secrets);
		}
		const type = input.contentType ?? headers['content-type'] ?? '';
		const { text, bytes } = decodeBody(input.body, type);
		const entry: ErrorEntry = {
			at: new Date().toISOString(),
			service: input.service,
			method: input.method,
			url: cleanText(input.url, secrets),
			status: input.status,
			headers,
			body: cut(cleanText(text, secrets)),
			bodyBytes: bytes,
			message: cleanText(input.message ?? '', secrets),
			env,
		};
		const k = keyOf(source);
		log.accounts[k] = [entry, ...(log.accounts[k] ?? [])].slice(0, MAX_ENTRIES);
		scheduleSave();
	} catch {
		// recording must never disturb a sync
	}
}

/** An Obsidian `requestUrl` answer. */
export function recordAnswer(
	source: ErrorSource | undefined, service: string, method: string, url: string,
	res: { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }, message: string, secrets: (string | null | undefined)[] = [],
): void {
	if (!source) return;
	let body: ArrayBuffer | undefined;
	try {
		body = res.arrayBuffer;
	} catch {
		body = undefined;
	}
	recordError(source, { service, method, url, status: res.status, headers: res.headers, body, message, secrets });
}

/**
 * A fetch `Response` (login window). Reads a copy of the body, but waits for it at most
 * `waitMs`: a body that does not arrive must not hold up the stop. Never throws.
 */
export async function recordFetchAnswer(
	source: ErrorSource | undefined, service: string, method: string, url: string, res: Response, message: string,
	secrets: (string | null | undefined)[] = [], waitMs = BODY_WAIT_MS,
): Promise<void> {
	if (!source) return;
	const headers: Record<string, string> = {};
	let body: ArrayBuffer | string | undefined;
	let timer: number | undefined;
	try {
		res.headers.forEach((v, k) => {
			headers[k] = v;
		});
		const late = new Promise<string>((done) => {
			timer = window.setTimeout(() => done(`[the body did not arrive within ${Math.round(waitMs / 1000)} s]`), waitMs);
		});
		body = await Promise.race([res.clone().arrayBuffer(), late]);
	} catch {
		body = undefined;
	} finally {
		window.clearTimeout(timer);
	}
	recordError(source, { service, method, url, status: res.status, headers, body, message, secrets });
}

/** This account's entries, newest first. */
export function errorEntries(source: ErrorSource): ErrorEntry[] {
	return log.accounts[keyOf(source)] ?? [];
}

export async function clearErrors(source: ErrorSource): Promise<void> {
	delete log.accounts[keyOf(source)];
	scheduleSave();
	await flushErrorLog();
}

/** Drops the entries of accounts that no longer exist. */
export async function pruneErrors(keep: ErrorSource[]): Promise<void> {
	const wanted = new Set(keep.map(keyOf));
	let changed = false;
	for (const k of Object.keys(log.accounts)) {
		if (!wanted.has(k)) {
			delete log.accounts[k];
			changed = true;
		}
	}
	if (changed) {
		scheduleSave();
		await flushErrorLog();
	}
}

/** Called after every change; returns the unsubscribe function. */
export function onErrorLogChange(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

/** Every account of every provider, in settings order, with its entry count. */
export function errorLogAccounts(s: Settings): { source: ErrorSource; title: string; count: number }[] {
	const out: { source: ErrorSource; title: string; count: number }[] = [];
	for (const provider of ['claude', 'chatgpt', 'lumo', 'gemini'] as const) {
		for (const a of s[provider]) {
			const source = { provider, accountId: a.id };
			out.push({ source, title: `${PROVIDER_TITLE[provider]} · ${a.label}`, count: errorEntries(source).length });
		}
	}
	return out;
}

/** A fence that the text cannot close. */
function fence(text: string, lang = ''): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
	const f = '`'.repeat(longest + 1);
	return `${f}${lang}\n${text}\n${f}`;
}

/** One entry as Markdown, ready for a GitHub issue. */
export function entryMarkdown(e: ErrorEntry, accountTitle: string): string {
	const when = e.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
	const lines = [`### ${accountTitle} — ${when}`, `${e.method} ${e.url} → **${e.status === null ? 'no answer' : e.status}**`, e.env];
	if (e.message) lines.push('', `Plugin said: ${e.message}`);
	const headers = Object.entries(e.headers);
	if (headers.length) lines.push('', '**Response headers**', fence(headers.map(([k, v]) => `${k}: ${v}`).join('\n')));
	if (e.body) {
		const type = e.headers['content-type'] ?? '';
		const lang = /json/i.test(type) ? 'json' : /html/i.test(type) ? 'html' : '';
		lines.push('', `**Response body** (${(e.bodyBytes / 1024).toFixed(1)} KB)`, fence(e.body, lang));
	}
	return lines.join('\n');
}
