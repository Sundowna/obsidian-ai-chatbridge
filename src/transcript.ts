// Turns a chat's JSON into a plain Markdown transcript. Pure code, no AI.

import type { Chat, ChatMessage, ContentBlock, FileRef } from './types';
import { localDateTime, modelProperty } from './naming';
import { fitsInline, PASTE_PREVIEW_LINES, pastedLines, pastedText, type PastedText, type PasteMode } from './files';

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

/** Claude's reasoning as a folded callout, like Gemini's and Lumo's notes show theirs. */
function reasoningCallout(text: string): string {
	return ['> [!note]- Reasoning', ...text.trim().split('\n').map((l) => `> ${l}`)].join('\n');
}

function blockToPart(b: ContentBlock, showReasoning = false): Part {
	switch (b.type) {
		case 'text': {
			const t = typeof b.text === 'string' ? b.text.trim() : '';
			if (!t) return null;
			return TOOL_PLACEHOLDER.test(t) ? { kind: 'tool' } : { kind: 'text', md: t };
		}
		case 'tool_use':
			return { kind: 'tool' };
		case 'thinking': {
			// Claude's reasoning: always in the raw JSON; in the note only when the account's switch is on.
			const t = showReasoning && typeof b.thinking === 'string' ? b.thinking.trim() : '';
			return t ? { kind: 'text', md: reasoningCallout(t) } : null;
		}
		case 'redacted_thinking': // Reasoning claude.ai does not show: kept in the raw JSON, left out here.
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

const quoted = (lines: string[]): string[] => lines.map((l) => (l ? `> ${l}` : '>'));

/**
 * Text claude.ai keeps in the chat (issue #64), always as a callout with every line quoted, so
 * headings in the pasted text never become headings of the transcript. Up to 5 lines: all of
 * it. Longer: with "note", all of it; else a saved file's link with its first 5 lines, or (no
 * file saved) all of it folded.
 */
function pastedLine(p: PastedText, filePaths: Map<string, string>, mode: PasteMode): string {
	const label = p.fileName || 'Pasted text';
	const lines = pastedLines(p.text);
	if (fitsInline(p.text)) return [`> [!quote] ${label}`, ...quoted(lines)].join('\n');
	const count = `(${lines.length} lines)`;
	const path = mode === 'file' && p.key ? filePaths.get(p.key) : undefined;
	if (path) return [`> [!quote] [[${path}|${label}]] ${count}`, ...quoted(lines.slice(0, PASTE_PREVIEW_LINES)), '> …'].join('\n');
	return [`> [!quote]${mode === 'note' ? '' : '-'} ${label} ${count}`, ...quoted(lines)].join('\n');
}

function attachmentLines(list: FileRef[] | undefined, filePaths: Map<string, string>, mode: PasteMode): string[] {
	const out: string[] = [];
	for (const a of list ?? []) {
		const pasted = a.file_uuid && filePaths.has(a.file_uuid) ? null : pastedText(a);
		out.push(...(pasted ? [pastedLine(pasted, filePaths, mode)] : fileLines([a], filePaths)));
	}
	return out;
}

function messageBody(m: ChatMessage, filePaths: Map<string, string>, mode: PasteMode, showReasoning = false): string {
	const out: string[] = [];
	let tools = 0; // consecutive tool steps, merged into one line
	const flushTools = () => {
		if (tools) out.push(toolLine(tools));
		tools = 0;
	};
	if (Array.isArray(m.content) && m.content.length > 0) {
		for (const b of m.content) {
			const p = blockToPart(b, showReasoning);
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
	out.push(...attachmentLines(m.attachments, filePaths, mode), ...fileLines(m.files, filePaths));
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
	/** Put Claude's reasoning into the note, folded. Off unless the account's switch is on. */
	showReasoning?: boolean;
	/** Long pasted text: linked file with a preview, or all of it in the note (issue #64). */
	pasteMode?: PasteMode;
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
	if (chat.is_starred === true) fm.push('starred: true');
	// claude.ai names the chat's model at the top of its data (seen 2026-11-27).
	fm.push(...modelProperty([(chat as unknown as { model?: unknown }).model]));
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
		body.push(`## ${speaker(m.sender)}${when}`, '', messageBody(m, meta.filePaths ?? new Map<string, string>(), meta.pasteMode ?? 'file', meta.showReasoning === true), '');
	}
	if (meta.extraFiles?.length) {
		body.push('## Files', '');
		for (const f of meta.extraFiles) body.push(IMAGE_EXT.test(f.path) ? `![[${f.path}]]` : `📎 [[${f.path}|${f.name}]]`, '');
	}
	return fm.join('\n') + body.join('\n');
}
