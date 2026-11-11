// Decides which chats to fetch. Pure functions, testable offline.

import type { IndexEntry, ListItem } from './types';
import { safeTitle } from './naming';

/** Default folder name for chats without a project (claude.ai lists them under Recents). */
export const DEFAULT_RECENT = 'Recent';

/** The picker's saved entry for chats without a project; survives renaming the Recent folder. */
export const NO_PROJECT = ':no-project';

/** "Only selected projects" is on and nothing is selected, so there is nothing to sync. */
export function nothingSelected(o: { onlyProjects: boolean; projects: string[] }): boolean {
	return o.onlyProjects && !o.projects.some((p) => p.trim());
}

/**
 * Keep only chats whose project name or project uuid is in `projects`.
 * Listing the Recent folder name (e.g. "Recent") or NO_PROJECT keeps chats without a project.
 */
export function filterByProjects(items: ListItem[], projects: string[], recentName = DEFAULT_RECENT): ListItem[] {
	const wanted = new Set(projects.map((p) => p.trim().toLowerCase()).filter(Boolean));
	if (wanted.size === 0) return items;
	const wantRecent = wanted.has(recentName.trim().toLowerCase()) || wanted.has(NO_PROJECT);
	return items.filter((it) => {
		const p = it.project;
		if (!p) return wantRecent;
		return wanted.has(p.name.trim().toLowerCase()) || wanted.has(p.uuid.toLowerCase());
	});
}

export interface Todo {
	item: ListItem;
	isUpdate: boolean;
}

/** New chats and chats whose updated_at changed since the last sync; newest first. */
export function pickTodo(items: ListItem[], index: Record<string, IndexEntry>): Todo[] {
	const todo: Todo[] = [];
	for (const item of items) {
		const known = index[item.uuid];
		if (!known) todo.push({ item, isUpdate: false });
		else if (known.updated_at !== item.updated_at) todo.push({ item, isUpdate: true });
	}
	return newestFirst(todo);
}

/** Newest change first, so a limited or stopped run has saved what you worked on last. */
export function newestFirst<T extends { item: { updated_at: string } }>(jobs: T[]): T[] {
	const at = (t: T) => Date.parse(t.item.updated_at) || 0;
	return jobs.sort((a, b) => at(b) - at(a));
}

export type Target = 'chat' | 'code';

/**
 * Which folder a chat goes to. claude.ai marks normal chats with
 * platform "CLAUDE_AI" (seen in DevTools). A missing platform counts as chat;
 * any other value goes to the Claude Code folder and is named in the log.
 */
export function targetFor(item: ListItem): Target {
	const p = item.platform;
	return !p || p === 'CLAUDE_AI' ? 'chat' : 'code';
}

/**
 * Subfolder that mirrors where the chat sits in claude.ai's sidebar:
 * its project (e.g. "2nd Brain"), or the Recent folder for chats without a project.
 */
export function projectSubfolder(item: ListItem, recentName = DEFAULT_RECENT): string {
	return item.project?.name ? safeTitle(item.project.name) : safeTitle(recentName || DEFAULT_RECENT);
}

/** The settings behind "Choose a folder per project". */
export interface ProjectFolderOptions {
	onlyProjects: boolean;
	customProjectFolders?: boolean;
	projectFolders?: Record<string, string>;
}

/**
 * A folder path as typed: forward slashes, no leading/trailing or doubled slashes.
 * Null if empty or inside a hidden folder (".obsidian", ".trash" …).
 */
export function plainFolder(path: string): string | null {
	const parts = path.trim().replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
	if (!parts.length || parts.some((p) => p.startsWith('.'))) return null;
	return parts.join('/');
}

/**
 * The folder you chose for this chat's project, or null for the default folder. Only while
 * "Only sync selected projects" and "Choose a folder per project" are both on. Matches the
 * project's ID first, then its name (entries saved before the list knew IDs).
 */
export function customProjectFolder(item: ListItem, o: ProjectFolderOptions, recentName = DEFAULT_RECENT): string | null {
	if (!o.onlyProjects || !o.customProjectFolders || !o.projectFolders) return null;
	const folders = o.projectFolders;
	const keys = item.project ? [item.project.uuid, item.project.name] : [NO_PROJECT, recentName || DEFAULT_RECENT];
	const exact = keys.map((k) => folders[k]).find((f) => f !== undefined);
	const wanted = keys.map((k) => k.trim().toLowerCase());
	const loose = exact ?? Object.entries(folders).find(([k]) => wanted.includes(k.trim().toLowerCase()))?.[1];
	return loose === undefined ? null : plainFolder(loose);
}

/** Where a project's chats go without a folder of their own: the base folder, or its project subfolder. */
export function defaultProjectFolder(base: string, projectSubfolders: boolean, projectName: string | null, recentName = DEFAULT_RECENT): string {
	if (!projectSubfolders) return base;
	return `${base}/${safeTitle(projectName ?? (recentName || DEFAULT_RECENT))}`;
}

/** Distinct subfolder names needed for these chats, sorted. */
export function projectFolderNames(items: ListItem[], recentName = DEFAULT_RECENT): string[] {
	return [...new Set(items.map((it) => projectSubfolder(it, recentName)))].sort((a, b) => a.localeCompare(b));
}

/** Removes duplicate uuids (paging can overlap if a chat moves while we read). */
export function dedupe(items: ListItem[]): ListItem[] {
	const seen = new Set<string>();
	return items.filter((it) => (seen.has(it.uuid) ? false : (seen.add(it.uuid), true)));
}
