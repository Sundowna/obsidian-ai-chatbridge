// A Lumo chat as a Markdown transcript. Pure code, no AI.

import { localDateTime } from '../naming';
import type { LumoChat, LumoMessage } from './types';

const y = (s: string): string => JSON.stringify(s);

/** The conversation as last shown: from the newest message back to the first. Retries live only in the raw file. */
export function shownBranch(messages: readonly LumoMessage[]): LumoMessage[] {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const out: LumoMessage[] = [];
	const seen = new Set<string>();
	let m = messages[messages.length - 1];
	while (m && !seen.has(m.id)) {
		seen.add(m.id);
		out.unshift(m);
		m = m.parentId ? byId.get(m.parentId) : undefined;
	}
	return out;
}

function reasoningCallout(text: string): string {
	return ['> [!note]- Reasoning', ...text.trim().split('\n').map((l) => `> ${l}`)].join('\n');
}

function messageBody(m: LumoMessage): string {
	const parts: string[] = [];
	const p = m.private;
	if (typeof p.reasoning === 'string' && p.reasoning.trim()) parts.push(reasoningCallout(p.reasoning));
	if (typeof p.content === 'string' && p.content.trim()) parts.push(p.content.trim());
	const blocks = Array.isArray(p.blocks) ? p.blocks as { type?: unknown }[] : [];
	const tools = blocks.filter((b) => b?.type === 'tool_call').length || (p.toolCall ? 1 : 0);
	if (tools) parts.push(`*(${tools} tool step${tools === 1 ? '' : 's'})*`);
	const attached = Array.isArray(p.attachments) ? p.attachments.length : 0;
	if (attached) parts.push(`*(${attached} attachment${attached === 1 ? '' : 's'}, not saved)*`);
	if (m.status === 'failed') parts.push('*(this answer failed)*');
	return parts.join('\n\n') || '*(no text)*';
}

export function renderLumoTranscript(chat: LumoChat, jsonFileName: string): string {
	const fm = ['---', `uuid: ${chat.id}`, `created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`];
	if (chat.project) fm.push(`project: ${y(chat.project)}`);
	if (chat.starred) fm.push('starred: true');
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body = shownBranch(chat.messages).flatMap((m) =>
		[`## ${m.role === 'user' ? 'You' : 'Lumo'} · ${localDateTime(m.createdAt)}`, '', messageBody(m), '']);
	return fm.join('\n') + body.join('\n');
}
