// Reads a thread file written by the ChatGPT/Codex desktop app or Codex CLI
// (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl). Pure code, no Obsidian.
//
// Shape seen 2026-11-07: { timestamp, type, payload } per line. The first line is
// "session_meta". The clean conversation is in event_msg "item_completed" records
// (UserMessage / AgentMessage; commands, file changes and searches are other item
// types). Older files have event_msg "user_message"/"agent_message" instead, and the
// raw model input/output is in "response_item" records, which we fall back to last.
// Thread titles live in ~/.codex/session_index.jsonl, not in the thread file.

import { jsonLines, obj, str, titleFrom, TurnBuilder } from './turns';
import type { DesktopSession } from './types';

/** Items that are the assistant's thinking, not a step worth counting. */
const NOT_A_STEP = new Set(['UserMessage', 'AgentMessage', 'Reasoning', 'Plan', 'ContextCompaction']);
/** Inputs Codex adds before your prompt (instructions, environment, open pages). */
const INJECTED = /^(<[a-z_]+[\s>]|# AGENTS\.md instructions|# Files mentioned by the user)/;

function itemText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	const out: string[] = [];
	for (const c of content) {
		const block = obj(c);
		const type = str(block?.type)?.toLowerCase() ?? '';
		const text = str(block?.text);
		if (text !== undefined && (type === 'text' || type === 'input_text' || type === 'output_text')) out.push(text);
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
	let firstPrompt: string | undefined;
	const user = (text: string, time?: string) => {
		const t = text.trim();
		if (!t) return;
		firstPrompt ??= t;
		b.user(t, time);
	};

	for (const { time, type, p } of payloads) {
		if (hasItems) {
			if (p.type !== 'item_completed') continue;
			const item = obj(p.item);
			const kind = str(item?.type) ?? '';
			if (kind === 'UserMessage') user(itemText(item?.content), time);
			else if (kind === 'AgentMessage') b.assistant(itemText(item?.content), time);
			else if (!NOT_A_STEP.has(kind)) b.tool(time);
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
	};
}
