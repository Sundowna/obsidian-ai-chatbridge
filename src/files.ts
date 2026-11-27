// Files inside a chat (pure, testable offline).
// The chat JSON lists them with a file_uuid; their bytes come from
// GET /api/organizations/<org>/files/<file_uuid>/contents (seen in DevTools).

import type { Chat, FileRef } from './types';
import { safeTitle } from './naming';
import { isUuid } from './schema';

/** artifact = Claude created it; attachment = you uploaded it. */
export type FileKind = 'artifact' | 'attachment';

export const KIND_FOLDER: Record<FileKind, string> = { artifact: 'Artifacts', attachment: 'Attachments' };

export interface FileTask {
	/** The file's ID; for a Claude-made file known only by its path, a key from outputKey(). */
	fileUuid: string;
	name: string;
	sizeBytes?: number;
	kind: FileKind;
	isImage: boolean;
	/** Set for a Claude-made file fetched by its path in the chat's file store (issue #46). */
	output?: { chatUuid: string; path: string };
	/** Set for text kept in the chat JSON itself (a "Pasted" card): saved without a download (issue #64). */
	text?: string;
}

/** Folder in a chat's file store where Claude's own files (download cards) live. */
export const OUTPUTS_DIR = '/mnt/user-data/outputs/';

/** An exact file path inside OUTPUTS_DIR: no "." or ".." parts, no line breaks, not a folder. */
export function isOutputPath(p: string): boolean {
	if (!p.startsWith(OUTPUTS_DIR) || p.length <= OUTPUTS_DIR.length || p.length > 1024 || p.endsWith('/')) return false;
	if ([...p].some((ch) => ch.charCodeAt(0) < 32)) return false; // no control characters
	return p.slice(OUTPUTS_DIR.length).split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Key in the file index for a file known only by its path in one chat's file store. */
export function outputKey(chatUuid: string, path: string): string {
	return `output:${chatUuid}:${path}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** All downloadable files in a chat (every branch), each file_uuid once. */
export function chatFiles(chat: Chat): FileTask[] {
	const seen = new Set<string>();
	const out: FileTask[] = [];
	for (const m of chat.chat_messages) {
		const kind: FileKind = m.sender === 'assistant' ? 'artifact' : 'attachment';
		for (const f of [...(m.files ?? []), ...(m.attachments ?? [])]) {
			const id = f.file_uuid;
			if (!isUuid(id) || seen.has(id) || f.success === false) continue;
			seen.add(id);
			const name = typeof f.file_name === 'string' && f.file_name.trim() ? f.file_name.trim() : id;
			out.push({
				fileUuid: id,
				name,
				sizeBytes: typeof f.size_bytes === 'number' ? f.size_bytes : undefined,
				kind,
				isImage: f.file_kind === 'image' || IMAGE_EXT.test(name),
			});
		}
	}
	return out;
}

/**
 * Text that claude.ai keeps inside the chat JSON itself (issue #64): a long paste becomes a
 * "Pasted" card, a text file you add is read in. Both are messages[].attachments[] with
 * { id, file_name ("" for a paste), file_size, file_type, extracted_content } and no
 * file_uuid (seen 2026-11-07). Short ones are written into the note; longer ones are saved
 * as a file (with "Download files" on) and linked, else folded into the note.
 */
export const PASTE_INLINE_CHARS = 3000;
export const PASTE_INLINE_LINES = 60;

export interface PastedText {
	/** Key in the file index: "pasted:<attachment id>", or null without an ID. */
	key: string | null;
	/** The file's own name, or "" for a paste. */
	fileName: string;
	text: string;
}

/** The text in an attachment, or null when it has none (or is a downloadable file). */
export function pastedText(a: FileRef): PastedText | null {
	const text = typeof a.extracted_content === 'string' ? a.extracted_content : '';
	if (!text.trim()) return null;
	const id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : null;
	return { key: id ? `pasted:${id}` : null, fileName: typeof a.file_name === 'string' ? a.file_name.trim() : '', text };
}

/** Short enough to read in the note itself (about two screen pages). */
export function fitsInline(text: string): boolean {
	return text.length <= PASTE_INLINE_CHARS && text.split('\n').length <= PASTE_INLINE_LINES;
}

/** File name for a saved paste: its own name, else "Pasted text.md". */
export function pastedName(p: PastedText): string {
	return p.fileName || 'Pasted text.md';
}

/** Long pasted texts of a chat (every branch), to save as files; each ID once. */
export function pastedFiles(chat: Chat): FileTask[] {
	const seen = new Set<string>();
	const out: FileTask[] = [];
	for (const m of chat.chat_messages) {
		for (const a of m.attachments ?? []) {
			if (isUuid(a.file_uuid)) continue; // a real file: downloaded by chatFiles
			const p = pastedText(a);
			if (!p?.key || seen.has(p.key) || fitsInline(p.text)) continue;
			seen.add(p.key);
			out.push({ fileUuid: p.key, name: pastedName(p), kind: 'attachment', isImage: false, text: p.text });
		}
	}
	return out;
}

function obj(x: unknown): Record<string, unknown> | null {
	return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
function arr(x: unknown): unknown[] {
	return Array.isArray(x) ? x : [];
}
function str(x: unknown): string {
	return typeof x === 'string' ? x : '';
}
function size(x: unknown): number | undefined {
	const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Files the claude.ai chat view shows (download cards, images, ZIPs), read from the
 * JSON answer of ConversationService/ReadConversation (seen 2026-11-06):
 *   update.messages[].attachments[]                       { id, fileName, fileSize, fileKind, … }
 *   update.contentBlocks[].displayContent.multiFile.files[] { attachmentId, title, … }
 * Unknown shapes are skipped, never guessed.
 */
export function visibleFiles(answer: unknown): FileTask[] {
	const update = obj(obj(answer)?.update);
	if (!update) return [];
	const seen = new Set<string>();
	const out: FileTask[] = [];
	const add = (id: string, name: string, sizeBytes: number | undefined, kind: FileKind, image: boolean) => {
		if (!isUuid(id) || seen.has(id)) return;
		seen.add(id);
		const n = name.trim() || id;
		out.push({ fileUuid: id, name: n, sizeBytes, kind, isImage: image || IMAGE_EXT.test(n) });
	};
	for (const m of arr(update.messages)) {
		const msg = obj(m);
		if (!msg) continue;
		const kind: FileKind = /USER|HUMAN/i.test(str(msg.role)) ? 'attachment' : 'artifact';
		for (const a of arr(msg.attachments)) {
			const at = obj(a);
			if (at) add(str(at.id), str(at.fileName), size(at.fileSize), kind, /IMAGE/i.test(str(at.fileKind)));
		}
	}
	for (const b of arr(update.contentBlocks)) {
		const files = arr(obj(obj(obj(b)?.displayContent)?.multiFile)?.files);
		for (const f of files) {
			const fo = obj(f);
			if (fo) add(str(fo.attachmentId), str(fo.title), size(fo.fileSize ?? fo.sizeBytes), 'artifact', false);
		}
	}
	return out;
}

/**
 * Claude-made files named by their path in the chat's tool calls, for accounts where claude.ai
 * does not offer the chat view (ReadConversation 403 "blocked_by_org_tier", issue #46).
 * Read from the chat JSON asked for with render_all_tools=true; the plain chat JSON has no
 * tool calls. Seen 2026-11-26: tool_use inputs such as files[].stagedPath or file_path hold
 * the path. Every string in a tool_use input that is exactly a path under OUTPUTS_DIR counts,
 * whatever the field is called; paths merely mentioned in text or in a command are ignored.
 */
export function outputFiles(chat: unknown, chatUuid: string): FileTask[] {
	const paths = new Set<string>();
	const collect = (x: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof x === 'string') {
			if (isOutputPath(x)) paths.add(x);
		} else if (Array.isArray(x)) {
			for (const v of x) collect(v, depth + 1);
		} else {
			const o = obj(x);
			if (o) for (const v of Object.values(o)) collect(v, depth + 1);
		}
	};
	for (const m of arr(obj(chat)?.chat_messages)) {
		for (const b of arr(obj(m)?.content)) {
			const block = obj(b);
			if (block?.type === 'tool_use') collect(block.input, 0);
		}
	}
	return [...paths].map((path) => {
		const name = path.slice(path.lastIndexOf('/') + 1);
		return { fileUuid: outputKey(chatUuid, path), name, kind: 'artifact', isImage: IMAGE_EXT.test(name), output: { chatUuid, path } };
	});
}

/** Joins file lists; the first list wins for duplicates (same file ID). */
export function mergeFiles(...lists: FileTask[][]): FileTask[] {
	const seen = new Set<string>();
	const out: FileTask[] = [];
	for (const list of lists) {
		for (const f of list) {
			if (seen.has(f.fileUuid)) continue;
			seen.add(f.fileUuid);
			out.push(f);
		}
	}
	return out;
}

/** Safe file name that keeps the extension, e.g. "my: file?.py" -> "my- file-.py". */
export function safeFileName(name: string): string {
	const dot = name.lastIndexOf('.');
	const hasExt = dot > 0 && name.length - dot <= 12;
	const ext = hasExt ? name.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : '';
	const base = safeTitle(hasExt ? name.slice(0, dot) : name);
	return ext.length > 1 ? `${base}${ext}` : base;
}

/** "name.ext" -> "name (2).ext" */
export function numbered(fileName: string, n: number): string {
	const dot = fileName.lastIndexOf('.');
	return dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`;
}
