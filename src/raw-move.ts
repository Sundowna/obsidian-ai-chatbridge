// Moving raw files saved earlier into the JSON folders the settings name today, so changing a
// JSON folder never leaves old files scattered. Uses Obsidian's own move: links and the index follow.

import { normalizePath, TFile, type App } from 'obsidian';
import type { DesktopAccount } from './accounts';
import { followRename } from './follow';
import type { Provider } from './login';
import { baseRoot, dirOf, masterRaw, projectRoots, rawMoves, type RawMove, type RawRoot, type SavedChat } from './raw-folders';
import { DEFAULT_RECENT, plainFolder } from './select';
import type { ChatgptAccount, ClaudeAccount, GeminiAccount, LumoAccount, Settings } from './settings';
import type { ProjectCatalog } from './project-catalog';
import { ensureFolder } from './vaultio';

const fileExists = (app: App) => (path: string): boolean => app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;

const namesIn = (catalog: ProjectCatalog | undefined) => {
	const byId = new Map((catalog?.rows ?? []).map((r) => [r.id, r.name]));
	return (id: string) => byId.get(id);
};

const roots = (rawRoot: string | undefined, ...bases: [string, string | undefined][]): RawRoot[] =>
	bases.flatMap(([base, raw]) => {
		const b = plainFolder(base);
		return b ? [baseRoot(b, raw, rawRoot)] : [];
	});

/** Raw files of this account's web chats that are not in today's JSON folders. */
export function webRawMoves(app: App, provider: Provider, account: ClaudeAccount | ChatgptAccount | LumoAccount, rawRoot?: string): RawMove[] {
	const w = account.web;
	const recent = w.recentFolderName || DEFAULT_RECENT;
	const names = namesIn(w.projectCatalog);
	let r: RawRoot[];
	if (provider === 'claude') {
		const c = (account as ClaudeAccount).web;
		r = roots(rawRoot, [c.chatFolder, c.chatRawFolder], [c.codeFolder, c.codeRawFolder]);
		const chat = plainFolder(c.chatFolder);
		if (chat) r.push(...projectRoots(c, chat, c.chatRawFolder, names, recent, rawRoot));
	} else {
		const g = (account as ChatgptAccount | LumoAccount).web;
		r = roots(rawRoot, [g.folder, g.rawFolder]);
		const base = plainFolder(g.folder);
		if (base) r.push(...projectRoots(g, base, g.rawFolder, names, recent, rawRoot));
	}
	const chats: SavedChat[] = Object.values(w.index).map((e) => ({ md: e.md, raws: [e.json, ...(e.older ?? [])] }));
	return rawMoves(chats, r, fileExists(app));
}

/** Gemini chats or AI Studio prompts. */
export function googleRawMoves(app: App, account: GeminiAccount, surface: 'web' | 'studio', rawRoot?: string): RawMove[] {
	const s = surface === 'web' ? account.web : account.studio;
	const chats: SavedChat[] = Object.values(s.index).map((e) => ({ md: e.md, raws: [e.json] }));
	return rawMoves(chats, roots(rawRoot, [s.folder, s.rawFolder]), fileExists(app));
}

/** Desktop sessions' raw .jsonl copies. */
export function desktopRawMoves(app: App, account: DesktopAccount, rawRoot?: string): RawMove[] {
	const d = account.desktop;
	const chats: SavedChat[] = Object.values(d.index).flatMap((e) => (e.raw ? [{ md: e.md, raws: [e.raw] }] : []));
	return rawMoves(chats, roots(rawRoot, [d.folder, d.rawFolder]), fileExists(app));
}

/** Every account's raw files that are not where today's settings put them (for the master raw folder). */
export function allRawMoves(app: App, s: Settings): RawMove[] {
	const root = masterRaw(s);
	return [
		...s.claude.flatMap((a) => [...webRawMoves(app, 'claude', a, root), ...desktopRawMoves(app, a, root)]),
		...s.chatgpt.flatMap((a) => [...webRawMoves(app, 'chatgpt', a, root), ...desktopRawMoves(app, a, root)]),
		...s.lumo.flatMap((a) => webRawMoves(app, 'lumo', a, root)),
		...s.gemini.flatMap((a) => [...googleRawMoves(app, a, 'web', root), ...googleRawMoves(app, a, 'studio', root)]),
	];
}

export interface RawMoveResult {
	moved: number;
	skipped: string[];
}

/** Moves each file, creating folders as needed. A file whose place got taken meanwhile stays. */
export async function moveRawFiles(app: App, settings: Settings, moves: readonly RawMove[], save: () => Promise<void>): Promise<RawMoveResult> {
	const r: RawMoveResult = { moved: 0, skipped: [] };
	for (const m of moves) {
		const src = app.vault.getAbstractFileByPath(normalizePath(m.from));
		const to = normalizePath(m.to);
		if (!(src instanceof TFile) || app.vault.getAbstractFileByPath(to)) {
			r.skipped.push(m.from);
			continue;
		}
		await ensureFolder(app, dirOf(to));
		await app.fileManager.renameFile(src, to);
		followRename(settings, m.from, to); // also done by the rename event; repeating it changes nothing
		r.moved++;
	}
	await save();
	return r;
}
