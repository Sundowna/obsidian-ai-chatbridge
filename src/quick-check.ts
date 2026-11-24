// Every sync checks the chats that did not change: are their files all there, does their note
// still look like the plugin would draw it now? Answering that means reading and parsing the
// saved raw file (for ChatGPT hundreds of MB, every run), and almost always the answer is
// "nothing to do". So after a full check each chat remembers a key of everything the answer
// depends on: the raw files' size and modified time, the paths of its saved files, its note's
// state and the plugin build. Next run, the same key = the same answer, and the raw file is not
// read. Anything different or unknown (a vault that cannot tell file times) = the full check.

import type { App, PluginManifest } from 'obsidian';
import { fingerprintText } from './versions';

/** Kept in the index entry: the chat's file IDs (from its raw file) and the key of its last full check. */
export interface QuickCheck {
	files: string[];
	key: string;
}

/** "size:mtime" per file, or null when one is missing or the vault cannot tell. */
export async function fileStamps(app: App, paths: string[]): Promise<string[] | null> {
	const adapter = app.vault.adapter as { stat?: (path: string) => Promise<{ type: string; size: number; mtime: number } | null> };
	if (typeof adapter.stat !== 'function') return null;
	const out: string[] = [];
	for (const path of paths) {
		let st: { type: string; size: number; mtime: number } | null;
		try {
			st = await adapter.stat(path);
		} catch {
			return null;
		}
		if (!st || st.type !== 'file' || typeof st.mtime !== 'number' || !st.mtime) return null;
		out.push(`${st.size}:${st.mtime}`);
	}
	return out;
}

/**
 * The plugin build: its version and when its main.js was written. Any new build (an update, or
 * a rebuilt development copy) gives every chat one full check again, so a new layout is drawn.
 */
export async function buildStamp(app: App, manifest: PluginManifest | undefined): Promise<string | null> {
	if (!manifest?.dir) return null;
	const stamps = await fileStamps(app, [`${manifest.dir}/main.js`]);
	return stamps ? `${manifest.version}|${stamps[0]}` : null;
}

/** The key for a list of facts, or null when one of them is unknown. */
export function checkKey(parts: unknown[]): string | null {
	if (parts.some((p) => p === null)) return null;
	return fingerprintText(JSON.stringify(parts));
}
