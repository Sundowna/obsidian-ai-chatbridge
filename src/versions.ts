// One note per chat. When a chat continues, its note is rewritten with the whole current chat
// and keeps its name, so links stay valid. The version it had before is not lost: its raw file
// stays in the raw folder as "<name> (version <stamp>).json". Every provider goes through here.
//
// A note you edited by hand is noticed by a fingerprint of its text below the properties
// (properties may change freely: ticking "unread" is not an edit).

import { normalizePath, TFile, type App } from 'obsidian';
import { localStamp } from './naming';
import { dirOf, rawLink } from './raw-folders';
import type { NoteState, RawVersion } from './types';
import { createNew, ensureFolder, writeOver } from './vaultio';

/** What happens to a note you edited when its chat continues. */
export type EditedPolicy = 'copy' | 'keep' | 'overwrite';
export const EDITED_POLICIES: readonly EditedPolicy[] = ['copy', 'keep', 'overwrite'];

/** Properties this plugin writes about versions; never carried over from the old note. */
const OWN_KEYS = new Set(['earlier_versions', 'earlier_raw']);
/** A note changed this long after its sync counts as edited, when no fingerprint was saved yet. */
const LEGACY_MARGIN_MS = 2 * 60_000;

const nameOf = (p: string): string => p.split('/').pop() ?? p;
const stemOf = (p: string): string => nameOf(p).replace(/\.[^.]+$/, '');

// --- text ------------------------------------------------------------------------------------

interface Parts {
	/** The property lines, without the two "---" lines. */
	fm: string[];
	body: string;
}

/** Splits a note into its properties and the text below. Null if it has no properties block. */
export function splitNote(md: string): Parts | null {
	const text = md.replace(/\r\n/g, '\n');
	if (!text.startsWith('---\n')) return null;
	const end = text.indexOf('\n---', 3);
	if (end < 0) return null;
	const after = text.slice(end + 4);
	if (after && !after.startsWith('\n')) return null;
	return { fm: end > 3 ? text.slice(4, end).split('\n') : [], body: after.slice(1) };
}

const joinNote = (p: Parts): string => `---\n${p.fm.join('\n')}${p.fm.length ? '\n' : ''}---\n${p.body}`;

/** The properties as [key, its lines] in order; a list or folded value keeps its following lines. */
function entries(fm: string[]): [string, string[]][] {
	const out: [string, string[]][] = [];
	for (const line of fm) {
		const key = /^([^\s#:-][^:]*):(\s|$)/.exec(line)?.[1];
		if (key !== undefined) out.push([key.trim(), [line]]);
		else if (out.length) out[out.length - 1]![1].push(line);
	}
	return out;
}

/** The text below the properties, as it is compared: line ends and trailing space do not count. */
export function bodyOf(md: string): string {
	return (splitNote(md)?.body ?? md.replace(/\r\n/g, '\n')).trimEnd();
}

/** A short fingerprint of a text (cyrb53). Not a security hash: it only notices changes. */
export function fingerprintText(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** The fingerprint kept per note: of its text below the properties. */
export const noteHash = (md: string): string => fingerprintText(bodyOf(md));

/**
 * The new note with the properties you added to the old one (tags, aliases, your own keys).
 * Properties the new note has win; `keep` names ones whose old value stays (e.g. "unread"
 * when the chat itself did not change).
 */
export function carryProperties(oldMd: string, newMd: string, keep: readonly string[] = []): string {
	const before = splitNote(oldMd);
	const next = splitNote(newMd);
	if (!before || !next) return newMd;
	const old = entries(before.fm);
	const fresh = entries(next.fm);
	const has = new Set(fresh.map(([k]) => k));
	const kept = new Map(old.filter(([k]) => keep.includes(k) && has.has(k)));
	const fm = fresh.flatMap(([k, lines]) => kept.get(k) ?? lines);
	for (const [k, lines] of old) if (!has.has(k) && !OWN_KEYS.has(k)) fm.push(...lines);
	return joinNote({ fm, body: next.body });
}

/** Adds how many earlier versions exist, and links to their raw files, to the note's properties. */
export function withVersionInfo(md: string, versions: readonly RawVersion[] | undefined, mdFolder: string): string {
	const parts = splitNote(md);
	if (!parts || !versions?.length) return md;
	const fm = entries(parts.fm).filter(([k]) => !OWN_KEYS.has(k)).flatMap(([, lines]) => lines);
	const links = versions.flatMap((v) => (v.files[0] ? [`  - ${JSON.stringify(`[[${rawLink(mdFolder, v.files[0])}]]`)}`] : []));
	const info = [`earlier_versions: ${versions.length}`, ...(links.length ? ['earlier_raw:', ...links] : [])];
	// Before "unread", which every transcript ends its properties with.
	const at = fm.findIndex((l) => /^unread:/.test(l));
	fm.splice(at < 0 ? fm.length : at, 0, ...info);
	return joinNote({ fm, body: parts.body });
}

/**
 * Where an earlier version of a raw file is kept: "<stem> (version <stamp>)" plus whatever the
 * file name had after the stem (".json", " (older 1).json", ".jsonl"). `n` > 1 numbers a second
 * version from the same minute.
 */
export function versionPath(rawPath: string, mainStem: string, at: string, n = 1): string {
	const name = nameOf(rawPath);
	const rest = name.startsWith(mainStem) ? name.slice(mainStem.length) : name.slice(stemOf(rawPath).length);
	const dir = dirOf(rawPath);
	const stamp = Number.isNaN(Date.parse(at)) ? at.replace(/[\\/:*?"<>|#^[\]]/g, '-') : localStamp(at);
	return `${dir ? `${dir}/` : ''}${mainStem} (version ${stamp}${n > 1 ? ` ${n}` : ''})${rest}`;
}

// --- files -----------------------------------------------------------------------------------

function same(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

function toBytes(data: string | ArrayBuffer): ArrayBuffer {
	if (typeof data !== 'string') return data;
	const u = new TextEncoder().encode(data);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

const fileAt = (app: App, path: string): TFile | null => {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
};

/**
 * Keeps the raw files a chat has now as an earlier version, next to them. `files` is the main
 * raw file first, then its parts (ChatGPT's older pages). They are copied, not moved, so the
 * main file keeps its name and the note's "raw:" link stays right; the caller then writes the
 * new content over it. Running it twice for the same version copies nothing twice.
 * Returns null when there is no main file to keep.
 */
export async function keepVersion(app: App, files: readonly string[], at: string, incoming?: string | ArrayBuffer): Promise<RawVersion | null> {
	const main = files[0];
	if (!main || !fileAt(app, main)) return null;
	const mainStem = stemOf(main);
	const present: { path: string; bytes: ArrayBuffer }[] = [];
	for (const path of files) {
		const f = fileAt(app, path);
		if (f) present.push({ path, bytes: await app.vault.readBinary(f) });
	}
	// The main file already holds what is about to be written (the same version again, or a run
	// that stopped right after writing it): there is nothing earlier in it to keep.
	if (incoming !== undefined && same(present[0]!.bytes, toBytes(incoming))) {
		// A stopped run may have kept the earlier version already: then that is the one.
		const earlier = files.map((p) => versionPath(p, mainStem, at)).filter((p) => fileAt(app, p));
		return earlier.length && earlier[0] === versionPath(main, mainStem, at) ? { at, files: earlier } : null;
	}
	for (let n = 1; n < 1000; n++) {
		const targets = present.map((p) => versionPath(p.path, mainStem, at, n));
		let clash = false;
		for (const [i, target] of targets.entries()) {
			const there = app.vault.getAbstractFileByPath(normalizePath(target));
			if (there === null) continue;
			// A copy from a run that was stopped is reused; anything else means the name is taken.
			if (!(there instanceof TFile) || !same(await app.vault.readBinary(there), present[i]!.bytes)) clash = true;
		}
		if (clash) continue;
		for (const [i, target] of targets.entries()) {
			if (!fileAt(app, target)) await createNew(app, target, present[i]!.bytes);
		}
		return { at, files: targets };
	}
	throw new Error(`No free file name for an earlier version of ${main}`);
}

export interface NoteWriteOptions {
	policy: EditedPolicy;
	/** The fingerprint saved when the plugin last wrote this note. */
	lastHash?: string;
	/** When the plugin last wrote it (ISO); used only while no fingerprint is saved. */
	lastSynced?: string;
	/** The caller knows the note is as the plugin wrote it. */
	unedited?: boolean;
	/** Properties whose value in the old note stays (see carryProperties). */
	keep?: readonly string[];
	now?: Date;
}

export interface NoteWrite {
	/** The fingerprint to save, or undefined when the note was left as you edited it. */
	hash?: string;
	/** "kept" = the note was edited and the setting says to leave it. */
	outcome: 'created' | 'updated' | 'kept';
	/** Where your edited version was saved first. */
	copy?: string;
}

/** A transcript's turns: one piece per "## Speaker" heading, without the "## Files" list at its end. */
function turns(body: string): string[] {
	const at = body.lastIndexOf('\n## Files\n');
	return (at >= 0 ? body.slice(0, at) : body).split(/^(?=## )/m).map((t) => t.trim()).filter(Boolean);
}

/**
 * Does the new transcript still hold every turn of the old note, word for word? A chat that
 * continued does; a note whose text you changed does not.
 */
export function continues(oldMd: string, newMd: string): boolean {
	const kept = new Set(turns(bodyOf(newMd)));
	return turns(bodyOf(oldMd)).every((t) => kept.has(t));
}

/**
 * Was this note changed by hand since the plugin wrote it? With a saved fingerprint that is
 * exact. A note saved before fingerprints existed counts as edited only if its file changed
 * after its sync AND the new transcript no longer holds all of its text: file times alone are
 * not enough (moving folders, sync tools and ticking "unread" all change them).
 */
export function wasEdited(current: string, mtime: number | undefined, o: Pick<NoteWriteOptions, 'lastHash' | 'lastSynced' | 'unedited'>, next?: string): boolean {
	if (o.unedited) return false;
	if (o.lastHash) return noteHash(current) !== o.lastHash;
	const synced = o.lastSynced ? Date.parse(o.lastSynced) : NaN;
	const touched = mtime !== undefined && !Number.isNaN(synced) && mtime > synced + LEGACY_MARGIN_MS;
	return touched && !(next !== undefined && continues(current, next));
}

/** A free "<stem> (my edits <stamp>).md" next to the note. */
function editsPath(app: App, mdPath: string, now: Date): string {
	const dir = dirOf(mdPath);
	const base = `${dir ? `${dir}/` : ''}${stemOf(mdPath)} (my edits ${localStamp(now.toISOString())}`;
	for (let n = 1; n < 1000; n++) {
		const p = `${base}${n > 1 ? ` ${n}` : ''}).md`;
		if (app.vault.getAbstractFileByPath(normalizePath(p)) === null) return p;
	}
	throw new Error(`No free file name for your edits of ${mdPath}`);
}

/**
 * Writes a chat's note: creates it, or rewrites the one that is there. Properties you added
 * stay. If you edited the text, the setting decides: save your version as a copy first
 * (default), leave the note alone, or overwrite it.
 */
export async function writeNote(app: App, mdPath: string, md: string, o: NoteWriteOptions): Promise<NoteWrite> {
	const file = fileAt(app, mdPath);
	if (!file) {
		await ensureFolder(app, dirOf(mdPath));
		await createNew(app, mdPath, md);
		return { hash: noteHash(md), outcome: 'created' };
	}
	const current = await app.vault.read(file);
	const next = carryProperties(current, md, o.keep);
	const sameText = bodyOf(current) === bodyOf(md);
	let copy: string | undefined;
	if (!sameText && wasEdited(current, file.stat?.mtime, o, md)) {
		if (o.policy === 'keep') return { hash: o.lastHash, outcome: 'kept' };
		if (o.policy === 'copy') {
			copy = editsPath(app, mdPath, o.now ?? new Date());
			await createNew(app, copy, current);
		}
	}
	if (next !== current.replace(/\r\n/g, '\n')) await app.vault.modify(file, next);
	return { hash: noteHash(md), outcome: 'updated', copy };
}

/** Writes a raw file: creates it (and its folder), or replaces the content of the one there. */
export async function writeRaw(app: App, path: string, data: string | ArrayBuffer): Promise<void> {
	await ensureFolder(app, dirOf(path));
	await writeOver(app, path, data);
}

/** The versions list after one more was kept (the same version is never listed twice). */
export function addVersion(state: NoteState | undefined, kept: RawVersion | null): RawVersion[] | undefined {
	const before = state?.versions ?? [];
	if (!kept) return before.length ? before : undefined;
	return [...before.filter((v) => v.files[0] !== kept.files[0]), kept];
}

/** Every raw file kept as an earlier version of this entry. */
export const versionFiles = (state: NoteState | undefined): string[] => (state?.versions ?? []).flatMap((v) => v.files);

/** Notes you had edited that a sync came across, for the log and the result notice. */
export interface EditedReport {
	/** Your version was saved as this copy before the note was updated. */
	copies: string[];
	/** Left as you edited it (setting "Don't update that note"). */
	kept: string[];
}

export const noEdits = (): EditedReport => ({ copies: [], kept: [] });

/** Remembers what a note write did with your edits. */
export function recordEdit(r: EditedReport, w: NoteWrite, mdPath: string): void {
	if (w.copy) r.copies.push(stemOf(w.copy));
	if (w.outcome === 'kept') r.kept.push(stemOf(mdPath));
}

/** The log's words about edited notes (empty when there were none). */
export function editsLog(r: EditedReport | undefined): string[] {
	const out: string[] = [];
	const links = (names: string[]) => names.slice(0, 10).map((n) => `[[${n}]]`).join(', ') + (names.length > 10 ? ` +${names.length - 10} more` : '');
	if (r?.copies.length) out.push(`${r.copies.length} edited by you, your version kept as: ${links(r.copies)}`);
	if (r?.kept.length) out.push(`${r.kept.length} edited by you and not updated: ${links(r.kept)}`);
	return out;
}

/**
 * For a chat saved before it had a raw file: keeps the old note's text as its earlier version,
 * wrapped in JSON, where the raw file's versions go. Null when there is no note to keep.
 */
export async function keepNoteAsVersion(app: App, mdPath: string, rawPath: string, at: string): Promise<RawVersion | null> {
	const note = fileAt(app, mdPath);
	if (!note) return null;
	const text = JSON.stringify({ format: 'ai-chatbridge-note', note: mdPath, markdown: await app.vault.read(note) }, null, '\t');
	const mainStem = stemOf(rawPath);
	for (let n = 1; n < 1000; n++) {
		const target = versionPath(rawPath, mainStem, at, n);
		const there = fileAt(app, target);
		if (there && (await app.vault.read(there)) !== text) continue;
		if (!there) {
			await ensureFolder(app, dirOf(target));
			await createNew(app, target, text);
		}
		return { at, files: [target] };
	}
	throw new Error(`No free file name for an earlier version of ${mdPath}`);
}
