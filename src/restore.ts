// A note you deleted, whose raw .json is still in the vault, is written again from that file:
// no request to the provider, and it does not use up the "max chats per run" limit.

import { TFile, type App } from 'obsidian';
import { dirOf, rawLink } from './raw-folders';
import type { IndexEntry } from './types';
import { createNew, ensureFolder, findFile } from './vaultio';
import { noteHash, withVersionInfo } from './versions';

/** Turns the saved raw text into the note's text; throws when the raw file is not what it expects. */
export type FromRaw = (rawText: string, jsonLink: string, uuid: string) => string;

/** Throws unless `v` is an object whose `id` is the chat's and whose `list` field is an array. */
export function savedChat<T>(rawText: string, uuid: string, list: string): T {
	const v = JSON.parse(rawText) as Record<string, unknown> | null;
	if (!v || typeof v !== 'object' || v.id !== uuid || !Array.isArray(v[list])) throw new Error('not a saved chat');
	return v as T;
}

/**
 * Writes the missing note of chat `uuid` (`entry`) from its raw file, under its own name and place.
 * False = it could not (no raw file, an older or damaged one): fetch the chat again instead.
 */
export async function restoreNote(app: App, uuid: string, entry: IndexEntry, fromRaw: FromRaw): Promise<boolean> {
	const raw = findFile(app, entry.json);
	if (!(raw instanceof TFile) || findFile(app, entry.md)) return false;
	const folder = dirOf(entry.md);
	let md: string;
	try {
		md = withVersionInfo(fromRaw(await app.vault.read(raw), rawLink(folder, entry.json), uuid), entry.versions, folder);
	} catch {
		return false;
	}
	await ensureFolder(app, folder);
	await createNew(app, entry.md, md);
	entry.noteHash = noteHash(md);
	return true;
}
