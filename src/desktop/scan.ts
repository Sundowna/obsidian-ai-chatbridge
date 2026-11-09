// Finds the desktop apps' session files on this computer. Reading only: nothing
// outside the vault is ever changed. The file system is passed in, so tests can
// use a fake one; inside Obsidian it is Node's fs (desktop only).

import type { DesktopApp } from './types';

export interface DesktopFs {
	home: string;
	env(name: string): string | undefined;
	/** Entries of a folder; empty if it does not exist or cannot be read. */
	readDir(dir: string): Promise<{ name: string; dir: boolean }[]>;
	stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
	readText(path: string): Promise<string | null>;
	readBytes(path: string): Promise<Uint8Array | null>;
}

export interface SourceFile {
	app: DesktopApp;
	path: string;
	size: number;
	mtime: number;
}

const MAX_DEPTH = 5;
/** Claude Code keeps helper-agent transcripts under <session>/subagents/; they belong to their parent session. */
const SKIP_DIRS = new Set(['subagents', 'node_modules', '.git']);

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;

export function claudeHome(fs: DesktopFs): string {
	return (fs.env('CLAUDE_CONFIG_DIR') || join(fs.home, '.claude')).replace(/\\/g, '/');
}

export function codexHome(fs: DesktopFs): string {
	return (fs.env('CODEX_HOME') || join(fs.home, '.codex')).replace(/\\/g, '/');
}

/** The folders the app itself writes sessions to. */
export function defaultRoots(fs: DesktopFs, app: DesktopApp): string[] {
	if (app === 'claude') return [join(claudeHome(fs), 'projects')];
	const home = codexHome(fs);
	return [join(home, 'sessions'), join(home, 'archived_sessions')];
}

/** Whether a file path is this folder or inside it (slashes and case don't matter). */
export function sameOrUnder(path: string, folder: string): boolean {
	const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const f = norm(folder);
	return !!f && (norm(path) === f || norm(path).startsWith(`${f}/`));
}

/**
 * Every Codex home in use: the default one, plus the parent of any extra folder that is a
 * home's "sessions" folder (where a second login's CODEX_HOME keeps its titles and projects).
 */
export function codexHomes(fs: DesktopFs, extraFolders: string[]): string[] {
	const homes = extraFolders.flatMap((f) => {
		const m = /^(.*)\/(?:archived_)?sessions\/*$/i.exec(f.trim().replace(/\\/g, '/'));
		return m?.[1] ? [m[1]] : [];
	});
	return [...new Set([codexHome(fs), ...homes])];
}

async function walk(fs: DesktopFs, dir: string, depth: number, out: string[]): Promise<void> {
	if (depth > MAX_DEPTH) return;
	for (const e of await fs.readDir(dir)) {
		const p = join(dir, e.name);
		if (e.dir) {
			if (!SKIP_DIRS.has(e.name)) await walk(fs, p, depth + 1, out);
		} else if (e.name.endsWith('.jsonl')) out.push(p);
	}
}

/** Every session file for one app: its own folders plus your extra folders, each file once. */
export async function listSessionFiles(fs: DesktopFs, app: DesktopApp, extraFolders: string[]): Promise<SourceFile[]> {
	const roots = [...defaultRoots(fs, app), ...extraFolders.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean)];
	const paths: string[] = [];
	for (const root of new Set(roots)) await walk(fs, root, 0, paths);
	const out: SourceFile[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		const key = path.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		// Codex keeps its title index next to the sessions; it is not a session.
		if (app === 'codex' && /\/session_index\.jsonl$/i.test(path)) continue;
		const st = await fs.stat(path);
		if (st) out.push({ app, path, size: st.size, mtime: st.mtimeMs });
	}
	return out;
}

/** Where the Claude desktop app keeps its own data (Windows, Microsoft Store/MSIX redirect, macOS, Linux). */
function claudeAppDataRoots(fs: DesktopFs): string[] {
	const local = fs.env('LOCALAPPDATA')?.replace(/\\/g, '/');
	const roaming = fs.env('APPDATA')?.replace(/\\/g, '/');
	const roots: string[] = [];
	if (local) roots.push(join(local, 'Claude-Data'), join(local, 'Claude'));
	if (roaming) roots.push(join(roaming, 'Claude'));
	roots.push(join(fs.home, 'Library/Application Support/Claude'), join(fs.home, '.config/Claude'));
	return roots;
}

/** The Code tab's per-session files (local_<id>.json), which hold the titles shown in the app. */
export async function claudeDesktopMetaFiles(fs: DesktopFs): Promise<string[]> {
	const out: string[] = [];
	const subdirs = async (dir: string) => (await fs.readDir(dir)).filter((e) => e.dir).map((e) => join(dir, e.name));
	for (const root of claudeAppDataRoots(fs)) {
		// claude-code-sessions sits in the data folder itself or in a profile folder (Claude-Data/claude_<id>/).
		const bases = [root, ...(await subdirs(root))].map((b) => join(b, 'claude-code-sessions'));
		for (const base of bases) {
			for (const account of await subdirs(base)) {
				for (const org of await subdirs(account)) {
					for (const e of await fs.readDir(org)) {
						if (!e.dir && /^local_.+\.json$/.test(e.name)) out.push(join(org, e.name));
					}
				}
			}
		}
	}
	return [...new Set(out)];
}

/**
 * The Claude desktop app's Local Storage files (*.log, *.ldb), where its sidebar groups are
 * kept. Read as a snapshot; the app may be writing at the same time, so a read can miss.
 */
export async function claudeLocalStorageFiles(fs: DesktopFs): Promise<[string, Uint8Array][]> {
	const out: [string, Uint8Array][] = [];
	const subdirs = async (dir: string) => (await fs.readDir(dir)).filter((e) => e.dir).map((e) => join(dir, e.name));
	for (const root of claudeAppDataRoots(fs)) {
		for (const base of [root, ...(await subdirs(root))]) {
			const dir = join(base, 'Local Storage/leveldb');
			for (const e of await fs.readDir(dir)) {
				if (e.dir || !/\.(log|ldb)$/.test(e.name)) continue;
				const bytes = await fs.readBytes(join(dir, e.name));
				if (bytes) out.push([e.name, bytes]);
			}
		}
	}
	return out;
}

/** Node's fs through Obsidian's desktop require; null on mobile. */
export function nodeDesktopFs(): DesktopFs | null {
	const req = (window as unknown as { require?: (m: string) => unknown }).require;
	if (typeof req !== 'function') return null;
	type Dirent = { name: string; isDirectory(): boolean };
	const fsp = (req('fs') as { promises: {
		readdir(p: string, o: { withFileTypes: true }): Promise<Dirent[]>;
		stat(p: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
		readFile(p: string, enc?: 'utf8'): Promise<string & Uint8Array>;
	} }).promises;
	const os = req('os') as { homedir(): string };
	const proc = (req('process') as { env: Record<string, string | undefined> });
	return {
		home: os.homedir().replace(/\\/g, '/'),
		env: (name) => proc.env[name],
		readDir: async (dir) => {
			try {
				return (await fsp.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() }));
			} catch {
				return [];
			}
		},
		stat: async (p) => {
			try {
				const s = await fsp.stat(p);
				return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
			} catch {
				return null;
			}
		},
		readText: async (p) => {
			try {
				return await fsp.readFile(p, 'utf8');
			} catch {
				return null;
			}
		},
		readBytes: async (p) => {
			try {
				return new Uint8Array(await fsp.readFile(p));
			} catch {
				return null;
			}
		},
	};
}
