// The ONLY place that talks to the network.
// Rules: https://claude.ai only, no retries, stop on anything odd.
// GET for the REST addresses (claude.ai/api/organizations/<org>/… and the Claude Code
// session list claude.ai/v1/code/sessions…); POST only to the READ methods of claude.ai's
// ConversationService (allowlist below) and to the two READ methods of its memory store
// (list, read) – never to anything that changes data.

import { requestUrl, RequestUrlResponse } from 'obsidian';
import { NetworkFailure, sendWithRetry, triedText } from './net-retry';
import { isUuid } from './schema';
import { isOutputPath } from './files';
import { recordAnswer, recordError, type ErrorSource } from './error-log';
import { loginWindowRequest } from './transport/login-window';
import type { Transport } from './transport/types';

/** What to say when a request got no answer, with how often it was tried. */
function networkWhy(e: unknown, key: string): string {
	const cause = e instanceof NetworkFailure ? e.cause : e;
	return `Network error: ${redact(cause instanceof Error ? cause.message : String(cause), key)}${e instanceof NetworkFailure ? triedText(e.tries) : ''}`;
}

export class StopError extends Error {}

const ORIGIN = 'https://claude.ai';
/** The headers that carry the login window's login. */
const LOGIN_HEADERS = ['Cookie'] as const;

/** Removes the session key from any text before it is shown or logged. */
export function redact(text: string, key: string | null): string {
	let t = text.replace(/sessionKey=[^;\s"']+/gi, 'sessionKey=[hidden]');
	if (key) t = t.split(key).join('[hidden]');
	return t;
}

function header(headers: Record<string, string>, name: string): string {
	const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
	return k ? (headers[k] ?? '') : '';
}

const RPC_BASE = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/';
/** Read-only RPC methods (names from claude.ai's own service definition). */
export const READ_RPCS = ['ReadConversation', 'ReadConversationHistory'] as const;
export type ReadRpc = (typeof READ_RPCS)[number];

/** claude.ai keeps memory as files in a store its page calls "melange". These two methods only read. */
export const MEMORY_READS = ['list', 'read'] as const;
export type MemoryRead = (typeof MEMORY_READS)[number];
/** Your instructions for Claude (profile preferences); belongs to the login, not to one organization. */
export const ACCOUNT_PROFILE = '/api/account_profile';

export interface RpcAnswer {
	status: number;
	contentType: string;
	bytes: ArrayBuffer;
	text: string;
}

export interface RawJson {
	/** Exact bytes claude.ai sent (after HTTP decompression) – saved unchanged. */
	bytes: ArrayBuffer;
	json: unknown;
}

/** Claude Code session IDs on claude.ai ("cse_…"). */
const CODE_SESSION_ID = /^cse_[A-Za-z0-9]+$/;
const CODE_SESSIONS = '/v1/code/sessions';
/** Every status the claude.ai Code page asks for, so archived and failed sessions are listed too. */
const CODE_STATUSES = ['active', 'paused', 'failed', 'archived'];

/**
 * "Test mobile connection" only: one GET of claude.ai/api/organizations with the session key.
 * The answer comes back whole and unjudged, in memory; the caller reads the status and type
 * and never shows the text.
 */
export async function probeOrganizations(key: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
	let res;
	try {
		res = await requestUrl({ url: `${ORIGIN}/api/organizations`, method: 'GET', headers: { Cookie: `sessionKey=${key}`, Accept: 'application/json' }, throw: false });
	} catch (e) {
		throw new Error(`Network error: ${redact(e instanceof Error ? e.message : String(e), key)}`);
	}
	let text = '';
	try {
		text = res.text;
	} catch {
		text = '';
	}
	return { status: res.status, headers: res.headers, text };
}

/**
 * A 403 from ReadConversation that says the call is not offered for this account's plan
 * (code "permission_denied", reason "feature_not_available" / "blocked_by_org_tier"), as
 * opposed to a refused login. Seen 2026-11-25 (issue #46).
 */
export function chatViewNotOffered(text: string): boolean {
	return /blocked_by_org_tier|feature_not_available/.test(text);
}

export class ClaudeApi {
	/**
	 * True once claude.ai said ReadConversation is not offered for this account (403 with
	 * "feature not available"). Then the chat view is not asked for again in this run.
	 */
	chatViewUnavailable = false;

	constructor(
		private readonly orgId: string,
		private readonly getKey: () => string | null,
		/** The account, so failed answers land in its error log. */
		private readonly source?: ErrorSource,
		/** How requests reach claude.ai (the account's transport); the login window's by default. */
		private readonly transport: Pick<Transport, 'request'> = { request: loginWindowRequest },
	) {
		if (!isUuid(orgId)) throw new StopError('Organization ID is missing or not a valid ID. Set it in the plugin settings.');
	}

	/** One page of the chat list: the normal chats, or with `archived` the archived ones. */
	listPath(offset: number, archived = false): string {
		return `/api/organizations/${this.orgId}/chat_conversations_v2?limit=30&offset=${offset}&archived=${archived}&consistency=strong`;
	}

	chatPath(uuid: string): string {
		if (!isUuid(uuid)) throw new StopError('Refusing to fetch: chat ID has an odd format.');
		return `/api/organizations/${this.orgId}/chat_conversations/${uuid}?tree=True&rendering_mode=messages`;
	}

	/** One page of the Claude Code sessions listed on claude.ai/code, newest first. */
	codeSessionsPath(cursor?: string): string {
		const q = CODE_STATUSES.map((st) => `statuses=${st}`).join('&');
		return `${CODE_SESSIONS}?${q}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
	}

	/** One page of a Claude Code session's events, newest first. */
	codeEventsPath(sessionId: string, cursor?: string): string {
		if (!CODE_SESSION_ID.test(sessionId)) throw new StopError('Refusing to fetch: Claude Code session ID has an odd format.');
		return `${CODE_SESSIONS}/${sessionId}/events?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
	}

	filePath(fileUuid: string): string {
		if (!isUuid(fileUuid)) throw new StopError('Refusing to fetch: file ID has an odd format.');
		return `/api/organizations/${this.orgId}/files/${fileUuid}/contents`;
	}

	/** The chat JSON with every tool call drawn in (the plain one leaves them out). */
	chatWithToolsPath(uuid: string): string {
		return `${this.chatPath(uuid)}&render_all_tools=true`;
	}

	/** A Claude-made file by its path in the chat's file store (what the chat view's download card asks for). */
	outputFilePath(chatUuid: string, path: string): string {
		if (!isUuid(chatUuid)) throw new StopError('Refusing to fetch: chat ID has an odd format.');
		if (!isOutputPath(path)) throw new StopError('Refusing to fetch: file path has an odd format.');
		return `/api/organizations/${this.orgId}/conversations/${chatUuid}/wiggle/download-file?path=${encodeURIComponent(path)}`;
	}

	/**
	 * The chat JSON with its tool calls, or null if claude.ai would not give it (any status
	 * but 200 JSON; 401 and 429 still stop the sync). Only asked for when the chat view is
	 * not offered for the account (issue #46).
	 */
	async chatWithTools(uuid: string): Promise<unknown> {
		const res = await this.request(this.chatWithToolsPath(uuid), 'application/json', 'soft');
		if (res.status !== 200) return null;
		try {
			return JSON.parse(res.text) as unknown;
		} catch {
			return null;
		}
	}

	/**
	 * A Claude-made file's bytes by its path. status 404 = no longer there; any other status
	 * but 200 = not now (tried again next run). 401 and 429 still stop the sync.
	 */
	async getOutputFile(chatUuid: string, path: string): Promise<{ status: number; bytes: ArrayBuffer | null }> {
		const res = await this.request(this.outputFilePath(chatUuid, path), '*/*', 'soft');
		return { status: res.status, bytes: res.status === 200 ? res.arrayBuffer : null };
	}

	/**
	 * A file's exact bytes (any type), or null if claude.ai says 404 (file no longer there).
	 * Every other problem still stops the sync.
	 */
	async getFile(fileUuid: string): Promise<ArrayBuffer | null> {
		const res = await this.request(this.filePath(fileUuid), '*/*', true);
		return res ? res.arrayBuffer : null;
	}

	/** JSON answer, checked to really be JSON. */
	async get(path: string): Promise<RawJson> {
		const res = await this.request(path, 'application/json', false);
		const ct = header(res.headers, 'content-type');
		if (!ct.includes('application/json')) {
			recordAnswer(this.source, 'claude.ai', 'GET', new URL(path, ORIGIN).toString(), res, `expected JSON, got "${ct || 'unknown type'}"`, [this.getKey()]);
			throw new StopError(`Expected JSON but got "${ct || 'unknown type'}" (maybe a Cloudflare check page).`);
		}
		let json: unknown;
		try {
			json = JSON.parse(res.text);
		} catch {
			recordAnswer(this.source, 'claude.ai', 'GET', new URL(path, ORIGIN).toString(), res, 'answer was not valid JSON', [this.getKey()]);
			throw new StopError('claude.ai\'s answer was not valid JSON.');
		}
		return { bytes: res.arrayBuffer, json };
	}

	/**
	 * POST to a READ method of claude.ai's ConversationService (Connect protocol, unary).
	 * `json` sends application/json, `proto` sends binary protobuf. The status is returned
	 * as-is (the caller decides); only the allowlisted read methods can be called.
	 */
	async rpc(method: ReadRpc, body: string | Uint8Array): Promise<RpcAnswer> {
		if (!(READ_RPCS as readonly string[]).includes(method)) throw new StopError('Blocked: not a read-only RPC method.');
		const key = this.getKey();
		if (!key) throw new StopError('Not logged in to claude.ai. Use \'Log in to claude.ai\' in the plugin settings.');
		const isJson = typeof body === 'string';
		const payload = isJson ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
		let res;
		try {
			res = await sendWithRetry(() => this.transport.request({
				url: `${ORIGIN}${RPC_BASE}${method}`,
				method: 'POST',
				contentType: isJson ? 'application/json' : 'application/proto',
				body: payload as string | ArrayBuffer,
				headers: {
					Cookie: `sessionKey=${key}; lastActiveOrg=${this.orgId}`,
					Accept: isJson ? 'application/json' : 'application/proto',
					'Connect-Protocol-Version': '1',
					'anthropic-client-platform': 'web_claude_ai',
				},
				loginOnly: LOGIN_HEADERS,
			}));
		} catch (e) {
			const why = networkWhy(e, key);
			recordError(this.source, { service: 'claude.ai', method: 'POST', url: `${ORIGIN}${RPC_BASE}${method}`, status: null, message: why, secrets: [key] });
			throw new StopError(why);
		}
		if (res.status !== 200) recordAnswer(this.source, 'claude.ai', 'POST', `${ORIGIN}${RPC_BASE}${method}`, res, `${method} answered ${res.status}`, [key]);
		let text = '';
		try {
			text = res.text;
		} catch {
			text = '';
		}
		return { status: res.status, contentType: header(res.headers, 'content-type'), bytes: res.arrayBuffer, text: redact(text, key) };
	}

	/**
	 * The chat as claude.ai's chat view sees it (incl. download cards), as JSON.
	 * Returns null if claude.ai answers anything but 200 JSON; 401/403/429 stop the sync.
	 */
	async readConversation(uuid: string): Promise<unknown> {
		if (!isUuid(uuid)) throw new StopError('Refusing to fetch: chat ID has an odd format.');
		if (this.chatViewUnavailable) return null;
		const r = await this.rpc('ReadConversation', JSON.stringify({ conversationId: uuid, displayLanguage: 'en' }));
		if (r.status === 401) throw new StopError('claude.ai answered 401 (not logged in). The login has probably expired – log in again in the plugin settings.');
		if (r.status === 403 && chatViewNotOffered(r.text)) {
			// Some account plans (e.g. "blocked_by_org_tier") do not get this call at all (issue #46).
			// The chat itself still comes from the normal API, so skip the chat-view files and go on.
			this.chatViewUnavailable = true;
			return null;
		}
		if (r.status === 403) throw new StopError('claude.ai answered 403 (forbidden) to ReadConversation.');
		if (r.status === 429) throw new StopError('claude.ai answered 429 (too many requests). Wait a while before syncing again.');
		if (r.status !== 200 || !r.contentType.includes('application/json')) return null;
		try {
			return JSON.parse(r.text) as unknown;
		} catch {
			return null;
		}
	}

	/** The memory files of this account's projects are named by project ID; this asks for the projects' names. */
	projectNamesPath(uuids: string[]): string {
		if (!uuids.every(isUuid)) throw new StopError('Refusing to fetch: project ID has an odd format.');
		return `/api/organizations/${this.orgId}/projects?include_harmony_projects=true&limit=100${uuids.map((u) => `&uuids=${u}`).join('')}`;
	}

	/** The older, single-text memory of this account (empty on accounts that have memory files). */
	get legacyMemoryPath(): string {
		return `/api/organizations/${this.orgId}/memory`;
	}

	/**
	 * POST to a READ method of claude.ai's memory store: "list" (every memory file) or "read"
	 * (one file by its path). Only these two can be called; both change nothing.
	 */
	async memory(method: MemoryRead, body: Record<string, string>): Promise<unknown> {
		if (!(MEMORY_READS as readonly string[]).includes(method)) throw new StopError('Blocked: not a read-only memory method.');
		const key = this.getKey();
		if (!key) throw new StopError('Not logged in to claude.ai. Use \'Log in to claude.ai\' in the plugin settings.');
		let res;
		try {
			res = await sendWithRetry(() => this.transport.request({
				url: `${ORIGIN}/api/organizations/${this.orgId}/melange/${method}`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify(body),
				headers: { Cookie: `sessionKey=${key}; lastActiveOrg=${this.orgId}`, Accept: 'application/json', 'anthropic-client-platform': 'web_claude_ai' },
				loginOnly: LOGIN_HEADERS,
			}));
		} catch (e) {
			const why = networkWhy(e, key);
			recordError(this.source, { service: 'claude.ai', method: 'POST', url: `${ORIGIN}/api/organizations/${this.orgId}/melange/${method}`, status: null, message: why, secrets: [key] });
			throw new StopError(why);
		}
		const s = res.status;
		if (s !== 200) recordAnswer(this.source, 'claude.ai', 'POST', `${ORIGIN}/api/organizations/${this.orgId}/melange/${method}`, res, `reading memory answered ${s}`, [key]);
		if (s === 401) throw new StopError('claude.ai answered 401 (not logged in). The login has probably expired – log in again in the plugin settings.');
		if (s === 403) throw new StopError('claude.ai answered 403 (forbidden) to reading memory.');
		if (s === 429) throw new StopError('claude.ai answered 429 (too many requests). Wait a while before syncing again.');
		if (s !== 200) throw new StopError(`claude.ai answered ${s} to reading memory – unexpected, so the sync stopped.`);
		try {
			return JSON.parse(res.text) as unknown;
		} catch {
			recordAnswer(this.source, 'claude.ai', 'POST', `${ORIGIN}/api/organizations/${this.orgId}/melange/${method}`, res, 'memory answer was not valid JSON', [key]);
			throw new StopError('claude.ai\'s memory answer was not valid JSON.');
		}
	}

	/**
	 * Diagnostics only: GET a path and return status + text without judging it.
	 * Same guard (claude.ai/api/organizations/<org>/ only) and same 401/403/429 stops.
	 */
	async probe(path: string): Promise<{ status: number; contentType: string; text: string }> {
		const res = await this.request(path, 'application/json', 'any');
		return { status: res.status, contentType: header(res.headers, 'content-type'), text: res.text };
	}

	/**
	 * The single GET used by everything above. Stops on anything but 200 (and 404 if allowed).
	 * 'any' (diagnostics) and 'soft' (optional extras) hand back the answer instead; both still
	 * stop on 401 and 429, 'any' also on 403. 'soft' records every answer but 200 and 404.
	 */
	private async request(path: string, accept: string, notFoundOk: 'any' | 'soft'): Promise<RequestUrlResponse>;
	private async request(path: string, accept: string, notFoundOk: true): Promise<RequestUrlResponse | null>;
	private async request(path: string, accept: string, notFoundOk: false): Promise<RequestUrlResponse>;
	private async request(path: string, accept: string, notFoundOk: boolean | 'any' | 'soft'): Promise<RequestUrlResponse | null> {
		const url = new URL(path, ORIGIN);
		// Safety guard: never anything but claude.ai/api/organizations/<your org>/...,
		// the Claude Code session list (claude.ai/v1/code/sessions…) or the account profile, and only GET.
		const code = url.pathname === CODE_SESSIONS || url.pathname.startsWith(`${CODE_SESSIONS}/`);
		const profile = url.pathname === ACCOUNT_PROFILE && !url.search;
		if (url.origin !== ORIGIN || !(code || profile || url.pathname.startsWith(`/api/organizations/${this.orgId}/`))) {
			throw new StopError('Blocked a request that was not for claude.ai/api/organizations/<your org>/ or claude.ai/v1/code/sessions.');
		}
		const key = this.getKey();
		if (!key) throw new StopError('Not logged in to claude.ai. Use \'Log in to claude.ai\' in the plugin settings.');
		// The Claude Code addresses want the API version and the organization as headers.
		const headers: Record<string, string> = code
			? { Cookie: `sessionKey=${key}; lastActiveOrg=${this.orgId}`, Accept: accept, 'anthropic-version': '2023-06-01', 'x-organization-uuid': this.orgId }
			: { Cookie: `sessionKey=${key}`, Accept: accept };

		let res;
		try {
			res = await sendWithRetry(() => this.transport.request({
				url: url.toString(),
				method: 'GET',
				headers,
				loginOnly: LOGIN_HEADERS,
			}));
		} catch (e) {
			const why = networkWhy(e, key);
			recordError(this.source, { service: 'claude.ai', method: 'GET', url: url.toString(), status: null, message: why, secrets: [key] });
			throw new StopError(why);
		}

		const s = res.status;
		const accepted = s === 200 || (s === 404 && (notFoundOk === true || notFoundOk === 'soft')) || (notFoundOk === 'any' && s !== 401 && s !== 403 && s !== 429);
		if (!accepted) recordAnswer(this.source, 'claude.ai', 'GET', url.toString(), res, `claude.ai answered ${s}`, [key]);
		if (s === 401) throw new StopError('claude.ai answered 401 (not logged in). The login has probably expired – log in again in the plugin settings.');
		if (s === 403 && notFoundOk !== 'soft') throw new StopError('claude.ai answered 403 (forbidden). Session key expired, or claude.ai/Cloudflare blocked the request.');
		if (s === 429) throw new StopError('claude.ai answered 429 (too many requests). Wait a while before syncing again.');
		if (notFoundOk === 'any' || notFoundOk === 'soft') return res; // caller looks at the status
		if (s === 404 && notFoundOk) return null;
		if (s !== 200) throw new StopError(`claude.ai answered ${s} – unexpected, so the sync stopped.`);
		return res;
	}
}
