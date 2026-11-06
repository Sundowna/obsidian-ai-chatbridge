// Decides which chats to fetch. Pure functions, testable offline.

import type { IndexEntry, ListItem } from './types';
import { safeTitle } from './naming';

/** Default folder name for chats without a project (claude.ai lists them under Recents). */
export const DEFAULT_RECENT = 'Recent';

/**
 * Keep only chats whose project name or project uuid is in `projects`.
 * Listing the Recent folder name (e.g. "Recent") keeps chats without a project.
 */
export function filterByProjects(items: ListItem[], projects: string[], recentName = DEFAULT_RECENT): ListItem[] {
	const wanted = new Set(projects.map((p) => p.trim().toLowerCase()).filter(Boolean));
	if (wanted.size === 0) return items;
	const wantRecent = wanted.has(recentName.trim().toLowerCase());
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
	todo.sort((a, b) => Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at));
	return todo;
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

/** Distinct subfolder names needed for these chats, sorted. */
export function projectFolderNames(items: ListItem[], recentName = DEFAULT_RECENT): string[] {
	return [...new Set(items.map((it) => projectSubfolder(it, recentName)))].sort((a, b) => a.localeCompare(b));
}

/** Removes duplicate uuids (paging can overlap if a chat moves while we read). */
export function dedupe(items: ListItem[]): ListItem[] {
	const seen = new Set<string>();
	return items.filter((it) => (seen.has(it.uuid) ? false : (seen.add(it.uuid), true)));
}
