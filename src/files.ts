// Files inside a chat (pure, testable offline).
// The chat JSON lists them with a file_uuid; their bytes come from
// GET /api/organizations/<org>/files/<file_uuid>/contents (seen in DevTools).

import type { Chat } from './types';
import { safeTitle } from './naming';
import { isUuid } from './schema';

/** artifact = Claude created it; attachment = you uploaded it. */
export type FileKind = 'artifact' | 'attachment';

export const KIND_FOLDER: Record<FileKind, string> = { artifact: 'Artifacts', attachment: 'Attachments' };

export interface FileTask {
	fileUuid: string;
	name: string;
	sizeBytes?: number;
	kind: FileKind;
	isImage: boolean;
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
