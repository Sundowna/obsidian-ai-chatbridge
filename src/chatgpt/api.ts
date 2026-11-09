// The ONLY place that talks to chatgpt.com.
// Rules: https://chatgpt.com only, GET only, only the addresses seen in DevTools
// (allowlist below), no retries, stop on anything odd.
// Login: the cookies of the ChatGPT login window + the key the chatgpt.com page carries.
// Both stay in memory; every error text is cleaned of them before it is shown or logged.

import { requestUrl, RequestUrlResponse } from 'obsidian';
import { StopError } from '../api';
import { cookieHeader, cookieValue, isLoggedIn, loginFetch, loginUserAgent, type LoginRef } from '../login';
import { isChatId, isFileId, isMessageId } from './schema';
import { fingerprint, GptRateLimitError, retryDeadline } from './recovery';
import { sandboxPath } from './files';
import { describePage, findAccessToken, inventoryIdentity, maskSecrets } from './token';

const ORIGIN = 'https://chatgpt.com';

/** Paths we may GET (exact, or the prefix before an ID). */
const ALLOWED = [
	/^\/$/,
	/^\/backend-api\/conversations$/,
	/^\/backend-api\/conversations\/[0-9a-f-]{36}$/,
	/^\/backend-api\/conversations\/[0-9a-f-]{36}\/messages$/,
	/^\/backend-api\/gizmos\/snorlax\/sidebar$/,
	/^\/backend-api\/files\/download\/file[-_][0-9A-Za-z]{10,64}$/,
	/^\/backend-api\/estuary\/content$/,
];

/**
 * Turns per chat request – the value ChatGPT's own page uses (seen in DevTools).
 * 1000 was refused with 422 (2026-11-06). How the page asks for older turns is not
 * known yet, so a chat that does not fit is skipped (never half-saved) and logged.
 */
const NUM_TURNS = 10;

/** chatgpt.com handed out a download link to an address we have not checked yet. */
export class BlockedLinkError extends Error {
	constructor(readonly where: string) {
		super(`download link points to ${where}`);
	}
}

export interface Raw {
	bytes: ArrayBuffer;
	json: unknown;
}

function header(headers: Record<string, string>, name: string): string {
	const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
	return k ? (headers[k] ?? '') : '';
}

export class GptApi {
	inventoryKey = '';
	/** The workspace of this login, if the key names one. Not secret. */
	workspaceId: string | undefined;
	private constructor(
		private readonly login: LoginRef,
		private readonly cookie: string,
		private readonly deviceId: string | null,
		private readonly ua: string,
		private token: string | null,
	) {}

	/** Reads the login window's cookies and gets the page key. Stops if not logged in. */
	static async connect(login: LoginRef): Promise<GptApi> {
		if (!(await isLoggedIn(login))) throw new StopError('Not logged in to ChatGPT. Select "Log in" for this account in the plugin settings.');
		const api = new GptApi(login, await cookieHeader(login), await cookieValue(login, 'oai-did'), loginUserAgent(login), null);
		const page = await api.request('/', 'text/html', false, false);
		const token = findAccessToken(page.text);
		if (!token) {
			throw new StopError(`chatgpt.com did not hand out a login key – log in again in the plugin settings. If that does not help, send this to Claude: ${api.redact(describePage(page.text))}`);
		}
		api.token = token;
		// Use the workspace cookie from the same snapshot used for requests.
		const workspace = /(?:^|;\s*)_account=([^;]+)/.exec(api.cookie)?.[1] ?? null;
		const identity = inventoryIdentity(token, workspace);
		api.workspaceId = identity?.[1];
		api.inventoryKey = identity
			? 'account:' + await fingerprint(JSON.stringify(identity))
			: 'session:' + await fingerprint(JSON.stringify([token, workspace]));
		return api;
	}

	/** Removes the login from any text before it is shown or logged. */
	redact(text: string): string {
		let t = text;
		for (const secret of [this.token, ...this.cookie.split('; ').map((c) => c.slice(c.indexOf('=') + 1))]) {
			if (secret && secret.length >= 8) t = t.split(secret).join('[hidden]');
		}
		return t.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [hidden]');
	}

	/** One page of the chat list. `tpp` = the second list ChatGPT keeps separately. */
	listPath(offset: number, tpp: boolean, archived = false): string {
		const origin = tpp ? 'conversation_origin=tpp' : 'exclude_conversation_origin=tpp';
		return `/backend-api/conversations?${origin}&expand=false&hide_snorlax=false&is_archived=${archived}&is_starred=false&limit=20&order=updated&offset=${offset}`;
	}

	readonly sidebarPath = '/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false';

	projectPagePath(cursor?: string): string {
		return cursor ? `${this.sidebarPath}&cursor=${encodeURIComponent(cursor)}` : this.sidebarPath;
	}

	chatPath(id: string): string {
		if (!isChatId(id)) throw new StopError('Refusing to fetch: ChatGPT chat ID has an odd format.');
		return `/backend-api/conversations/${id}?num_turns=${NUM_TURNS}&include_has_versions=true`;
	}

	/** The older part of a long chat, before the given message (as ChatGPT's page asks for it). */
	olderPath(id: string, beforeMessageId: string): string {
		if (!isChatId(id) || !isMessageId(beforeMessageId)) throw new StopError('Refusing to fetch: ChatGPT chat or message ID has an odd format.');
		return `/backend-api/conversations/${id}/messages?before=${beforeMessageId}&num_turns=${NUM_TURNS}&include_has_versions=true`;
	}

	fileInfoPath(fileId: string, chatId: string): string {
		if (!isFileId(fileId) || !isChatId(chatId)) throw new StopError('Refusing to fetch: ChatGPT file ID has an odd format.');
		return `/backend-api/files/download/${fileId}?conversation_id=${chatId}&download_intent=false&inline=true`;
	}

	/** JSON answer, checked to really be JSON. */
	async get(path: string): Promise<Raw> {
		const res = await this.request(path, 'application/json', true, false);
		const ct = header(res.headers, 'content-type');
		if (!ct.includes('application/json')) throw new StopError(`chatgpt.com sent "${ct || 'unknown type'}" instead of JSON (maybe a Cloudflare check page).`);
		try {
			return { bytes: res.arrayBuffer, json: JSON.parse(res.text) as unknown };
		} catch {
			throw new StopError('chatgpt.com\'s answer was not valid JSON.');
		}
	}

	/** File info (JSON) or null if chatgpt.com says 404. */
	async fileInfo(fileId: string, chatId: string): Promise<unknown> {
		const res = await this.request(this.fileInfoPath(fileId, chatId), 'application/json', true, true);
		if (!res) return null;
		try {
			return JSON.parse(res.text) as unknown;
		} catch {
			throw new StopError('chatgpt.com\'s file answer was not valid JSON.');
		}
	}

	/**
	 * A file's exact bytes from the download link chatgpt.com handed out, or null on 404.
	 * chatgpt.com links: only estuary/content, with the login. Links to other addresses
	 * (decided 2026-11-06: trust what chatgpt.com hands out): https only, and WITHOUT any
	 * login – no cookies, no key; the signed link itself grants access. If such a link
	 * fails, only that file is skipped (BlockedLinkError).
	 */
	async fileBytes(downloadUrl: string): Promise<ArrayBuffer | null> {
		const url = new URL(downloadUrl, ORIGIN);
		// The place without the query (which carries the signature), for the log.
		const where = `${url.host}${url.pathname.split('/').slice(0, 3).join('/')}/…`;
		if (url.origin !== ORIGIN) {
			if (url.protocol !== 'https:' || url.username || url.password) throw new BlockedLinkError(`${where} (unsafe URL)`);
			let res;
			try {
				res = await requestUrl({ url: url.toString(), method: 'GET', headers: { 'User-Agent': this.ua }, throw: false });
			} catch {
				throw new BlockedLinkError(`${where} (network error)`);
			}
			if (res.status === 429) throw new GptRateLimitError(retryDeadline(header(res.headers, 'retry-after')));
			if (res.status === 404) return null;
			if (res.status !== 200) throw new BlockedLinkError(`${where} (answered ${res.status})`);
			return res.arrayBuffer;
		}
		if (url.pathname !== '/backend-api/estuary/content') throw new BlockedLinkError(where);
		const res = await this.request(url.pathname + url.search, '*/*', true, true);
		return res ? res.arrayBuffer : null;
	}

	/** Browser-observed generated-file route, separate from file-ID downloads. */
	async sandboxBytes(chatId: string, messageId: string, path: string): Promise<ArrayBuffer | null> {
		if (!isChatId(chatId) || !isMessageId(messageId) || sandboxPath('sandbox:' + encodeURIComponent(path)) !== path) {
			throw new BlockedLinkError('invalid generated-file reference');
		}
		const url = new URL(`/backend-api/conversation/${chatId}/interpreter/download`, ORIGIN);
		url.search = new URLSearchParams({ message_id: messageId, sandbox_path: path, download_intent: 'true' }).toString();
		let res: Response;
		try {
			res = await loginFetch(this.login, url.href, { method: 'GET', headers: this.headers('*/*', true), redirect: 'manual', signal: AbortSignal.timeout(120_000) });
		} catch {
			throw new BlockedLinkError('generated-file request failed');
		}
		if (res.status === 429) throw new GptRateLimitError(retryDeadline(res.headers.get('retry-after') ?? ''));
		if (res.status === 401) throw new StopError('ChatGPT login expired. Log in again in the plugin settings.');
		if (res.status === 404 || res.status === 410) return null;
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get('location');
			if (!location) throw new BlockedLinkError('generated-file redirect had no usable location');
			return this.fileBytes(location);
		}
		const type = res.headers.get('content-type') ?? '';
		const attachment = /attachment/i.test(res.headers.get('content-disposition') ?? '');
		if (!res.ok || (!attachment && /text\/html|application\/json/i.test(type))) {
			throw new BlockedLinkError(`generated-file download returned ${res.status} or a preview`);
		}
		return res.arrayBuffer();
	}

	private headers(accept: string, auth: boolean): Record<string, string> {
		const headers: Record<string, string> = { Accept: accept, Cookie: this.cookie, 'User-Agent': this.ua, 'OAI-Language': 'en-US' };
		if (this.deviceId) headers['OAI-Device-Id'] = this.deviceId;
		if (auth) {
			if (!this.token) throw new StopError('No ChatGPT login key.');
			headers.Authorization = `Bearer ${this.token}`;
		}
		return headers;
	}

	/** The single GET used by everything above. Stops on anything but 200 (and 404 if allowed). */
	private async request(path: string, accept: string, auth: boolean, notFoundOk: true): Promise<RequestUrlResponse | null>;
	private async request(path: string, accept: string, auth: boolean, notFoundOk: false): Promise<RequestUrlResponse>;
	private async request(path: string, accept: string, auth: boolean, notFoundOk: boolean): Promise<RequestUrlResponse | null> {
		const url = new URL(path, ORIGIN);
		if (url.origin !== ORIGIN || !ALLOWED.some((re) => re.test(url.pathname))) {
			throw new StopError('Blocked a request to a chatgpt.com address the plugin does not use.');
		}
		const headers = this.headers(accept, auth);
		let res;
		try {
			res = await requestUrl({ url: url.toString(), method: 'GET', headers, throw: false });
		} catch (e) {
			throw new StopError(`Network error: ${this.redact(e instanceof Error ? e.message : String(e))}`);
		}
		const s = res.status;
		if (s === 401) throw new StopError('chatgpt.com answered 401 (not logged in). Log in to ChatGPT again in the plugin settings.');
		if (s === 403) throw new StopError('chatgpt.com answered 403 (forbidden). Login expired, or Cloudflare blocked the request – log in again.');
		if (s === 429) throw new GptRateLimitError(retryDeadline(header(res.headers, 'retry-after')));
		if (s === 404 && notFoundOk) return null;
		if (s !== 200) {
			let why = '';
			try {
				why = maskSecrets(this.redact(res.text)).replace(/\s+/g, ' ').slice(0, 300);
			} catch {
				why = '';
			}
			throw new StopError(`chatgpt.com answered ${s} – unexpected, so the sync stopped.${why ? ` Its explanation: ${why}` : ''}`);
		}
		return res;
	}
}
