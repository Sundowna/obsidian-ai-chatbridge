// "Refresh index": finds saved chats that were moved outside Obsidian (in the file manager, by
// a sync tool, or while the plugin was off) and points the sync history at their new place, so
// the next sync does not save them a second time. Moves inside Obsidian are followed anyway.
//
// Transcripts are found by the chat ID in their front matter (uuid:, or session: for desktop
// sessions); raw files by the transcript's raw: link, else by a file name that is unique in the vault.

import { TFile, type App } from 'obsidian';
import type { Settings } from './settings';

/** One saved item's paths, as the indexes keep them. Updated in place. */
export interface IndexedPaths {
	id: string;
	md: string;
	/** Raw files (main .json, older parts, or the desktop .jsonl copy). */
	raws: string[];
	setMd(path: string): void;
	setRaw(index: number, path: string): void;
}

/** What the vault can tell about where things are now. */
export interface VaultLookup {
	exists(path: string): boolean;
	/** The transcript whose front matter carries this chat ID. */
	transcriptOf(id: string): string | null;
	/** The raw file a transcript's raw: link points at. */
	rawLinkOf(md: string): string | null;
	/** The only file in the vault with this name, or null if there is none or several. */
	uniqueByName(name: string): string | null;
}

export interface ReindexResult {
	checked: number;
	/** Transcripts or raw files found in a new place. */
	relinked: number;
	/** Chats whose transcript is nowhere: the next sync saves them again. */
	missing: number;
}

const nameOf = (p: string) => p.split('/').pop() ?? p;

/** Repoints every entry whose files are gone to where they are now. Pure, testable offline. */
export function refreshEntries(entries: readonly IndexedPaths[], vault: VaultLookup): ReindexResult {
	const r: ReindexResult = { checked: entries.length, relinked: 0, missing: 0 };
	for (const e of entries) {
		let md = e.md;
		if (!vault.exists(md)) {
			const found = vault.transcriptOf(e.id);
			if (found) {
				e.setMd(found);
				md = found;
				r.relinked++;
			} else {
				r.missing++;
				continue;
			}
		}
		e.raws.forEach((raw, i) => {
			if (!raw || vault.exists(raw)) return;
			const found = (i === 0 ? vault.rawLinkOf(md) : null) ?? vault.uniqueByName(nameOf(raw));
			if (found && found !== raw) {
				e.setRaw(i, found);
				r.relinked++;
			}
		});
	}
	return r;
}

/** Every index entry of every account, as IndexedPaths. */
export function allEntries(s: Settings): IndexedPaths[] {
	const out: IndexedPaths[] = [];
	const webIndexes = [...s.claude, ...s.chatgpt, ...s.lumo, ...s.gemini].map((a) => a.web.index);
	for (const a of s.gemini) webIndexes.push(a.studio.index);
	for (const index of webIndexes) {
		for (const [id, e] of Object.entries(index)) {
			out.push({
				id,
				md: e.md,
				raws: [e.json, ...(e.older ?? [])],
				setMd: (p) => {
					// ChatGPT's refreshed transcript is the same note unless it was saved separately.
					if (e.view === e.md) e.view = p;
					e.md = p;
				},
				setRaw: (i, p) => {
					if (i === 0) e.json = p;
					else if (e.older) e.older[i - 1] = p;
				},
			});
		}
	}
	for (const a of [...s.claude, ...s.chatgpt]) {
		for (const [id, e] of Object.entries(a.desktop.index)) {
			out.push({
				id,
				md: e.md,
				raws: e.raw ? [e.raw] : [],
				setMd: (p) => (e.md = p),
				setRaw: (_i, p) => (e.raw = p),
			});
		}
	}
	return out;
}

/** The vault as VaultLookup, read once from Obsidian's metadata cache. */
export function vaultLookup(app: App): VaultLookup {
	const byId = new Map<string, string>();
	const byName = new Map<string, string | null>();
	for (const f of app.vault.getFiles()) {
		byName.set(f.name, byName.has(f.name) ? null : f.path);
		if (f.extension !== 'md') continue;
		const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(f)?.frontmatter;
		const id: unknown = fm?.uuid ?? fm?.session;
		if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, f.path);
	}
	return {
		exists: (p) => app.vault.getAbstractFileByPath(p) instanceof TFile,
		transcriptOf: (id) => byId.get(id) ?? null,
		rawLinkOf: (md) => {
			const file = app.vault.getAbstractFileByPath(md);
			if (!(file instanceof TFile)) return null;
			const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
			const raw: unknown = fm?.raw;
			const link = typeof raw === 'string' ? /^\[\[([^\]|#]+)/.exec(raw.trim())?.[1] : undefined;
			return link ? app.metadataCache.getFirstLinkpathDest(link, md)?.path ?? null : null;
		},
		uniqueByName: (name) => byName.get(name) ?? null,
	};
}

/** Downloaded files (Artifacts/, Attachments/) found again by their unique name. Returns how many. */
export function refreshFiles(s: Settings, vault: VaultLookup): number {
	let n = 0;
	for (const a of [...s.claude, ...s.chatgpt]) {
		for (const [id, path] of Object.entries(a.web.fileIndex)) {
			if (path.startsWith('skipped: ') || vault.exists(path)) continue;
			const found = vault.uniqueByName(nameOf(path));
			if (found) {
				a.web.fileIndex[id] = found;
				n++;
			}
		}
	}
	return n;
}

/** Refreshes every index against the vault as it is now. */
export function refreshIndex(app: App, s: Settings): ReindexResult {
	const vault = vaultLookup(app);
	const r = refreshEntries(allEntries(s), vault);
	r.relinked += refreshFiles(s, vault);
	return r;
}
