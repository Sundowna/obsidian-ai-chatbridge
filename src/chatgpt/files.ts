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

export interface GptFileTask extends FileTask {
	sandbox?: { messageId: string; path: string };
}

export function sandboxPath(reference: string): string | null {
	if (!reference.startsWith('sandbox:')) return null;
	try {
		const path = decodeURIComponent(reference.slice(8)).replace(/^\/\/mnt\//, '/mnt/').replace(/^\/\/\/mnt\//, '/mnt/');
		if (!path.startsWith('/mnt/data/') || path.includes('\\')) return null;
		if ([...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
		if (path.slice(10).split('/').some((part) => !part || part === '.' || part === '..')) return null;
		return path;
	} catch {
		return null;
	}
}

export function sandboxKey(chatId: string, messageId: string, path: string): string {
	return JSON.stringify(['sandbox', chatId, messageId, path]);
}

/** Rewrite actual Markdown link destinations, with one level of balanced filename parentheses. */
export function sandboxLinks(text: string, replace: (label: string, path: string) => string): string {
	return text.replace(/!?\[([^\]\r\n]*)\]\((?:<(sandbox:[^>\r\n]+)>|(sandbox:(?:[^()\r\n]|\([^()\r\n]*\))+))\)/g,
		(link: string, label: string, angle: string | undefined, plain: string | undefined) => {
			const path = sandboxPath((angle ?? plain ?? '').trim());
			return path ? replace(label, path) : link;
		});
}

export function fallbackMarkdown(m: GptMessage): string | null {
	const dil = m.metadata?.model_dil_v2;
	const value = typeof dil === 'object' && dil !== null ? (dil as { fallbackMarkdown?: unknown }).fallbackMarkdown : undefined;
	return typeof value === 'string' && value.trim() ? value : null;
}

/** "sediment://file_123" or "file-service://file-123" -> "file_123" / "file-123" */
export function pointerId(pointer: unknown): string | null {
	if (typeof pointer !== 'string') return null;
	const id = pointer.slice(pointer.lastIndexOf('/') + 1);
	return isFileId(id) ? id : null;
}

export function imageParts(m: GptMessage): GptPart[] {
	return (Array.isArray(m.content.parts) ? m.content.parts : []).filter((p): p is GptPart => typeof p === 'object' && p !== null && p.content_type === 'image_asset_pointer');
}

/** All downloadable files in a chat, each file ID once. */
export function gptChatFiles(chat: GptChat): GptFileTask[] {
	const seen = new Set<string>();
	const out: GptFileTask[] = [];
	const add = (id: string | null, name: string, sizeBytes: number | undefined, kind: FileKind, image: boolean) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push({ fileUuid: id, name, sizeBytes, kind, isImage: image || IMAGE_EXT.test(name) });
	};
	for (const m of chat.messages) {
		const kind: FileKind = m.author.role === 'user' ? 'attachment' : 'artifact';
		const uploads = Array.isArray(m.metadata?.attachments) ? m.metadata.attachments : [];
		for (const p of imageParts(m)) {
			const id = pointerId(p.asset_pointer);
			const uploaded = uploads.find((a) => a?.id === id)?.name;
			const ext = EXT[String(p.mime_type)] ?? '';
			const title = typeof m.metadata?.image_gen_title === 'string' ? safeTitle(m.metadata.image_gen_title) : 'image';
			add(id, uploaded || `${title}${ext}`, typeof p.size_bytes === 'number' ? p.size_bytes : undefined, kind, true);
		}
		for (const a of uploads) {
			if (a && typeof a.name === 'string' && a.name.trim()) {
				add(isFileId(a.id) ? a.id : null, a.name.trim(), typeof a.size === 'number' ? a.size : undefined, kind, String(a.mime_type).startsWith('image/'));
			}
		}
		if (m.author.role === 'assistant' && (!m.recipient || m.recipient === 'all') && !m.metadata?.is_visually_hidden_from_conversation) {
			const parts = Array.isArray(m.content.parts) ? m.content.parts : [];
			for (const text of [...parts, fallbackMarkdown(m)]) {
				if (typeof text !== 'string') continue;
				sandboxLinks(text, (_label, path) => {
					const fileUuid = sandboxKey(chat.conversation_id, m.id, path);
					if (!seen.has(fileUuid)) {
						seen.add(fileUuid);
						const name = path.split('/').pop()!;
						out.push({ fileUuid, name, kind: 'artifact', isImage: IMAGE_EXT.test(name), sandbox: { messageId: m.id, path } });
					}
					return '';
				});
			}
		}
	}
	return out;
}
