// Reads what Lumo keeps about you, with the login of a Lumo account: your saved memories (those
// you wrote and those Lumo saved from chats), your personalization (how it addresses you, your
// work, its traits, extra context), your own custom agents, and each project's instructions.
// Reading only: nothing in Lumo is changed. Lumo keeps all but the project instructions in one
// encrypted settings record; the field names are those of Proton's published client
// (WebClients: applications/lumo/src/app/redux/slices/lumoUserSettingsTypes.ts, personalization.ts,
// seen 2026-11-27). A record in another shape stops the read, so nothing is half-saved.
// Pure code: the login, the requests and the decryption live in lumo/.

import { StopError } from '../api';
import type { LumoProjectInstructions } from '../lumo/chat';
import type { MemoryCapture, MemoryFile, MemoryPlace } from './types';

/** The part of Lumo this needs (a test hands in a fake). */
export interface MemoryLumoApi {
	/** The decrypted settings record, or null when the account has never saved one. */
	userSettings(): Promise<unknown>;
	/** Every project with instructions. */
	projects(): Promise<{ projects: LumoProjectInstructions[]; unreadable: number }>;
}

const plural = (n: number, noun: string, many = `${noun}s`) => `${n.toLocaleString('en')} ${n === 1 ? noun : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ODD = 'Lumo\'s settings came back in a form the plugin does not know. Nothing was saved.';
const pad = (n: number) => String(n).padStart(2, '0');
const day = (ms: number) => {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export interface LumoMemory {
	id: string;
	content: string;
	createdAt: number;
	/** Lumo saved it from a chat (not written by you in the settings). */
	fromChats: boolean;
}

/** The saved memories, newest first. Rows without text are left out; a list in another form stops the read. */
export function lumoMemories(settings: Record<string, unknown>): LumoMemory[] {
	const list = settings.memories;
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) throw new StopError(ODD);
	const out: LumoMemory[] = [];
	for (const row of list) {
		if (!isObject(row) || typeof row.content !== 'string' || !row.content.trim()) continue;
		out.push({
			id: typeof row.id === 'string' ? row.id : '',
			content: row.content,
			createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0,
			fromChats: row.source === 'generated',
		});
	}
	return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One memory per paragraph: "[date] text", "[date, from chats] text" for those Lumo saved itself. */
export function memoriesText(list: readonly LumoMemory[]): string {
	return list.map((m) => `[${m.createdAt ? day(m.createdAt) : 'no date'}${m.fromChats ? ', from chats' : ''}] ${m.content}`).join('\n\n');
}

/** Fields of the personalization that are long text, each under its own name. */
const LONG = ['lumoTraits', 'additionalContext'];

/** Your personalization: short settings as lines, longer text under its own name. Unset fields are left out. */
export function personalizationText(settings: Record<string, unknown>): { text: string; filled: number } {
	const p = settings.personalization;
	if (p === undefined || p === null) return { text: '', filled: 0 };
	if (!isObject(p)) throw new StopError(ODD);
	const head: string[] = [];
	const long: string[] = [];
	let filled = 0;
	for (const key of Object.keys(p).sort()) {
		const value = p[key];
		if (key === 'enableForNewChats') continue; // Proton's own note: never set, unused
		if (typeof value === 'string') {
			if (!value.trim() || (key === 'personality' && value === 'default')) continue;
			filled++;
			if (LONG.includes(key) || value.includes('\n')) long.push(`--- ${key} ---\n${value}`);
			else head.push(`${key}: ${value}`);
		} else if (Array.isArray(value)) {
			const words = value.filter((v): v is string => typeof v === 'string' && !!v.trim());
			if (!words.length) continue;
			filled++;
			head.push(`${key}: ${words.join(', ')}`);
		}
	}
	return { text: [head.join('\n'), ...long].filter(Boolean).join('\n\n'), filled };
}

/** Your own custom agents ("skills"): name, description, instructions. Shared and published ones are other people's. */
export function agentFiles(settings: Record<string, unknown>): MemoryFile[] {
	const list = settings.customAgents;
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) throw new StopError(ODD);
	const files: MemoryFile[] = [];
	const used = new Set<string>();
	for (const a of list) {
		if (!isObject(a) || a.source !== 'personal') continue;
		const instructions = typeof a.instructions === 'string' ? a.instructions : '';
		const description = typeof a.description === 'string' ? a.description : '';
		if (!instructions.trim() && !description.trim()) continue;
		const base = (typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'Agent').replace(/[\r\n/\\]+/g, ' ');
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
		used.add(name);
		const parts = [description.trim() ? `--- description ---\n${description}` : '', instructions.trim() ? `--- instructions ---\n${instructions}` : ''];
		files.push({ path: `/custom-agents/${name}`, lang: 'text', text: parts.filter(Boolean).join('\n\n') });
	}
	return files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Everything Lumo keeps about this account, read in one go. */
export async function captureLumo(api: MemoryLumoApi, account: string): Promise<MemoryCapture> {
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];

	const raw = await api.userSettings();
	if (raw !== null && !isObject(raw)) throw new StopError(ODD);
	const settings = raw ?? {};
	const memories = lumoMemories(settings);
	const fromChats = memories.filter((m) => m.fromChats).length;
	const switches = raw === null ? 'no settings saved yet'
		: `${settings.isMemoryEnabled === true ? 'on' : 'off'}${settings.isMemoryEnabled === true ? `, saving from chats ${settings.isMemoryAutoSaveEnabled === true ? 'on' : 'off'}` : ''}`;
	places.push({ name: 'memory', status: switches });
	places.push({ name: 'saved memories', status: memories.length ? `${plural(memories.length, 'memory', 'memories')}${fromChats ? `, ${fromChats} saved by Lumo from chats` : ''}` : 'none' });
	files.push({ path: '/saved-memories', lang: 'text', text: memoriesText(memories) });

	const personal = personalizationText(settings);
	places.push({ name: 'personalization', status: personal.filled ? `${plural(personal.filled, 'field')} with text` : 'nothing set' });
	files.push({ path: '/personalization', lang: 'text', text: personal.text });

	const agents = agentFiles(settings);
	places.push({ name: 'custom agents', status: agents.length ? plural(agents.length, 'agent') : 'none of your own' });
	files.push(...agents);

	const { projects, unreadable } = await api.projects();
	const open = projects.filter((p) => !p.private);
	places.push({ name: 'project instructions', status: open.length ? plural(open.length, 'project') : 'none' });
	if (projects.length > open.length) places.push({ name: 'skipped', status: `${plural(projects.length - open.length, 'private project')}` });
	if (unreadable) places.push({ name: 'not readable', status: plural(unreadable, 'project') });
	const names = new Set<string>();
	for (const p of open) {
		let name = p.name;
		for (let n = 2; names.has(name); n++) name = `${p.name} (${n})`;
		names.add(name);
		files.push({ path: `/projects/${name}/instructions`, lang: 'text', text: p.instructions });
	}

	return { provider: 'Lumo', account, source: 'web', home: 'lumo.proton.me', places, files, found: true };
}
