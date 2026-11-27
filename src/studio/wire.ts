// Reading AI Studio's answers (Google's internal MakerSuiteService, JSON lists without field
// names). Positions below were read from live replies on 2026-11-10. Pure code, testable offline.

import { ShapeError } from '../schema';
import { isoFromStamp } from '../gemini/wire';
import type { StudioMessage, StudioPrompt } from '../gemini/types';
import type { ListItem } from '../types';

type List = unknown[];
const isList = (v: unknown): v is List => Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

const PROMPT_NAME = /^prompts\/[\w-]{10,100}$/;

/** "prompts/<Drive file ID>" -> the file ID, checked. */
export function promptFileId(name: string): string {
	if (!PROMPT_NAME.test(name)) throw new ShapeError('AI Studio prompt ID has an odd format');
	return name.slice('prompts/'.length);
}

/** A prompt's details: [0]=title, …, [4]=[[seconds, nanos] of the last change, …]. */
function details(row: List, where: string): { title: string; updated: string } {
	const meta = row[4];
	if (!isList(meta)) throw new ShapeError(`${where} has no details`);
	const changed = isList(meta[4]) ? meta[4][0] : undefined;
	return { title: str(meta[0]) && meta[0].trim() ? meta[0] : 'Untitled prompt', updated: isoFromStamp(changed, `${where} time`) };
}

/** One page of ListPrompts: [[row, …], nextPageToken?]. */
export function readPromptList(payload: unknown): { items: ListItem[]; next: string | null } {
	if (!isList(payload)) throw new ShapeError('AI Studio prompt list is not a list');
	const rows = payload[0] ?? [];
	if (!isList(rows)) throw new ShapeError('AI Studio prompt list has no rows');
	const items = rows.map((r, i): ListItem => {
		const where = `AI Studio prompt ${i}`;
		if (!isList(r) || !str(r[0])) throw new ShapeError(`${where} has no ID`);
		promptFileId(r[0]);
		const d = details(r, where);
		return { uuid: r[0], name: d.title, created_at: d.updated, updated_at: d.updated };
	});
	return { items, next: str(payload[1]) && payload[1] ? payload[1] : null };
}

/**
 * One message ("chunk"): [0]=text, [8]="user"/"model", [10]=[language, code] the model ran,
 * [11]=[outcome, output] of that code, [12]=[type, base64] a picture, [18]=tokens, [19]=1 for
 * thinking, [32]=[seconds, nanos]. (Code, output and pictures seen 2026-11-27.)
 */
function readChunk(c: unknown, i: number): StudioMessage {
	if (!isList(c)) throw new ShapeError(`AI Studio message ${i} is not a list`);
	const role = c[8];
	if (role !== 'user' && role !== 'model') throw new ShapeError(`AI Studio message ${i} has no role`);
	const m: StudioMessage = { role, text: str(c[0]) ? c[0] : '' };
	if (c[19] === 1 || c[19] === true) m.thought = true;
	if (typeof c[18] === 'number') m.tokens = c[18];
	if (isList(c[10]) && str(c[10][1])) m.code = { language: c[10][0] === 1 ? 'python' : 'text', text: c[10][1] };
	if (isList(c[11])) m.codeResult = str(c[11][1]) ? c[11][1] : '';
	if (isList(c[12]) && str(c[12][0]) && c[12][0].startsWith('image/') && str(c[12][1])) m.picture = { type: c[12][0], chunk: i };
	if (isList(c[32])) {
		try {
			m.createdAt = isoFromStamp(c[32], `AI Studio message ${i} time`);
		} catch {
			// a message without a time is still worth keeping
		}
	}
	return m;
}

/** ResolveDriveResource: [[name, …, [3]=run settings ([2]=model), [4]=details, …, [12]=system instructions, [13]=[[message, …]]]]. */
export function readPrompt(payload: unknown, expectedName: string): StudioPrompt {
	const p = isList(payload) ? payload[0] : undefined;
	if (!isList(p) || p[0] !== expectedName) throw new ShapeError('AI Studio answered with a different prompt');
	const d = details(p, 'AI Studio prompt');
	const chunks = isList(p[13]) && isList(p[13][0]) ? p[13][0] : [];
	const settings = isList(p[3]) ? p[3] : [];
	const system = isList(p[12]) ? p[12].find(str) : undefined;
	return {
		id: expectedName,
		title: d.title,
		updatedAt: d.updated,
		...(str(settings[2]) ? { model: settings[2] } : {}),
		...(system?.trim() ? { systemInstruction: system } : {}),
		messages: chunks.map(readChunk),
		raw: p,
	};
}

/** A picture's bytes from the prompt's raw row (base64 at [13][0][chunk][12][1]); null when not there. */
export function studioPictureBytes(raw: unknown, chunk: number): Uint8Array<ArrayBuffer> | null {
	const chunks = isList(raw) && isList(raw[13]) && isList(raw[13][0]) ? raw[13][0] : [];
	const c = chunks[chunk];
	const data = isList(c) && isList(c[12]) && str(c[12][1]) ? c[12][1] : '';
	if (!data) return null;
	try {
		const bin = atob(data);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}
