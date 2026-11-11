// Writing files into the vault. There is deliberately no "modify" or "delete"
// here: chat files are only ever CREATED. If a name is taken, we pick another.

import { App, normalizePath } from 'obsidian';

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split('/').filter(Boolean);
	let cur = '';
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

function taken(app: App, folder: string, rawFolder: string, stem: string): boolean {
	return (
		app.vault.getAbstractFileByPath(normalizePath(`${rawFolder}/${stem}.json`)) !== null ||
		app.vault.getAbstractFileByPath(normalizePath(`${folder}/${stem}.md`)) !== null
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
	const free = (n: string) => app.vault.getAbstractFileByPath(normalizePath(`${folder}/${n}`)) === null;
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
	if (app.vault.getAbstractFileByPath(p)) throw new Error(`Refusing to overwrite ${p}`);
	if (typeof data === 'string') await app.vault.create(p, data);
	else await app.vault.createBinary(p, data);
}
