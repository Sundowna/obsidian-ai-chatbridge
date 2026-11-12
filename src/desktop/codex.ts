// Reads a thread file written by the ChatGPT/Codex desktop app or Codex CLI
// (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl). Pure code, no Obsidian.
//
// Shape seen 2026-11-07: { timestamp, type, payload } per line. The first line is
// "session_meta". The clean conversation is in event_msg "item_completed" records
// (UserMessage / AgentMessage; commands, file changes and searches are other item
// types). Older files have event_msg "user_message"/"agent_message" instead, and the
// raw model input/output is in "response_item" records, which we fall back to last.
// Thread titles live in ~/.codex/session_index.jsonl, not in the thread file.

import { IMAGE_MARKER, SessionFileCollector } from './session-files';
import { jsonLines, obj, str, titleFrom, TurnBuilder } from './turns';
import type { DesktopSession } from './types';

/** Items that are the assistant's thinking, not a step worth counting. */
const NOT_A_STEP = new Set(['UserMessage', 'AgentMessage', 'Reasoning', 'Plan', 'ContextCompaction']);
/** Inputs Codex adds before your prompt (instructions, environment, open pages). */
const INJECTED = /^(<[a-z_]+[\s>]|# AGENTS\.md instructions|# Files mentioned by the user)/;

/** The block Codex puts before your prompt when you attach files: "## <name>: <path>" per file. */
const MENTIONED = /^\s*# Files mentioned by the user:\s*\n([\s\S]*?)\n## My request:[ \t]*\n?/;

/** Your prompt without the attachment block; attached files (not images, which come as their own blocks) become links. */
function withAttachments(text: string, files?: SessionFileCollector): string {
	const m = MENTIONED.exec(text);
	if (!m) return text;
	const links: string[] = [];
	for (const entry of m[1]!.split(/\n(?=## )/)) {
		const head = /^## (.+?): (.+)$/m.exec(entry);
		if (!head || /^Image attachment: true$/m.test(entry)) continue;
		links.push(files ? files.attached(head[2]!.trim()) : `📎 ${head[1]!.trim()}`);
	}
	const rest = text.slice(m[0].length).trim();
	return [...links, rest].filter(Boolean).join('\n');
}

/**
 * Text of a message. With a collector, attached images and files become markers the renderer
 * links to the saved copies; `nextImage` gives the thread's inline copy of each image in turn.
 */
function itemText(content: unknown, files?: SessionFileCollector, nextImage?: () => string | undefined): string {
	if (!Array.isArray(content)) return '';
	const out: string[] = [];
	for (const c of content) {
		const block = obj(c);
		const type = str(block?.type)?.toLowerCase() ?? '';
		const text = str(block?.text);
		const path = str(block?.path);
		if (text !== undefined && (type === 'text' || type === 'input_text' || type === 'output_text')) out.push(withAttachments(text, files));
		else if (type === 'local_image' && files && path) out.push(files.localImage(path, nextImage?.()));
		else if (type.includes('image')) out.push('*[image]*');
	}
	return out.join('\n\n');
}

/** Latest thread name per ID from session_index.jsonl. */
export function codexTitles(indexText: string): Map<string, string> {
	const titles = new Map<string, string>();
	for (const r of jsonLines(indexText)) {
		const id = str(r.id);
		const name = str(r.thread_name);
		if (id && name) titles.set(id, name);
	}
	return titles;
}

export function parseCodexSession(text: string, titles: Map<string, string> = new Map()): DesktopSession | null {
	const records = jsonLines(text);
	const metaRec = records.find((r) => r.type === 'session_meta');
	const meta = obj(metaRec?.payload);
	const id = str(meta?.id);
	if (!id) return null;

	let created = str(meta?.timestamp) ?? str(metaRec?.timestamp);
	let updated = created;
	let model: string | undefined;
	for (const r of records) {
		const t = str(r.timestamp);
		if (!t) continue;
		if (!created || t < created) created = t;
		if (!updated || t > updated) updated = t;
		if (r.type === 'turn_context') model ??= str(obj(r.payload)?.model);
	}

	const payloads = records.map((r) => ({ time: str(r.timestamp), type: str(r.type), p: obj(r.payload) ?? {} }));
	const hasItems = payloads.some((x) => x.p.type === 'item_completed' && obj(x.p.item)?.type === 'UserMessage');
	const hasEvents = !hasItems && payloads.some((x) => x.type === 'event_msg' && x.p.type === 'user_message');

	const b = new TurnBuilder();
	const files = new SessionFileCollector();
	// Inline copies of the images you attached, in order (used when the image file is gone).
	const inlineImages: string[] = [];
	for (const { type, p } of payloads) {
		if (type !== 'response_item' || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) continue;
		for (const c of p.content) {
			const url = str(obj(c)?.image_url);
			if (obj(c)?.type === 'input_image' && url?.startsWith('data:')) inlineImages.push(url);
		}
	}
	const nextImage = () => inlineImages.shift();
	let firstPrompt: string | undefined;
	const user = (text: string, time?: string) => {
		const t = text.trim();
		if (!t) return;
		firstPrompt ??= t.replace(IMAGE_MARKER, '').trim() || undefined;
		b.user(t, time);
	};

	for (const { time, type, p } of payloads) {
		if (hasItems) {
			if (p.type !== 'item_completed') continue;
			const item = obj(p.item);
			const kind = str(item?.type) ?? '';
			if (kind === 'UserMessage') user(itemText(item?.content, files, nextImage), time);
			else if (kind === 'AgentMessage') b.assistant(itemText(item?.content), time);
			else if (!NOT_A_STEP.has(kind)) {
				b.tool(time);
				const changes = obj(item?.changes);
				if (kind === 'FileChange' && changes) files.fileChanges(changes);
			}
		} else if (hasEvents) {
			if (type !== 'event_msg') {
				if (type === 'response_item' && /call$/.test(str(p.type) ?? '')) b.tool(time);
				continue;
			}
			if (p.type === 'user_message') user(str(p.message) ?? '', time);
			else if (p.type === 'agent_message') b.assistant(str(p.message) ?? '', time);
		} else if (type === 'response_item') {
			const kind = str(p.type) ?? '';
			if (kind === 'message' && p.role === 'user') {
				const t = itemText(p.content);
				if (!INJECTED.test(t.trim())) user(t, time);
			} else if (kind === 'message' && p.role === 'assistant') b.assistant(itemText(p.content), time);
			else if (/call$/.test(kind)) b.tool(time);
		}
	}

	const turns = b.result();
	if (!turns.some((t) => t.role === 'user') || !created || !updated) return null;
	const source = meta?.source;
	const isSubagent = !!obj(source)?.subagent || (!!str(meta?.parent_thread_id) && meta?.thread_source !== 'user');
	return {
		app: 'codex',
		id,
		title: titles.get(id) ?? titleFrom(firstPrompt) ?? 'Untitled thread',
		created,
		updated,
		cwd: str(meta?.cwd),
		model,
		forkedFrom: str(meta?.forked_from_id),
		isSubagent,
		ownerId: str(meta?.creator_account_id),
		turns,
		files: files.result().files,
	};
}
