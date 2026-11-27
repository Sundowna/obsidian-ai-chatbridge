// Messages between the plugin and the browser extension: JSON text frames over a WebSocket on
// 127.0.0.1. Bodies travel as base64; a large answer body comes in parts so no single frame
// gets huge. Shared by both sides: plain data and pure functions only.

import type { PageCall, PageAnswer, PageValue, ReadyCheck } from '../transport/types';

/** Raw bytes per part of an answer body (base64 makes a frame about a third larger). */
export const PART_BYTES = 512 * 1024;
/** Largest frame either side accepts. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Largest answer body put back together (a file download). */
export const MAX_BODY_BYTES = 200 * 1024 * 1024;

// ---- Before the link is trusted ---------------------------------------------------------

/** First frame from the extension: its saved token, or a one-time pairing code. */
export type Hello = { op: 'hello'; token: string; agent?: string } | { op: 'pair'; code: string; agent?: string };
/** The plugin's answer to a good hello (`welcome`) or pairing (`paired`, with the token to keep). */
export type Welcome = { op: 'welcome' } | { op: 'paired'; token: string };

// ---- Requests from the plugin -------------------------------------------------------------

export interface FetchRequest {
	op: 'fetch';
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body64?: string;
	redirect?: 'follow' | 'manual';
}
export interface OpenRequest { op: 'open'; url: string; ready: ReadyCheck; timeoutMs: number }
export interface CallRequest { op: 'call'; page: string; call: PageCall }
export interface ReadRequest { op: 'read'; page: string; value: PageValue }
export interface CloseRequest { op: 'close'; page: string }
export interface StatusRequest { op: 'status'; site: string }
export type LinkRequest = FetchRequest | OpenRequest | CallRequest | ReadRequest | CloseRequest | StatusRequest;

// ---- Answers from the extension ------------------------------------------------------------

export type LinkErrorKind = 'not-allowed' | 'no-tab' | 'not-logged-in' | 'timeout' | 'blocked' | 'failed';
export interface LinkFailure { id: number; ok: false; error: { kind: LinkErrorKind; message: string } }
/** A fetch answer: the head carries part 0 and says how many parts follow. */
export interface FetchHead { id: number; ok: true; status: number; headers: Record<string, string>; parts: number; body64: string }
export interface FetchPart { id: number; part: number; body64: string }
export interface OpenAnswer { id: number; ok: true; page: string }
export interface CallAnswer { id: number; ok: true; answer: PageAnswer }
export interface ReadAnswer { id: number; ok: true; value: string }
export interface StatusAnswer { id: number; ok: true; tabOpen: boolean }
export interface EmptyAnswer { id: number; ok: true }

/** What a fetch gives back once all its parts are in. */
export interface FetchResult { status: number; headers: Record<string, string>; body: Uint8Array }

// ---- base64, binary-safe, without Node's Buffer (the extension has none) --------------------

export function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

/** An answer body cut into base64 parts (at least one, maybe empty). */
export function splitBody(bytes: Uint8Array): string[] {
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += PART_BYTES) parts.push(toBase64(bytes.subarray(i, i + PART_BYTES)));
	return parts.length ? parts : [''];
}

/** The frames the extension sends for one fetch answer. */
export function fetchFrames(id: number, status: number, headers: Record<string, string>, body: Uint8Array): (FetchHead | FetchPart)[] {
	const parts = splitBody(body);
	return parts.map((body64, part) => (part === 0 ? { id, ok: true as const, status, headers, parts: parts.length, body64 } : { id, part, body64 }));
}

/** Puts a fetch answer back together, part by part. */
export class BodyAssembler {
	private readonly got: (Uint8Array | undefined)[];
	private size = 0;
	private received = 0;
	/** The whole answer when the head was its only part. */
	readonly complete: FetchResult | null;

	constructor(private readonly head: FetchHead) {
		if (!Number.isInteger(head.parts) || head.parts < 1 || head.parts > Math.ceil(MAX_BODY_BYTES / PART_BYTES)) throw new Error('bad part count');
		this.got = new Array<Uint8Array | undefined>(head.parts);
		this.complete = this.add({ id: head.id, part: 0, body64: head.body64 });
	}

	/** Adds a part; returns the whole answer once the last one is in. */
	add(p: FetchPart): FetchResult | null {
		if (!Number.isInteger(p.part) || p.part < 0 || p.part >= this.got.length || this.got[p.part]) throw new Error('bad or repeated part');
		const bytes = fromBase64(p.body64);
		this.size += bytes.length;
		if (this.size > MAX_BODY_BYTES) throw new Error('answer too large');
		this.got[p.part] = bytes;
		// Count, not `some`: a new array's empty slots are skipped by `some`.
		if (++this.received < this.got.length) return null;
		const body = new Uint8Array(this.size);
		let at = 0;
		for (const b of this.got as Uint8Array[]) {
			body.set(b, at);
			at += b.length;
		}
		return { status: this.head.status, headers: this.head.headers, body };
	}
}
