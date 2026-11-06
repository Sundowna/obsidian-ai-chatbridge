// Turns a chat's JSON into a plain Markdown transcript. Pure code, no AI.

import type { Chat, ChatMessage, ContentBlock, FileRef } from './types';
import { localDateTime } from './naming';

const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/**
 * A chat with edited or regenerated messages is a tree. The version you see in
 * claude.ai is the path from the root to `current_leaf_message_uuid`.
 */
export function activeBranch(chat: Chat): { messages: ChatMessage[]; hasOtherBranches: boolean } {
	const all = chat.chat_messages;
	const byId = new Map(all.map((m) => [m.uuid, m]));
	const leaf = chat.current_leaf_message_uuid ? byId.get(chat.current_leaf_message_uuid) : undefined;
	if (!leaf) {
		// No usable leaf: fall back to all messages in their stored order.
		const sorted = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		return { messages: sorted, hasOtherBranches: false };
	}
	const path: ChatMessage[] = [];
	const seen = new Set<string>();
	let cur: ChatMessage | undefined = leaf;
	while (cur && !seen.has(cur.uuid)) {
		seen.add(cur.uuid);
		path.push(cur);
		const parent: string | undefined = cur.parent_message_uuid;
		cur = parent && parent !== ROOT_PARENT ? byId.get(parent) : undefined;
	}
	path.reverse();
	return { messages: path, hasOtherBranches: path.length < all.length };
}

// With rendering_mode=messages, claude.ai sends each tool step (browser, search,
// connectors…) as a text block holding only this placeholder.
const TOOL_PLACEHOLDER = /^```\s*\n?\s*This block is not supported on your current device yet\.?\s*\n?\s*```$/;

type Part = { kind: 'text'; md: string } | { kind: 'tool' } | null;

function blockToPart(b: ContentBlock): Part {
	switch (b.type) {
		case 'text': {
			const t = typeof b.text === 'string' ? b.text.trim() : '';
			if (!t) return null;
			return TOOL_PLACEHOLDER.test(t) ? { kind: 'tool' } : { kind: 'text', md: t };
		}
		case 'tool_use':
			return { kind: 'tool' };
		case 'thinking':
		case 'redacted_thinking': // Claude's private reasoning: kept in the raw JSON, left out here.
		case 'tool_result': // Machine output: kept in the raw JSON.
			return null;
		default:
			return { kind: 'text', md: `*[${b.type} – see raw JSON]*` };
	}
}

function toolLine(n: number): string {
	return `*(${n} tool step${n === 1 ? '' : 's'})*`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** One line per file: embedded image, link to the saved file, or just its name. */
function fileLines(list: FileRef[] | undefined, filePaths: Map<string, string>): string[] {
	const out: string[] = [];
	for (const f of list ?? []) {
		const name = typeof f.file_name === 'string' ? f.file_name : '';
		const path = f.file_uuid ? filePaths.get(f.file_uuid) : undefined;
		if (path) out.push(f.file_kind === 'image' || IMAGE_EXT.test(path) ? `![[${path}]]` : `📎 [[${path}|${name || 'file'}]]`);
		else if (name) out.push(`*Attachment: ${name}*`);
	}
	return out;
}

function messageBody(m: ChatMessage, filePaths: Map<string, string>): string {
	const out: string[] = [];
	let tools = 0; // consecutive tool steps, merged into one line
	const flushTools = () => {
		if (tools) out.push(toolLine(tools));
		tools = 0;
	};
	if (Array.isArray(m.content) && m.content.length > 0) {
		for (const b of m.content) {
			const p = blockToPart(b);
			if (!p) continue;
			if (p.kind === 'tool') tools++;
			else {
				flushTools();
				out.push(p.md);
			}
		}
		flushTools();
	} else if (typeof m.text === 'string' && m.text.trim()) {
		out.push(m.text.trim());
	}
	out.push(...fileLines(m.attachments, filePaths), ...fileLines(m.files, filePaths));
	return out.join('\n\n') || '*(no text)*';
}

function speaker(sender: string): string {
	if (sender === 'human') return 'Human';
	if (sender === 'assistant') return 'Claude';
	return sender;
}

/** YAML-safe string (JSON strings are valid YAML double-quoted strings). */
function y(s: string): string {
	return JSON.stringify(s);
}

export interface TranscriptMeta {
	projectName?: string;
	jsonFileName: string;
	/** file_uuid -> vault path of the downloaded file */
	filePaths?: Map<string, string>;
	/** Files shown in claude.ai's chat view that are not mentioned in the chat data. */
	extraFiles?: { name: string; path: string }[];
}

export function renderTranscript(chat: Chat, meta: TranscriptMeta): string {
	const fm = [
		'---',
		`uuid: ${chat.uuid}`,
		`url: https://claude.ai/chat/${chat.uuid}`,
		`created: ${chat.created_at}`,
		`updated: ${chat.updated_at}`,
	];
	if (meta.projectName) fm.push(`project: ${y(meta.projectName)}`);
	fm.push(`raw: ${y(`[[${meta.jsonFileName}]]`)}`, 'unread: true', '---', '');

	const { messages, hasOtherBranches } = activeBranch(chat);
	const body: string[] = [];
	if (hasOtherBranches) {
		body.push(
			'> [!note] This chat has edited or regenerated messages. This transcript shows the current version; all versions are in the raw JSON.',
			'',
		);
	}
	for (const m of messages) {
		const when = m.created_at ? ` · ${localDateTime(m.created_at)}` : '';
		body.push(`## ${speaker(m.sender)}${when}`, '', messageBody(m, meta.filePaths ?? new Map<string, string>()), '');
	}
	if (meta.extraFiles?.length) {
		body.push('## Files', '');
		for (const f of meta.extraFiles) body.push(IMAGE_EXT.test(f.path) ? `![[${f.path}]]` : `📎 [[${f.path}|${f.name}]]`, '');
	}
	return fm.join('\n') + body.join('\n');
}
