// Saves a Claude Code session's files into the vault, next to its transcript:
// <folder>/Attachments/<stem>/ (what you pasted) and <folder>/Artifacts/<stem>/ (what Claude made),
// the same layout as the claude.ai chats. Files outside the vault are only read, never changed.

import { App, TFile } from 'obsidian';
import { KIND_FOLDER, numbered, safeFileName } from '../files';
import { createNew, ensureFolder, freeFileName } from '../vaultio';
import type { SessionFile } from './claude-files';
import { claudeHome, sameOrUnder, type DesktopFs } from './scan';
import type { DesktopSession } from './types';

/** Bigger files are left where they are (videos, datasets). */
const MAX_BYTES = 25 * 1024 * 1024;

export interface FileSaveContext {
	app: App;
	fs: DesktopFs;
	/** The vault's folder on disk: files already inside it are linked, not copied. */
	vaultBase?: string;
}

export interface FileSaveResult {
	/** File key -> vault path, for the transcript and the index. */
	files: Record<string, string>;
	saved: number;
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

function fromBase64(data: string): ArrayBuffer {
	const bin = atob(data);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

const toBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Working copies Claude wrote for itself: kept only if it sent or published them. */
function scratch(ctx: FileSaveContext, path: string): boolean {
	return sameOrUnder(path, claudeHome(ctx.fs)) || /\/AppData\/Local\/Temp\//i.test(slashes(path)) || /^\/tmp\//.test(slashes(path));
}

/** The file's bytes: from disk (its latest version), else what the session itself holds. */
async function bytesOf(ctx: FileSaveContext, f: SessionFile): Promise<ArrayBuffer | null> {
	if (f.source) {
		const st = await ctx.fs.stat(f.source);
		if (st && st.size > MAX_BYTES) return null;
		const b = st ? await ctx.fs.readBytes(f.source) : null;
		if (b) return toBuffer(b);
	}
	if (f.base64) return fromBase64(f.base64);
	if (f.text !== undefined) return toBuffer(new TextEncoder().encode(f.text));
	return null;
}

export async function saveClaudeFiles(
	ctx: FileSaveContext,
	session: DesktopSession,
	folder: string,
	stem: string,
	previous: Record<string, string> = {},
): Promise<FileSaveResult> {
	const { app } = ctx;
	const out: FileSaveResult = { files: {}, saved: 0 };
	const base = ctx.vaultBase ? slashes(ctx.vaultBase) : undefined;
	for (const f of session.files ?? []) {
		if (f.source && base && sameOrUnder(f.source, base)) {
			// Already a note in this vault: link it where it is.
			const rel = slashes(f.source).slice(base.length + 1);
			const inVault = app.vault.getAbstractFileByPath(rel) ?? app.vault.getFiles().find((x) => x.path.toLowerCase() === rel.toLowerCase());
			if (inVault instanceof TFile) out.files[f.key] = inVault.path;
			continue;
		}
		if (f.source && !f.explicit && scratch(ctx, f.source)) continue;
		const bytes = await bytesOf(ctx, f);
		if (!bytes) continue;
		// Saved before (an earlier version of this session) and unchanged: link that copy.
		const old = previous[f.key] ? app.vault.getAbstractFileByPath(previous[f.key]!) : null;
		if (old instanceof TFile && old.stat.size === bytes.byteLength && equalBytes(await app.vault.readBinary(old), bytes)) {
			out.files[f.key] = old.path;
			continue;
		}
		const dir = `${folder}/${KIND_FOLDER[f.kind]}/${stem}`;
		await ensureFolder(app, dir);
		const path = `${dir}/${freeFileName(app, dir, safeFileName(f.name), numbered)}`;
		await createNew(app, path, bytes);
		out.files[f.key] = path;
		out.saved++;
	}
	return out;
}
