// A Lumo chat as a Markdown transcript. Pure code, no AI.

import { localDateTime, modelProperty } from '../naming';
import { messageArtifacts, messageAttachments } from './assets';
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

/** Where the chat's saved files are, for the links in the note. No answer = not saved. */
export interface LumoFileLinks {
	/** Vault path of an attachment, by its asset tag. */
	attachment: (tag: string) => string | undefined;
	/** Vault path of an artifact, by its id in the chat. */
	artifact: (artifactId: string) => string | undefined;
	/** Files Lumo made that no message names. */
	extras: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const nameOf = (path: string): string => path.split('/').pop() ?? path;
const fileLink = (path: string, name = nameOf(path)): string => (IMAGE_EXT.test(path) ? `![[${path}]]` : `📎 [[${path}|${name}]]`);

function messageBody(m: LumoMessage, links?: LumoFileLinks, showReasoning = true): string {
	const parts: string[] = [];
	const p = m.private;
	if (showReasoning && typeof p.reasoning === 'string' && p.reasoning.trim()) parts.push(reasoningCallout(p.reasoning));
	if (typeof p.content === 'string' && p.content.trim()) parts.push(p.content.trim());
	const blocks = Array.isArray(p.blocks) ? p.blocks as { type?: unknown }[] : [];
	const tools = blocks.filter((b) => b?.type === 'tool_call').length || (p.toolCall ? 1 : 0);
	if (tools) parts.push(`*(${tools} tool step${tools === 1 ? '' : 's'})*`);
	// Files Lumo made in this message, then the files attached to it.
	const made = new Set<string>();
	for (const a of messageArtifacts(m)) {
		const path = links?.artifact(a.id);
		if (!path || made.has(path)) continue;
		made.add(path);
		parts.push(fileLink(path, a.title));
	}
	const tags = messageAttachments(m);
	const saved = tags.flatMap((t) => links?.attachment(t) ?? []);
	for (const path of saved) parts.push(fileLink(path));
	// Entries without an id are counted too, as before.
	const missing = Math.max(tags.length, Array.isArray(p.attachments) ? p.attachments.length : 0) - saved.length;
	if (missing > 0) parts.push(`*(${missing} attachment${missing === 1 ? '' : 's'}, not saved)*`);
	if (m.status === 'failed') parts.push('*(this answer failed)*');
	return parts.join('\n\n') || '*(no text)*';
}

/** `showReasoning`: the AI's reasoning, folded, above each answer (the account's switch; on unless turned off). */
export function renderLumoTranscript(chat: LumoChat, jsonFileName: string, links?: LumoFileLinks, showReasoning = true): string {
	const fm = ['---', `uuid: ${chat.id}`, `created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`];
	if (chat.project) fm.push(`project: ${y(chat.project)}`);
	if (chat.starred) fm.push('starred: true');
	fm.push(...modelProperty(shownBranch(chat.messages).filter((m) => m.role === 'assistant').map((m) => m.private.modelID)));
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body = shownBranch(chat.messages).flatMap((m) =>
		[`## ${m.role === 'user' ? 'You' : 'Lumo'} · ${localDateTime(m.createdAt)}`, '', messageBody(m, links, showReasoning), '']);
	if (links?.extras.length) body.push('## Files', '', ...links.extras.map((path) => fileLink(path)), '');
	return fm.join('\n') + body.join('\n');
}
