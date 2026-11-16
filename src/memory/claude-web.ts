// Reads what Claude keeps about you on claude.ai, with the login of a Claude account: its
// memory files (profile, topics, areas, people, and each project's own memory), your
// instructions for Claude, and the older single-text memory if the account still has one.
// Reading only: nothing on claude.ai is changed. The addresses and answer shapes were read
// from the settings page on 2026-11-16; an answer with another shape stops the read, so
// nothing is half-saved. Pure code: the login and the requests live in api.ts.

import { ACCOUNT_PROFILE, StopError, type MemoryRead } from '../api';
import { isUuid } from '../schema';
import type { MemoryCapture, MemoryFile, MemoryPlace } from './types';

/** The part of ClaudeApi this needs (a test hands in a fake). */
export interface MemoryClaudeApi {
	get(path: string): Promise<{ json: unknown }>;
	memory(method: MemoryRead, body: Record<string, string>): Promise<unknown>;
	projectNamesPath(uuids: string[]): string;
	readonly legacyMemoryPath: string;
}

const plural = (n: number, noun: string, many = `${noun}s`) => `${n.toLocaleString('en')} ${n === 1 ? noun : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A memory file's path as claude.ai gives it: "/profile.md", "/areas/x.md", "/projects/<project ID>/areas/x.md". */
const SAFE_PATH = /^\/(?:[^/\\\0]+\/)*[^/\\\0]+$/;
const isSafePath = (p: string): boolean => SAFE_PATH.test(p) && !p.split('/').includes('..') && p.length <= 400;
const isPrivate = (p: string): boolean => p.split('/').some((part) => part.toLowerCase() === 'private');
const PROJECT = /^\/projects\/([0-9a-f-]{36})\//;

/** The paths of every memory file, sorted. */
export function memoryPaths(json: unknown): string[] {
	if (!isObject(json) || !Array.isArray(json.data)) throw new StopError('claude.ai\'s list of memory files came back in a form the plugin does not know. Nothing was saved.');
	const paths: string[] = [];
	for (const row of json.data) {
		if (isObject(row) && typeof row.path === 'string' && isSafePath(row.path)) paths.push(row.path);
	}
	return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Project ID -> project name, from claude.ai's project list. */
export function projectNames(json: unknown): Map<string, string> {
	const names = new Map<string, string>();
	if (!Array.isArray(json)) return names;
	for (const p of json) {
		if (isObject(p) && typeof p.uuid === 'string' && typeof p.name === 'string' && p.name.trim()) names.set(p.uuid, p.name.trim().replace(/[\r\n/\\]+/g, ' '));
	}
	return names;
}

/** The heading for a memory file: its own path, with a project's ID replaced by the project's name where it is known. */
export function shownPath(path: string, names: Map<string, string>): string {
	const id = PROJECT.exec(path)?.[1];
	const name = id ? names.get(id) : undefined;
	return id && name ? `/projects/${name}/${path.slice(`/projects/${id}/`.length)}` : path;
}

/** Your instructions for Claude: each field that holds text, under its own name. */
export function instructionsText(json: unknown): { text: string; filled: number } {
	if (!isObject(json)) throw new StopError('claude.ai\'s account profile came back in a form the plugin does not know. Nothing was saved.');
	const parts: string[] = [];
	for (const key of ['conversation_preferences', 'cowork_global_instructions']) {
		const value = json[key];
		if (typeof value === 'string' && value.trim()) parts.push(`--- ${key} ---\n${value}`);
	}
	return { text: parts.join('\n\n'), filled: parts.length };
}

/**
 * Everything Claude keeps about this account, read in one go. `pause` runs between two file
 * reads, so a long list is not asked for in one burst.
 */
export async function captureClaude(api: MemoryClaudeApi, account: string, pause: () => Promise<void> = async () => undefined): Promise<MemoryCapture> {
	const places: MemoryPlace[] = [];
	const files: MemoryFile[] = [];

	const all = memoryPaths(await api.memory('list', {}));
	const paths = all.filter((p) => !isPrivate(p));
	const projectIds = [...new Set(paths.map((p) => PROJECT.exec(p)?.[1]).filter((id): id is string => !!id && isUuid(id)))];
	const names = projectIds.length ? projectNames((await api.get(api.projectNamesPath(projectIds))).json) : new Map<string, string>();

	for (const [i, path] of paths.entries()) {
		if (i) await pause();
		const answer = await api.memory('read', { path });
		if (!isObject(answer) || typeof answer.content !== 'string') throw new StopError(`claude.ai's memory file ${path} came back in a form the plugin does not know. Nothing was saved.`);
		files.push({ path: shownPath(path, names), lang: 'markdown', text: answer.content });
	}
	const inProjects = paths.filter((p) => PROJECT.test(p)).length;
	places.push({
		name: 'memory files',
		status: paths.length ? `${plural(paths.length, 'file')}${inProjects ? `, ${inProjects} of them in ${plural(projectIds.length, 'project')}` : ''}` : 'none',
	});
	if (all.length > paths.length) places.push({ name: 'skipped', status: `${plural(all.length - paths.length, 'file')} in a folder named Private` });

	const legacy = (await api.get(api.legacyMemoryPath)).json;
	const legacyText = isObject(legacy) && typeof legacy.memory === 'string' ? legacy.memory : '';
	if (legacyText.trim()) {
		places.push({ name: 'older memory text', status: 'found' });
		files.push({ path: '/memory (older, single text)', lang: 'markdown', text: legacyText });
	}

	const instructions = instructionsText((await api.get(ACCOUNT_PROFILE)).json);
	places.push({ name: 'instructions for Claude', status: instructions.filled ? plural(instructions.filled, 'field') + ' with text' : 'no text set' });
	files.push({ path: '/instructions-for-claude', lang: 'text', text: instructions.text });

	return { provider: 'Claude', account, source: 'web', home: 'claude.ai', places, files, found: true };
}
