// Reads what ChatGPT keeps about you from chatgpt.com, with the login of a ChatGPT account:
// the memory summary, the saved memories and the custom instructions. Reading only: nothing
// on chatgpt.com is changed. The addresses and answer shapes were read from the settings page
// on 2026-11-16; an answer with another shape stops the read, so nothing is half-saved.
// Pure code: the login and the requests live in chatgpt/api.ts.

import { StopError } from '../api';
import type { MemoryCapture, MemoryFile, MemoryPlace } from './types';

/** The part of GptApi this needs (a test hands in a fake). */
export interface MemoryGptApi {
	get(path: string): Promise<{ json: unknown }>;
	memorySummaryStream(): Promise<string>;
}

export const SAVED_MEMORIES_PATH = '/backend-api/memories?include_memory_entries=true';
export const INSTRUCTIONS_PATH = '/backend-api/user_system_messages';

const plural = (n: number, noun: string, many = `${noun}s`) => `${n.toLocaleString('en')} ${n === 1 ? noun : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SummarySection {
	id: string;
	title: string;
	description: string;
}

function asSection(v: unknown): SummarySection | null {
	if (!isObject(v) || typeof v.title !== 'string') return null;
	return { id: typeof v.id === 'string' ? v.id : v.title, title: v.title, description: typeof v.description === 'string' ? v.description : '' };
}

/**
 * The sections of a memory summary stream. The stream is a list of events ("event: name",
 * "data: JSON"); the last one, "done", repeats every section, so that one is used. If it is
 * missing, the single "section" events are put together instead.
 */
export function parseSummaryStream(stream: string): SummarySection[] {
	const single: SummarySection[] = [];
	let done: SummarySection[] | null = null;
	let sawEvent = false;
	for (const block of stream.split(/\r?\n\r?\n/)) {
		const name = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
		const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
		if (!name || !data) continue;
		let json: unknown;
		try {
			json = JSON.parse(data);
		} catch {
			continue;
		}
		if (!isObject(json)) continue;
		sawEvent = true;
		if (name === 'done' && Array.isArray(json.sections)) done = json.sections.map(asSection).filter((s): s is SummarySection => s !== null);
		else if (name === 'section') {
			const s = asSection(json.section);
			if (s) single.push(s);
		}
	}
	if (!sawEvent) throw new StopError('ChatGPT\'s memory summary came back in a form the plugin does not know. Nothing was saved.');
	return done ?? single;
}

/** The summary as text: ChatGPT's own section titles as headings, its text below. Sections without text (its "Dive deeper" prompts) are left out. */
export function summaryText(sections: SummarySection[]): string {
	return sections.filter((s) => s.description.trim()).map((s) => `## ${s.title}\n\n${s.description}`).join('\n\n');
}

interface SavedMemory {
	id: string;
	content: string;
	date: string;
	created: number;
}

/** Saved memories, newest first. The "status" ChatGPT keeps per memory is left out: it changes without the memory changing. */
export function savedMemories(json: unknown): SavedMemory[] {
	if (!isObject(json) || !Array.isArray(json.memories)) throw new StopError('ChatGPT\'s saved memories came back in a form the plugin does not know. Nothing was saved.');
	const out: SavedMemory[] = [];
	for (const m of json.memories) {
		if (!isObject(m) || typeof m.content !== 'string') continue;
		out.push({
			id: typeof m.id === 'string' ? m.id : '',
			content: m.content,
			date: typeof m.updated_at === 'string' ? m.updated_at : '',
			created: typeof m.created_timestamp === 'number' ? m.created_timestamp : 0,
		});
	}
	return out.sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const savedText = (list: SavedMemory[]): string => list.map((m) => `${m.date ? `[${m.date}] ` : ''}${m.content}`).join('\n\n');

/** Custom instructions: every field that holds text under its own name, short settings as "name: value" lines. */
export function instructionsText(json: unknown): { text: string; filled: number } {
	if (!isObject(json)) throw new StopError('ChatGPT\'s custom instructions came back in a form the plugin does not know. Nothing was saved.');
	const head: string[] = [];
	const long: string[] = [];
	for (const key of Object.keys(json).sort()) {
		const value = json[key];
		if (key === 'object' || value === null || value === undefined || value === '') continue;
		if (key.endsWith('_message') && typeof value === 'string') long.push(`--- ${key} ---\n${value}`);
		else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') head.push(`${key}: ${String(value)}`);
		else if ((Array.isArray(value) && value.length) || (isObject(value) && Object.keys(value).length)) head.push(`${key}: ${JSON.stringify(value)}`);
	}
	return { text: [head.join('\n'), ...long].filter(Boolean).join('\n\n'), filled: long.length };
}

/** Everything ChatGPT keeps about this account, read in one go. */
export async function captureChatgpt(api: MemoryGptApi, account: string): Promise<MemoryCapture> {
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];

	const sections = parseSummaryStream(await api.memorySummaryStream());
	const summary = summaryText(sections);
	const shown = sections.filter((s) => s.description.trim()).length;
	places.push({ name: 'memory summary', status: shown ? plural(shown, 'section') : 'empty' });
	files.push({ path: '/memory-summary', lang: 'markdown', text: summary });

	const saved = savedMemories((await api.get(SAVED_MEMORIES_PATH)).json);
	places.push({ name: 'saved memories', status: saved.length ? plural(saved.length, 'memory', 'memories') : 'none' });
	files.push({ path: '/saved-memories', lang: 'text', text: savedText(saved) });

	const instructions = instructionsText((await api.get(INSTRUCTIONS_PATH)).json);
	places.push({ name: 'custom instructions', status: instructions.filled ? plural(instructions.filled, 'field') + ' with text' : 'no text set' });
	files.push({ path: '/custom-instructions', lang: 'text', text: instructions.text });

	return { provider: 'ChatGPT', account, source: 'web', home: 'chatgpt.com', places, files, found: true };
}
