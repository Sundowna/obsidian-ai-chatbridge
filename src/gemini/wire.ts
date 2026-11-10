// Reading Gemini's answers. gemini.google.com has no public API: its page calls Google's
// internal "batchexecute" endpoint, whose replies are nested lists without field names.
// Positions below were read from live replies on 2026-11-10. Pure code, testable offline.

import { ShapeError } from '../schema';
import type { GeminiChat, GeminiImage, GeminiListItem, GeminiTurn } from './types';

type List = unknown[];

const isList = (v: unknown): v is List => Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** Thrown when Google answers a call with an error instead of data (e.g. a deleted chat). */
export class GeminiError extends Error {
	constructor(readonly code: number | null, message: string) {
		super(message);
	}
}

/**
 * The payload of one call in a batchexecute reply. The reply starts with ")]}'" and then has
 * length-prefixed chunks, one JSON list per line; the data sits in a ["wrb.fr", rpcId, "<json>"] row.
 */
export function batchPayload(text: string, rpcId: string): unknown {
	if (!text.startsWith(")]}'")) throw new ShapeError('Gemini reply does not start the usual way');
	for (const line of text.split('\n')) {
		if (!line.startsWith('[')) continue;
		let rows: unknown;
		try {
			rows = JSON.parse(line);
		} catch {
			continue; // a chunk split over lines; the data row is always on one line
		}
		if (!isList(rows)) continue;
		for (const row of rows) {
			if (!isList(row) || row[0] !== 'wrb.fr' || row[1] !== rpcId) continue;
			if (str(row[2])) {
				try {
					return JSON.parse(row[2]);
				} catch {
					throw new ShapeError(`Gemini ${rpcId} data is not JSON`);
				}
			}
			throw errorOf(row[5], rpcId);
		}
	}
	throw new ShapeError(`Gemini reply has no ${rpcId} data`);
}

/** [5, null, [["type…BardErrorInfo", [1167, null, "Couldn't load conversation. (1167)"]]]] */
function errorOf(v: unknown, rpcId: string): GeminiError {
	const info = isList(v) && isList(v[2]) && isList(v[2][0]) && isList(v[2][0][1]) ? v[2][0][1] : null;
	const code = info && typeof info[0] === 'number' ? info[0] : null;
	const text = info && str(info[2]) ? info[2].slice(0, 160) : `${rpcId} failed`;
	return new GeminiError(code, text);
}

/** Seconds and nanoseconds, as Google sends times. */
export function isoFromStamp(v: unknown, what: string): string {
	if (!isList(v)) throw new ShapeError(`${what} is not a time`);
	const sec = Number(v[0]);
	const nanos = Number(v[1] ?? 0);
	if (!Number.isFinite(sec) || sec <= 0) throw new ShapeError(`${what} is not a time`);
	return new Date(sec * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1e6)).toISOString();
}

const CHAT_ID = /^c_[0-9a-f]{8,64}$/;

export function checkChatId(id: string): string {
	if (!CHAT_ID.test(id)) throw new ShapeError('Gemini chat ID has an odd format');
	return id;
}

/** One page of the chat list (MaZiqc): [null, nextCursor, [[id, title, …, [5]=last activity], …]]. */
export function readListPage(payload: unknown, pinned: boolean): { items: GeminiListItem[]; next: string | null } {
	if (!isList(payload)) throw new ShapeError('Gemini chat list is not a list');
	const rows = payload[2] ?? [];
	if (!isList(rows)) throw new ShapeError('Gemini chat list has no rows');
	const items = rows.map((r, i): GeminiListItem => {
		if (!isList(r) || !str(r[0])) throw new ShapeError(`Gemini chat list row ${i} has no ID`);
		const updated = isoFromStamp(r[5], `Gemini chat list row ${i} time`);
		return { uuid: checkChatId(r[0]), name: str(r[1]) && r[1].trim() ? r[1] : 'Untitled', created_at: updated, updated_at: updated, pinned };
	});
	return { items, next: str(payload[1]) && payload[1] ? payload[1] : null };
}

/** One page of a chat (hNvQHb): [[turn, …] newest first, nextCursor]. */
export function readChatPage(payload: unknown): { turns: List[]; next: string | null } {
	if (!isList(payload) || !isList(payload[0])) throw new ShapeError('Gemini chat has no turns');
	payload[0].forEach((t, i) => {
		if (!isList(t)) throw new ShapeError(`Gemini turn ${i} is not a list`);
	});
	return { turns: payload[0] as List[], next: str(payload[1]) && payload[1] ? payload[1] : null };
}

const at = (v: unknown, ...path: number[]): unknown => path.reduce<unknown>((x, i) => (isList(x) ? x[i] : undefined), v);
const webUrl = (v: unknown): string | undefined => (str(v) && /^https?:\/\//.test(v) ? v : undefined);

/**
 * Pictures in a candidate's [12][1]: [[[imageUrl], …], [[pageUrl], title, …, [5]=site], …, [7]=[".../image_agent_tag_…"]].
 * Anything unreadable is left out; the raw rows still have it.
 */
export function readImages(candidate: List): GeminiImage[] {
	const rows = at(candidate, 12, 1);
	if (!isList(rows)) return [];
	return rows.flatMap((r): GeminiImage[] => {
		const ref = at(r, 7, 0);
		const tag = str(ref) ? ref.split('/').pop() : undefined;
		if (!tag || !/^image_agent_tag_\w+$/.test(tag)) return [];
		const image: GeminiImage = { tag };
		const url = webUrl(at(r, 0, 0, 0));
		const page = webUrl(at(r, 1, 0, 0));
		const site = at(r, 1, 5);
		if (url) image.url = url;
		if (page) image.page = page;
		if (str(site) && site.trim()) image.site = site.trim();
		return [image];
	});
}

/**
 * One turn: [[chatId, turnId], …, [2]=your prompt, [3]=the answers, [4]=time].
 * [3] = [[candidate, …], …, [3]=the chosen candidate's ID, …, [21]=model name].
 * A candidate = [id, [text], …, [37]=[[reasoning]] when Gemini showed its thinking].
 */
export function readTurn(t: List, i: number): GeminiTurn {
	const where = `Gemini turn ${i}`;
	const ids = t[0];
	if (!isList(ids) || !str(ids[1])) throw new ShapeError(`${where} has no ID`);
	const prompt = isList(t[2]) && isList(t[2][0]) ? t[2][0][0] : undefined;
	if (!str(prompt)) throw new ShapeError(`${where} has no prompt text`);
	const answers = t[3];
	if (!isList(answers) || !isList(answers[0])) throw new ShapeError(`${where} has no answers`);
	const candidates = answers[0].filter(isList);
	const chosen = candidates.find((c) => c[0] === answers[3]) ?? candidates[0];
	const text = chosen && isList(chosen[1]) ? chosen[1][0] : undefined;
	const turn: GeminiTurn = {
		id: ids[1],
		createdAt: isoFromStamp(t[4], `${where} time`),
		prompt,
		answer: str(text) ? text : '',
	};
	const reasoning = chosen && isList(chosen[37]) && isList(chosen[37][0]) ? chosen[37][0][0] : undefined;
	if (str(reasoning) && reasoning.trim()) turn.reasoning = reasoning;
	if (str(answers[21]) && answers[21]) turn.model = answers[21];
	const images = chosen ? readImages(chosen) : [];
	if (images.length) turn.images = images;
	if (candidates.length > 1) turn.otherDrafts = candidates.length - 1;
	return turn;
}

/** The chat as saved: readable turns, oldest first, plus Google's own rows unchanged. */
export function buildChat(item: GeminiListItem, newestFirst: List[]): GeminiChat {
	const raw = [...newestFirst].reverse();
	const turns = raw.map(readTurn);
	return {
		id: item.uuid,
		title: item.name,
		...(item.pinned ? { pinned: true } : {}),
		createdAt: turns[0]?.createdAt ?? item.updated_at,
		updatedAt: item.updated_at,
		turns,
		raw,
	};
}
