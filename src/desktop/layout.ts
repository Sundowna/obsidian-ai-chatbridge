// The folder layout: one folder per provider, split by where the chats live.
//
//   <root>/Claude/Chat/<project>               claude.ai chats, every account (account: in the notes)
//   <root>/Claude/Code-Cloud                   Claude Code sessions listed on claude.ai
//   <root>/Claude/Code-Local/<computer>/<repo> Claude Code sessions on this computer
//   <root>/ChatGPT/Chat/<project>              ChatGPT chats
//   <root>/ChatGPT/Codex-Local/<computer>      Codex threads on this computer
//   <root>/Lumo/Chat, <root>/Gemini/Chat, <root>/Gemini/AI Studio
//
// Accounts share these folders; each transcript says which account it came from.
//
// moveToAppLayout moves folders from older layouts ("Claude Desktop/Chat", "Claude Desktop (Work)/Code",
// the flat "Claude Chat" …) there with Obsidian's own rename, so links and the plugin's indexes
// follow (see follow.ts). Folders you chose yourself, outside those layouts, are left alone.
// Nothing is deleted except folders the move leaves empty.

import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { computerName } from '../computer';
import { followRename } from '../follow';
import type { Settings } from '../settings';

/** The 0.17–0.24 layout's app folders ("Claude Desktop/Chat", "Claude Desktop (Work)/Code"). */
export const CLAUDE_APP = 'Claude Desktop';
export const CHATGPT_APP = 'ChatGPT Desktop';

/** Where each kind of chat goes, below the root. */
export const PLACES = {
	claudeChat: 'Claude/Chat',
	claudeCodeCloud: 'Claude/Code-Cloud',
	claudeCodeLocal: 'Claude/Code-Local',
	chatgptChat: 'ChatGPT/Chat',
	codexLocal: 'ChatGPT/Codex-Local',
	lumoChat: 'Lumo/Chat',
	geminiChat: 'Gemini/Chat',
	studio: 'Gemini/AI Studio',
} as const;

const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const join = (root: string, rest: string) => (root ? `${root}/${rest}` : rest);

/** A provider folder of this or an older layout: "Claude", "Claude Desktop", "Claude Desktop (Work)", "Lumo (Work)" … */
const PROVIDER_DIR = /^(Claude|ChatGPT|Lumo|Gemini)( Desktop)?( \(.+\))?$/;

/** The folders of the layout below `root`. The local session folders end in this computer's name. */
export function layoutFolders(root: string, computer = computerName()) {
	const at = (rest: string) => join(root, rest);
	return {
		claudeChat: at(PLACES.claudeChat),
		claudeCodeCloud: at(PLACES.claudeCodeCloud),
		claudeCodeLocal: at(`${PLACES.claudeCodeLocal}/${computer}`),
		chatgptChat: at(PLACES.chatgptChat),
		codexLocal: at(`${PLACES.codexLocal}/${computer}`),
		lumoChat: at(PLACES.lumoChat),
		geminiChat: at(PLACES.geminiChat),
		studio: at(PLACES.studio),
	};
}

/** The folder holding the provider folders: above "Claude/Chat" or "Claude Desktop/Chat", next to a flat "Claude Chat". */
export function layoutRoot(chatFolder: string): string {
	const parent = parentOf(chatFolder);
	return PROVIDER_DIR.test(parent.split('/').pop() ?? '') ? parentOf(parent) : parent;
}

/** Inside an older layout under `root` (so the plugin made it), not a folder chosen by hand. */
function inOldLayout(path: string, root: string): boolean {
	const p = normalizePath(path);
	const rest = root ? (p.startsWith(`${normalizePath(root)}/`) ? p.slice(normalizePath(root).length + 1) : null) : p;
	if (rest === null) return false;
	const top = rest.split('/')[0] ?? '';
	return PROVIDER_DIR.test(top) || LEGACY_FLAT.includes(top);
}

/** Flat folders of 0.16 and earlier. */
const LEGACY_FLAT = ['Claude Chat', 'Claude Code', 'ChatGPT Chat', 'Codex'];

export interface LayoutMove {
	label: string;
	from: string;
	to: string;
	set: (s: Settings, path: string) => void;
}

/**
 * What to move. Each folder setting of every account that sits in an older layout, plus the
 * flat folders of 0.16 and earlier while they still exist. Local sessions move before the
 * claude.ai code folder: older versions used one "Code" folder for both.
 */
export function layoutMoves(s: Settings, exists: (path: string) => boolean = () => false, computer = computerName()): LayoutMove[] {
	const root = layoutRoot(s.claude[0]!.web.chatFolder);
	const to = layoutFolders(root, computer);
	const targets: { label: string; setting: string; legacy?: string[]; to: string; set: LayoutMove['set'] }[] = [];
	for (const a of s.claude) {
		targets.push(
			{ label: 'claude.ai chats', setting: a.web.chatFolder, legacy: ['Claude Chat', `${CLAUDE_APP}/Chat`], to: to.claudeChat, set: (_s, p) => (a.web.chatFolder = p) },
			{ label: 'Claude Code sessions on this computer', setting: a.desktop.folder, legacy: [`${CLAUDE_APP}/Code`], to: to.claudeCodeLocal, set: (_s, p) => (a.desktop.folder = p) },
			{ label: 'Claude Code sessions listed on claude.ai', setting: a.web.codeFolder, legacy: ['Claude Code'], to: to.claudeCodeCloud, set: (_s, p) => (a.web.codeFolder = p) },
		);
	}
	for (const a of s.chatgpt) {
		targets.push(
			{ label: 'ChatGPT chats', setting: a.web.folder, legacy: ['ChatGPT Chat', `${CHATGPT_APP}/Chat`], to: to.chatgptChat, set: (_s, p) => (a.web.folder = p) },
			{ label: 'Codex threads on this computer', setting: a.desktop.folder, legacy: ['Codex', `${CHATGPT_APP}/Codex`], to: to.codexLocal, set: (_s, p) => (a.desktop.folder = p) },
		);
	}
	for (const a of s.lumo) targets.push({ label: 'Lumo chats', setting: a.web.folder, to: to.lumoChat, set: (_s, p) => (a.web.folder = p) });
	for (const a of s.gemini) {
		targets.push(
			{ label: 'Gemini chats', setting: a.web.folder, to: to.geminiChat, set: (_s, p) => (a.web.folder = p) },
			{ label: 'AI Studio prompts', setting: a.studio.folder, to: to.studio, set: (_s, p) => (a.studio.folder = p) },
		);
	}
	const out: LayoutMove[] = [];
	const seen = new Set<string>();
	for (const t of targets) {
		const sources = [
			...(inOldLayout(t.setting, root) ? [t.setting] : []),
			...(t.legacy ?? []).map((name) => join(root, name)).filter(exists),
		];
		for (const from of sources) {
			const key = `${normalizePath(from)}>${normalizePath(t.to)}`;
			if (normalizePath(from) === normalizePath(t.to) || seen.has(key)) continue;
			seen.add(key);
			out.push({ label: t.label, from, to: t.to, set: t.set });
		}
	}
	return out;
}

export const folderExists = (app: App) => (path: string): boolean => app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFolder;

export interface MoveResult {
	moved: number;
	conflicts: string[];
	/** The folders moved out of, for tidying up their copies elsewhere (the raw files folder). */
	from: string[];
}

/** Removes empty folders at and below `path`, deepest first. Never touches a folder with a file in it. */
export async function pruneEmpty(app: App, path: string): Promise<void> {
	const folder = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(folder instanceof TFolder)) return;
	for (const child of [...folder.children]) if (child instanceof TFolder) await pruneEmpty(app, child.path);
	if (folder.children.length === 0) await app.fileManager.trashFile(folder);
}

async function moveInto(app: App, s: Settings, src: TAbstractFile, destPath: string, r: MoveResult): Promise<void> {
	const dest = app.vault.getAbstractFileByPath(destPath);
	if (!dest) {
		const parent = parentOf(destPath);
		if (parent && !app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
		const oldPath = src.path;
		await app.fileManager.renameFile(src, destPath);
		followRename(s, oldPath, destPath); // also done by the rename event; repeating it changes nothing
		r.moved++;
		return;
	}
	if (src instanceof TFolder && dest instanceof TFolder) {
		for (const child of [...src.children]) await moveInto(app, s, child, `${destPath}/${child.name}`, r);
		if (src.children.length === 0) await app.fileManager.trashFile(src);
		return;
	}
	// A file with the same name is already there: leave both alone.
	if (src instanceof TFile) r.conflicts.push(src.path);
}

/** Moves each synced folder into the layout and points the settings there. */
export async function moveToAppLayout(app: App, s: Settings, save: () => Promise<void>, computer = computerName()): Promise<MoveResult> {
	const r: MoveResult = { moved: 0, conflicts: [], from: [] };
	const root = layoutRoot(s.claude[0]!.web.chatFolder);
	for (const m of layoutMoves(s, folderExists(app), computer)) {
		const src = app.vault.getAbstractFileByPath(normalizePath(m.from));
		// Nested: the old folder is inside the new one (or the other way round) – only switch the setting.
		const nested = m.to.startsWith(`${m.from}/`) || m.from.startsWith(`${m.to}/`);
		try {
			if (src instanceof TFolder && !nested) {
				r.from.push(m.from);
				await moveInto(app, s, src, normalizePath(m.to), r);
			}
		} finally {
			// Even if the move stopped halfway: what moved is in the index already, and new chats
			// must go to the new folder, not back into the old one.
			m.set(s, m.to);
			await save();
		}
	}
	// Old app folders ("Claude Desktop") left empty by the moves.
	for (const from of r.from) {
		const parent = parentOf(from);
		if (parent !== root && inOldLayout(parent, root)) await pruneEmpty(app, parent);
	}
	return r;
}
