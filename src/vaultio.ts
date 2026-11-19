// Writing files into the vault. Nothing is deleted here. createNew never overwrites; writeOver
// replaces a file's content and is only for the one-note-per-chat rule (versions.ts), which
// keeps the earlier version first.

import { App, normalizePath, Platform, TAbstractFile, TFile, TFolder } from 'obsidian';

const fold = (s: string): string => s.normalize('NFC').toLowerCase();
// macOS and iOS (APFS) and Windows (NTFS) see "A.md" and "a.md" as one file; Linux and Android do not.
const caseInsensitiveFs = (): boolean => Platform.isMacOS || Platform.isWin || Platform.isIosApp;

/**
 * Like vault.getAbstractFileByPath, but finds the file the file system would see under this name:
 * the same name in the other Unicode form (NFC/NFD, e.g. names written by Syncthing on macOS),
 * and on case-insensitive systems a name that differs only in letter case. Without this, a name
 * looks free, vault.create then fails with "File already exists" and the sync stops.
 */
export function findFile(app: App, path: string): TAbstractFile | null {
	const p = normalizePath(path);
	const hit = app.vault.getAbstractFileByPath(p) ?? app.vault.getAbstractFileByPath(p.normalize('NFD'));
	if (hit || !p || !caseInsensitiveFs()) return hit;
	const i = p.lastIndexOf('/');
	const parent = i < 0 ? app.vault.getRoot() : findFile(app, p.slice(0, i));
	if (!(parent instanceof TFolder)) return null;
	const name = fold(p.slice(i + 1));
	return parent.children.find((c) => fold(c.name) === name) ?? null;
}

/** Creates the file, or replaces the content of the file already there. */
export async function writeOver(app: App, path: string, data: string | ArrayBuffer): Promise<void> {
	const p = normalizePath(path);
	const file = findFile(app, p);
	if (file === null) {
		if (typeof data === 'string') await app.vault.create(p, data);
		else await app.vault.createBinary(p, data);
		return;
	}
	if (!(file instanceof TFile)) throw new Error(`Refusing to overwrite ${p}: it is a folder`);
	if (typeof data === 'string') await app.vault.modify(file, data);
	else await app.vault.modifyBinary(file, data);
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!findFile(app, cur)) await app.vault.createFolder(cur);
	}
}

function taken(app: App, folder: string, rawFolder: string, stem: string): boolean {
	return (
		findFile(app, normalizePath(`${rawFolder}/${stem}.json`)) !== null ||
		findFile(app, normalizePath(`${folder}/${stem}.md`)) !== null
	);
}

/**
 * Finds a free "<stem>" so that neither <folder>/<stem>.md nor <rawFolder>/<stem>.json exists.
 * rawFolder is where the raw .json goes; by default next to the transcript.
 */
export function freeStem(app: App, folder: string, stem: string, uuid: string, rawFolder = folder): string {
	if (!taken(app, folder, rawFolder, stem)) return stem;
	const withId = `${stem} (${uuid.slice(0, 8)})`;
	if (!taken(app, folder, rawFolder, withId)) return withId;
	for (let i = 2; i < 1000; i++) {
		const s = `${withId} ${i}`;
		if (!taken(app, folder, rawFolder, s)) return s;
	}
	throw new Error(`No free file name for ${stem}`);
}

/** A file name in `folder` that is not taken yet: "x.py", then "x (2).py", "x (3).py", … */
export function freeFileName(app: App, folder: string, fileName: string, numbered: (n: string, i: number) => string): string {
	const free = (n: string) => findFile(app, normalizePath(`${folder}/${n}`)) === null;
	if (free(fileName)) return fileName;
	for (let i = 2; i < 1000; i++) {
		const n = numbered(fileName, i);
		if (free(n)) return n;
	}
	throw new Error(`No free file name for ${fileName}`);
}

/** Creates a new file. Throws if it already exists – never overwrites. */
export async function createNew(app: App, path: string, data: string | ArrayBuffer): Promise<void> {
	const p = normalizePath(path);
	if (findFile(app, p)) throw new Error(`Refusing to overwrite ${p}`);
	if (typeof data === 'string') await app.vault.create(p, data);
	else await app.vault.createBinary(p, data);
}
