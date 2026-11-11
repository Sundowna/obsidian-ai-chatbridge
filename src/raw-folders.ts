// Where the raw .json (and desktop .jsonl) files go. Each transcript folder setting can have a
// JSON folder of its own; empty keeps the raw files next to the transcripts, as before.
// Project subfolders are mirrored inside the JSON folder. Pure functions, testable offline.

import { customProjectFolder, DEFAULT_RECENT, defaultProjectFolder, NO_PROJECT, plainFolder, projectSubfolder, type ProjectFolderOptions } from './select';
import type { ListItem } from './types';

export interface RawFolderOptions extends ProjectFolderOptions {
	projectSubfolders: boolean;
	/** Picker row ID (project ID, or ":no-project") -> vault folder for that project's raw files. */
	projectRawFolders?: Record<string, string>;
}

/** The two folders one chat is written to. Equal when the raw files have no folder of their own. */
export interface ChatFolders {
	md: string;
	raw: string;
}

const join = (base: string, sub: string): string => (sub ? `${base}/${sub}` : base);
export const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/');
const nameOf = (p: string): string => p.split('/').pop() ?? p;

/** A usable JSON folder setting, or null for "next to the transcripts". */
export const rawBase = (setting: string | undefined): string | null => plainFolder(setting ?? '');

/** Where a chat's transcript and its raw files go. */
export function chatFolders(item: ListItem, o: RawFolderOptions, base: string, rawSetting: string | undefined, recentName = DEFAULT_RECENT): ChatFolders {
	const sub = o.projectSubfolders ? projectSubfolder(item, recentName) : '';
	const md = customProjectFolder(item, o, recentName) ?? join(base, sub);
	const ownRaw = customProjectFolder(item, { ...o, projectFolders: o.projectRawFolders }, recentName);
	const rb = rawBase(rawSetting);
	return { md, raw: ownRaw ?? (rb ? join(rb, sub) : md) };
}

/**
 * The picker's greyed default for a project's JSON folder: the JSON folder (mirrored), or the
 * project's transcript folder when there is no JSON folder.
 */
export function projectRawDefault(mdFolder: string, rawSetting: string | undefined, projectSubfolders: boolean, projectName: string | null, recentName = DEFAULT_RECENT): string {
	const rb = rawBase(rawSetting);
	return rb ? defaultProjectFolder(rb, projectSubfolders, projectName, recentName) : mdFolder;
}

/**
 * What the transcript's "raw:" link points at: the bare file name when the raw file sits next
 * to the transcript (as always), else its full vault path, so the link is never ambiguous.
 */
export function rawLink(mdFolder: string, rawPath: string): string {
	return dirOf(rawPath) === mdFolder ? nameOf(rawPath) : rawPath;
}

/** A pair of folders: transcripts under `md` keep their raw files under `raw`, same subfolders. */
export interface RawRoot {
	md: string;
	raw: string;
}

/** A base transcript folder and the JSON folder its raw files mirror into. */
export function baseRoot(base: string, rawSetting: string | undefined): RawRoot {
	return { md: base, raw: rawBase(rawSetting) ?? base };
}

/**
 * One root per project with a folder of its own (transcripts, raw files or both), so moves
 * follow "Choose a folder per project". `nameOf` gives a project's name from its picker ID.
 */
export function projectRoots(o: RawFolderOptions, base: string, rawSetting: string | undefined, nameOf: (id: string) => string | undefined, recentName = DEFAULT_RECENT): RawRoot[] {
	if (!o.onlyProjects || !o.customProjectFolders) return [];
	const own = o.projectFolders ?? {};
	const ownRaw = o.projectRawFolders ?? {};
	const out: RawRoot[] = [];
	for (const id of new Set([...Object.keys(own), ...Object.keys(ownRaw)])) {
		const loose = id === NO_PROJECT || id.trim().toLowerCase() === (recentName || DEFAULT_RECENT).toLowerCase();
		const name = loose ? null : nameOf(id) ?? id; // older entries were saved by name
		const md = plainFolder(own[id] ?? '') ?? defaultProjectFolder(base, o.projectSubfolders, name, recentName);
		const raw = plainFolder(ownRaw[id] ?? '') ?? projectRawDefault(md, rawSetting, o.projectSubfolders, name, recentName);
		out.push({ md, raw });
	}
	return out;
}

/** One synced chat: its transcript and its raw files (the main .json first). */
export interface SavedChat {
	md: string;
	raws: string[];
}

export interface RawMove {
	from: string;
	to: string;
}

/** Where a raw file belongs today, or null if its transcript is outside every root. */
export function rawTarget(chat: SavedChat, rawPath: string, roots: readonly RawRoot[]): string | null {
	const dir = dirOf(chat.md);
	let best: RawRoot | null = null;
	for (const r of roots) {
		if (dir !== r.md && !dir.startsWith(`${r.md}/`)) continue;
		if (!best || r.md.length > best.md.length) best = r;
	}
	if (!best) return null;
	return `${best.raw}${dir.slice(best.md.length)}/${nameOf(rawPath)}`;
}

/**
 * Raw files of synced chats that are not where the current settings would put them. Each move
 * keeps the file name. A file is left alone when it is missing, or its new place is taken.
 */
export function rawMoves(chats: readonly SavedChat[], roots: readonly RawRoot[], exists: (path: string) => boolean): RawMove[] {
	const out: RawMove[] = [];
	const claimed = new Set<string>();
	for (const chat of chats) {
		for (const from of chat.raws) {
			const to = rawTarget(chat, from, roots);
			if (!to || to === from || !exists(from)) continue;
			const key = to.toLowerCase();
			if (exists(to) || claimed.has(key)) continue;
			claimed.add(key);
			out.push({ from, to });
		}
	}
	return out;
}
