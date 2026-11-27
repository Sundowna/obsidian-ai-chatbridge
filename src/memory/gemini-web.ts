// Reads what Gemini keeps about you that the plugin can reach, with the login of a Google
// account: your own Gems (name, description and the instructions you gave each). Reading only:
// nothing in Gemini is changed. Gemini's call CNgdBe with [2, [lang], 0] lists your own Gems
// (3 = Google's pre-made ones, not saved); seen live on 2026-11-27. "Instructions for Gemini"
// (saved info) did not open for the test account, so it is not read and the note says so.
// Pure code: the login and the request live in gemini/api.ts.

import { StopError } from '../api';
import type { MemoryCapture, MemoryFile, MemoryPlace } from './types';

/** The part of GeminiApi this needs (a test hands in a fake). */
export interface MemoryGeminiApi {
	/** The payload of Gemini's list of your own Gems. */
	myGems(): Promise<unknown>;
}

export interface GeminiGem {
	id: string;
	name: string;
	description: string;
	instructions: string;
}

const ODD = 'Gemini\'s list of your Gems came back in a form the plugin does not know. Nothing was saved.';
const list = (v: unknown): v is unknown[] => Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const plural = (n: number, noun: string) => `${n.toLocaleString('en')} ${n === 1 ? noun : `${noun}s`}`;

/** Your Gems from the CNgdBe payload: [?, ?, [[id, [name, description, …], [instructions, …], …], …]]. Sorted by name. */
export function geminiGems(payload: unknown): GeminiGem[] {
	if (payload === null || payload === undefined) return [];
	if (!list(payload)) throw new StopError(ODD);
	const rows = payload[2];
	if (rows === null || rows === undefined) return [];
	if (!list(rows)) throw new StopError(ODD);
	const gems: GeminiGem[] = [];
	for (const row of rows) {
		if (!list(row) || typeof row[0] !== 'string' || !list(row[1])) throw new StopError(ODD);
		const about = row[1];
		const instructions = list(row[2]) ? text(row[2][0]) : '';
		gems.push({ id: row[0], name: text(about[0]).trim() || 'Gem', description: text(about[1]), instructions });
	}
	return gems.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

const isPrivate = (name: string): boolean => name.split(/\s+/).some((w) => w.toLowerCase() === 'private');

/** Everything Gemini keeps about this account that can be read, in one go. */
export async function captureGemini(api: MemoryGeminiApi, account: string): Promise<MemoryCapture> {
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];
	const all = geminiGems(await api.myGems());
	const gems = all.filter((g) => !isPrivate(g.name));
	places.push({ name: 'your Gems', status: gems.length ? plural(gems.length, 'Gem') : 'none' });
	if (all.length > gems.length) places.push({ name: 'skipped', status: `${plural(all.length - gems.length, 'Gem')} named Private` });
	places.push({ name: 'Instructions for Gemini', status: 'not read (Gemini does not offer them to the plugin)' });
	const used = new Set<string>();
	for (const g of gems) {
		const base = g.name.replace(/[\r\n/\\]+/g, ' ');
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
		used.add(name);
		const parts = [g.description.trim() ? `--- description ---\n${g.description}` : '', g.instructions.trim() ? `--- instructions ---\n${g.instructions}` : ''];
		files.push({ path: `/gems/${name}`, lang: 'text', text: parts.filter(Boolean).join('\n\n') });
	}
	return { provider: 'Gemini', account, source: 'web', home: 'gemini.google.com', places, files, found: true };
}
