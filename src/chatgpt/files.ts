// Files inside a ChatGPT chat (pure, testable offline). Seen 2026-11-06:
//   messages[].content.parts[] { content_type: "image_asset_pointer", asset_pointer: "sediment://file_…", size_bytes, mime_type }
//   messages[].metadata.attachments[] { id: "file_…", name, size, mime_type }   (files you uploaded)
//   messages[].metadata.image_gen_title                                         (title of a generated image)
// Voice recordings (metadata.dictation_asset_pointer) are left out.

import type { FileKind, FileTask } from '../files';
import { safeTitle } from '../naming';
import { isFileId } from './schema';
import type { GptChat, GptMessage, GptPart } from './types';

const EXT: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp',
	'image/gif': '.gif',
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** "sediment://file_123" or "file-service://file-123" -> "file_123" / "file-123" */
export function pointerId(pointer: unknown): string | null {
	if (typeof pointer !== 'string') return null;
	const id = pointer.slice(pointer.lastIndexOf('/') + 1);
	return isFileId(id) ? id : null;
}

export function imageParts(m: GptMessage): GptPart[] {
	return (m.content.parts ?? []).filter((p): p is GptPart => typeof p === 'object' && p !== null && p.content_type === 'image_asset_pointer');
}

/** All downloadable files in a chat, each file ID once. */
export function gptChatFiles(chat: GptChat): FileTask[] {
	const seen = new Set<string>();
	const out: FileTask[] = [];
	const add = (id: string | null, name: string, sizeBytes: number | undefined, kind: FileKind, image: boolean) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push({ fileUuid: id, name, sizeBytes, kind, isImage: image || IMAGE_EXT.test(name) });
	};
	for (const m of chat.messages) {
		const kind: FileKind = m.author.role === 'user' ? 'attachment' : 'artifact';
		const uploads = m.metadata?.attachments ?? [];
		for (const p of imageParts(m)) {
			const id = pointerId(p.asset_pointer);
			const uploaded = uploads.find((a) => a.id === id)?.name;
			const ext = EXT[String(p.mime_type)] ?? '';
			const title = typeof m.metadata?.image_gen_title === 'string' ? safeTitle(m.metadata.image_gen_title) : 'image';
			add(id, uploaded || `${title}${ext}`, typeof p.size_bytes === 'number' ? p.size_bytes : undefined, kind, true);
		}
		for (const a of uploads) {
			if (typeof a.name === 'string' && a.name.trim()) {
				add(isFileId(a.id) ? a.id : null, a.name.trim(), typeof a.size === 'number' ? a.size : undefined, kind, String(a.mime_type).startsWith('image/'));
			}
		}
	}
	return out;
}
