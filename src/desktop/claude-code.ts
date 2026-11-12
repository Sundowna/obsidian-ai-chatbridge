// Reads a session file written by the Claude desktop app / Claude Code
// (~/.claude/projects/<folder>/<session-id>.jsonl). Pure code, no Obsidian.
//
// Shape seen 2026-11-07: one JSON object per line. "user"/"assistant" records hold
// { message: { role, content } }; tool results come back as "user" records whose
// content is only tool_result blocks. Titles come from "custom-title" (renamed by you)
// or "ai-title" records. Many other record types (attachments, request logs, file
// history) are bookkeeping and are left out of the transcript.

import { IMAGE_MARKER, SessionFileCollector } from './session-files';
import { jsonLines, obj, str, titleFrom, TurnBuilder } from './turns';
import type { DesktopSession } from './types';

/** Text the app adds to your prompts for the model, not typed by you. */
const STRIP_BLOCKS = /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g;
/** Prompts that are app notifications, not messages from you. */
const SKIP_PROMPT = /^<(task-notification|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/;

/** Your prompt as you wrote it: app-added blocks removed, slash commands and pasted text unwrapped. */
export function cleanClaudePrompt(text: string): string {
	// "[Image: source: <temp path>]": the app's note for a pasted image, which is shown itself.
	let t = text.replace(STRIP_BLOCKS, '').replace(/^\[Image: source: [^\]\n]*\]\s*$/gm, '').trim();
	if (!t || SKIP_PROMPT.test(t)) return '';
	const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
	if (cmd) {
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
		const name = cmd[1]!.trim();
		return `\`${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}\``;
	}
	t = t
		.replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content>/g, (_m, inner: string) => `> [!quote] Pasted\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}`)
		.replace(/<linked_content path="([^"]*)"\s*\/>/g, (_m, p: string) => `📎 ${p}`);
	return t.trim();
}

export function parseClaudeSession(text: string, fileId: string, appTitles: Map<string, string> = new Map()): DesktopSession | null {
	const records = jsonLines(text);
	const b = new TurnBuilder();
	const files = new SessionFileCollector();
	let id: string | undefined;
	let customTitle: string | undefined;
	let aiTitle: string | undefined;
	let summary: string | undefined;
	let firstPrompt: string | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let created: string | undefined;
	let updated: string | undefined;
	let sidechain: boolean | undefined;

	for (const [n, r] of records.entries()) {
		const type = str(r.type);
		const time = str(r.timestamp);
		if (time) {
			if (!created || time < created) created = time;
			if (!updated || time > updated) updated = time;
		}
		// A fork starts with records copied from its parent (with the parent's sessionId): the file name is the true ID.
		id ??= str(r.sessionId);
		if (type === 'custom-title') customTitle = str(r.customTitle) ?? customTitle;
		else if (type === 'ai-title') aiTitle = str(r.aiTitle) ?? aiTitle;
		else if (type === 'summary') summary = str(r.summary) ?? summary;
		if (type !== 'user' && type !== 'assistant') continue;

		cwd ??= str(r.cwd);
		sidechain ??= r.isSidechain === true;
		const msg = obj(r.message);
		const content = msg?.content;

		if (type === 'user') {
			if (Array.isArray(content)) for (const c of content) if (obj(c)?.type === 'tool_result') files.toolResult(obj(c)!);
			if (r.isMeta === true || r.isCompactSummary === true) continue;
			const recordId = str(r.uuid) ?? String(n);
			const pieces: string[] = [];
			if (typeof content === 'string') pieces.push(cleanClaudePrompt(content));
			else if (Array.isArray(content)) {
				for (const c of content) {
					const block = obj(c);
					if (block?.type === 'text') pieces.push(cleanClaudePrompt(str(block.text) ?? ''));
					else if (block?.type === 'image') pieces.push(files.image(recordId, block) ?? '*[image]*');
					else if (block?.type === 'document') files.document(recordId, block);
					// tool_result: the tool's answer, part of the assistant's work
				}
			}
			const prompt = pieces.filter(Boolean).join('\n\n');
			if (prompt) {
				firstPrompt ??= prompt.replace(IMAGE_MARKER, '').trim() || undefined;
				b.user(prompt, time);
			}
			continue;
		}

		model ??= str(msg?.model);
		if (!Array.isArray(content)) continue;
		for (const c of content) {
			const block = obj(c);
			if (block?.type === 'text') b.assistant(str(block.text) ?? '', time);
			else if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
				b.tool(time);
				files.toolUse(block, str(r.cwd) ?? cwd);
			}
			// thinking / redacted_thinking: private reasoning, kept out of the transcript
		}
	}

	const turns = b.result();
	if (!turns.some((t) => t.role === 'user') || !created || !updated) return null;
	return {
		app: 'claude',
		id: fileId || id || 'unknown',
		title: appTitles.get(fileId || id || '') ?? customTitle ?? aiTitle ?? summary ?? titleFrom(firstPrompt) ?? 'Untitled session',
		created,
		updated,
		cwd,
		model: model === '<synthetic>' ? undefined : model,
		isSubagent: sidechain === true,
		turns,
		...files.result(),
	};
}
