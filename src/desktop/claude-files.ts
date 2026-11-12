// Files that belong to a Claude Code session (desktop app Code tab). Pure code, no Obsidian.
//
// Shapes seen 2026-11-12 in ~/.claude/projects/<folder>/<session>.jsonl:
//   You:    "user" records with { type: "image", source: { type: "base64", media_type, data } }
//           (the app also adds a text "[Image: source: <temp path>]" for each pasted image).
//   Claude: tool_use "Write" { file_path, content }, "Edit" { file_path, old_string, new_string, replace_all },
//           "MultiEdit" { file_path, edits[] }, "NotebookEdit" { notebook_path },
//           "SendUserFile" { files[] }, "Artifact" { file_path?, files?, root?, url?, title? }
//           whose tool_result says "... Artifact at https://claude.ai/artifact/<id> ...",
//           and Claude Docs (an MCP "batch" call with a "container") whose result links the doc.
// The file content is read from disk at sync time (its latest version). A file that is gone
// from disk falls back to what the session itself wrote, if it holds the whole file.

import { obj, str } from './turns';

export type SessionFileKind = 'artifact' | 'attachment';

export interface SessionFile {
	kind: SessionFileKind;
	/** Stable ID across syncs: "image:<record>:<n>" or the lower-case source path. */
	key: string;
	/** File name to save it under. */
	name: string;
	/** Where it is on this computer (artifacts). */
	source?: string;
	/** Content the session holds itself: an image's bytes, or a file Claude wrote in full. */
	base64?: string;
	text?: string;
	/** Sent to you or published on purpose (any file type), not just written along the way. */
	explicit: boolean;
}

export interface SessionLink {
	url: string;
	title: string;
	kind: 'artifact' | 'doc';
}

/** Marker the parser leaves in a prompt where a pasted image was; the renderer replaces it. */
export const imageMarker = (key: string) => `\uE000IMG:${key}\uE000`;
export const IMAGE_MARKER = /\uE000IMG:([^\uE000]+)\uE000/g;

/** Files Claude wrote along the way that count as results (not source code or config). */
const DOC_EXT = /\.(md|markdown|txt|html?|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|svg|png|jpe?g|gif|webp|bmp|mp3|wav|m4a|mp4|webm|mov|epub|canvas|excalidraw)$/i;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;
const MEDIA_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const isAbs = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
const slashes = (p: string) => p.replace(/\\/g, '/');
export function resolvePath(p: string, base: string | undefined): string {
	const s = slashes(p.trim());
	if (isAbs(s) || !base) return s;
	return `${slashes(base).replace(/\/+$/, '')}/${s.replace(/^\.\//, '')}`;
}
const baseNameOf = (p: string) => slashes(p).split('/').pop() || p;

export class SessionFileCollector {
	private readonly files = new Map<string, SessionFile>();
	private readonly links = new Map<string, SessionLink>();
	/** tool_use id -> what to do with its result. */
	private readonly pending = new Map<string, { kind: 'artifact' | 'doc'; title: string; skip: Set<string> }>();
	private imageCount = 0;

	/** A pasted image; returns the marker to put in the prompt. */
	image(recordId: string, block: Record<string, unknown>): string | null {
		const src = obj(block.source);
		const data = str(src?.data);
		if (src?.type !== 'base64' || !data) return null;
		const n = ++this.imageCount;
		const key = `image:${recordId}:${n}`;
		const ext = MEDIA_EXT[str(src.media_type) ?? ''] ?? 'png';
		this.files.set(key, { kind: 'attachment', key, name: `Image ${n}.${ext}`, base64: data, explicit: true });
		return imageMarker(key);
	}

	/** A pasted document (PDF etc.), if the app ever sends one inline. */
	document(recordId: string, block: Record<string, unknown>): void {
		const src = obj(block.source);
		const data = str(src?.data);
		if (src?.type !== 'base64' || !data) return;
		const key = `doc:${recordId}:${this.files.size}`;
		const ext = MEDIA_EXT[str(src.media_type) ?? ''] ?? 'bin';
		const name = str(block.title) ?? `Document.${ext}`;
		this.files.set(key, { kind: 'attachment', key, name, base64: data, explicit: true });
	}

	private artifact(path: string, explicit: boolean): SessionFile | undefined {
		if (!path) return undefined;
		const key = path.toLowerCase();
		const known = this.files.get(key);
		if (known) {
			if (explicit) known.explicit = true;
			return known;
		}
		if (!explicit && !DOC_EXT.test(path)) return undefined;
		const f: SessionFile = { kind: 'artifact', key, name: baseNameOf(path), source: path, explicit };
		this.files.set(key, f);
		return f;
	}

	toolUse(block: Record<string, unknown>, cwd: string | undefined): void {
		const name = str(block.name) ?? '';
		const input = obj(block.input) ?? {};
		const id = str(block.id);
		const at = (p: unknown) => (typeof p === 'string' && p.trim() ? resolvePath(p, cwd) : '');
		if (name === 'Write') {
			const f = this.artifact(at(input.file_path), false);
			if (f) f.text = str(input.content);
		} else if (name === 'Edit' || name === 'MultiEdit') {
			const f = this.artifact(at(input.file_path), false);
			if (!f || f.text === undefined) return;
			const edits = name === 'Edit' ? [input] : (Array.isArray(input.edits) ? input.edits.map(obj).filter((e) => !!e) : []);
			for (const e of edits) {
				const from = str(e.old_string);
				const to = str(e.new_string) ?? '';
				if (!from || !f.text.includes(from)) {
					f.text = undefined; // can't follow the edit: only the file on disk is trusted
					return;
				}
				f.text = e.replace_all === true ? f.text.split(from).join(to) : f.text.replace(from, () => to);
			}
		} else if (name === 'NotebookEdit') {
			this.artifact(at(input.notebook_path), false);
		} else if (name === 'SendUserFile') {
			for (const p of Array.isArray(input.files) ? input.files : []) this.artifact(at(p), true);
		} else if (name === 'Artifact') {
			const action = str(input.action) ?? 'publish';
			if (action !== 'publish' || input.asset === true) return;
			const root = typeof input.root === 'string' ? resolvePath(input.root, cwd) : cwd;
			const page = at(input.file_path);
			if (page) this.artifact(page, true);
			const files = obj(input.files);
			for (const v of files ? Object.values(files) : Array.isArray(input.files) ? input.files : []) {
				const from = typeof v === 'string' ? v : str(obj(v)?.from) ?? str(obj(v)?.path);
				if (from) this.artifact(resolvePath(from, root), true);
			}
			const url = str(input.url);
			const title = str(input.title) ?? (page ? baseNameOf(page).replace(/\.[^.]+$/, '') : 'Artifact');
			if (url) this.addLink(url, title, 'artifact');
			const skip = new Set([str(input.type_url) ?? ''].filter(Boolean));
			if (id) this.pending.set(id, { kind: 'artifact', title, skip });
		} else if (name.startsWith('mcp__') && obj(input.container)) {
			// Claude Docs: a doc is made (or changed) through its "batch"/"update" tools.
			const create = obj(obj(input.container)?.create);
			const title = str(create?.name) ?? 'Claude Doc';
			if (id) this.pending.set(id, { kind: 'doc', title, skip: new Set() });
		}
	}

	toolResult(block: Record<string, unknown>): void {
		const id = str(block.tool_use_id);
		const p = id ? this.pending.get(id) : undefined;
		if (!p || block.is_error === true) return;
		const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
		// The first link in the answer is the artifact or doc itself; later ones are types or references.
		const url = [...text.matchAll(ARTIFACT_URL)].map((m) => m[0]).find((u) => !p.skip.has(u));
		if (url) this.addLink(url, p.title, p.kind);
	}

	private addLink(url: string, title: string, kind: 'artifact' | 'doc'): void {
		const known = this.links.get(url);
		if (known) {
			if (known.title === 'Artifact' || known.title === 'Claude Doc') known.title = title;
			return;
		}
		this.links.set(url, { url, title, kind });
	}

	result(): { files: SessionFile[]; links: SessionLink[] } {
		const files = [...this.files.values()];
		// Several files with one name (e.g. many SKILL.md): name each after its folder too.
		const count = new Map<string, number>();
		for (const f of files) count.set(f.name.toLowerCase(), (count.get(f.name.toLowerCase()) ?? 0) + 1);
		for (const f of files) {
			const parent = f.source ? slashes(f.source).split('/').slice(-2, -1)[0] : undefined;
			if (parent && !/^[a-z]:$/i.test(parent) && (count.get(f.name.toLowerCase()) ?? 0) > 1) f.name = `${parent} - ${f.name}`;
		}
		return { files, links: [...this.links.values()] };
	}
}
