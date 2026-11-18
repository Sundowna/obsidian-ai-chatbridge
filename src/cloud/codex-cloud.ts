// Codex cloud tasks (chatgpt.com/codex). Pure code, no Obsidian.
//
// Shapes NOT yet seen in DevTools. They are taken from the client that OpenAI's own Codex CLI
// uses for `codex cloud` (github.com/openai/codex, codex-rs/backend-client and
// codex-rs/cloud-tasks-client, read 2026-11-18). That client calls the same chatgpt.com
// addresses with the same login key as the website:
//   GET chatgpt.com/backend-api/wham/tasks/list?limit=…&task_filter=current&cursor=…
//     -> { items: [task], cursor? }  task: { id, title, has_generated_title, created_at, updated_at
//        (seconds since 1970, with fractions), archived, has_unread_turn, pull_requests?,
//        task_status_display: { environment_label?, latest_turn_status_display: { turn_status,
//        diff_stats: { files_modified, lines_added, lines_removed }, sibling_turn_ids } } }
//   GET chatgpt.com/backend-api/wham/tasks/<id>
//     -> { task: { id, title, created_at, current_turn_id, archived, external_pull_requests: [
//          { pull_request: { number, url, state, merged, title, base, head } }] },
//          current_user_turn, current_assistant_turn, current_diff_task_turn }
//     turn: { id, created_at?, turn_status, input_items: [item], output_items: [item],
//             worklog: { messages: [{ author: { role }, content: { parts: [text | { content_type, text }] } }] },
//             error?: { code, message } }
//     item: { type: "message", role, content: [text | { content_type: "text", text }] }
//         | { type: "output_diff", diff } | { type: "pr", output_diff: { diff } }
// Only the task's current turns are sent. When a task goes on (a follow-up), its note is
// rewritten and the version before stays as raw .json (see versions.ts), so nothing is lost.

import { obj, str, TurnBuilder } from '../desktop/turns';
import type { DesktopSession } from '../desktop/types';
import { safeTitle } from '../naming';

export class CodexCloudShapeError extends Error {}

/** Task IDs as the Codex CLI shows them ("task_e_…"). Anything else is refused before a request. */
export const isTaskId = (id: string): boolean => /^task_[A-Za-z0-9_-]{4,120}$/.test(id);

export interface CodexTask {
	id: string;
	title?: string;
	/** ISO times. */
	created_at?: string;
	updated_at?: string;
	/** "completed", "failed", "cancelled", "pending", "in_progress" (latest turn). */
	status?: string;
	/** The environment the task ran in, usually named after its repository ("me/notes-app"). */
	environment?: string;
	archived: boolean;
	/** The list entry exactly as chatgpt.com sent it, saved in the raw file. */
	raw: Record<string, unknown>;
}

export interface CodexTaskDetails {
	/** The answer exactly as chatgpt.com sent it, saved in the raw file. */
	raw: Record<string, unknown>;
}

/** Seconds since 1970 (as the task list sends them) or an ISO string -> ISO string. */
function isoOf(v: unknown): string | undefined {
	if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
	if (typeof v === 'string' && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
	return undefined;
}

function latestTurn(display: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return obj(display?.latest_turn_status_display);
}

/** One page of the task list. Throws CodexCloudShapeError if it does not look as expected. */
export function checkCodexList(json: unknown): { tasks: CodexTask[]; cursor?: string } {
	const o = obj(json);
	if (!o || !Array.isArray(o.items)) throw new CodexCloudShapeError('Codex task list: no "items" list');
	const tasks = o.items.map((x, i) => {
		const r = obj(x);
		const id = str(r?.id);
		if (!r || !id) throw new CodexCloudShapeError(`Codex task list: entry ${i} has no id`);
		if (!isTaskId(id)) throw new CodexCloudShapeError(`Codex task list: entry ${i} has an odd id`);
		const display = obj(r.task_status_display);
		return {
			id,
			title: str(r.title),
			created_at: isoOf(r.created_at),
			updated_at: isoOf(r.updated_at),
			status: str(latestTurn(display)?.turn_status) ?? str(display?.state),
			environment: str(display?.environment_label),
			archived: r.archived === true,
			raw: r,
		};
	});
	return { tasks, cursor: str(o.cursor) || undefined };
}

/** A task's details. Throws CodexCloudShapeError if it does not look as expected. */
export function checkCodexTask(json: unknown, id: string): CodexTaskDetails {
	const o = obj(json);
	const task = obj(o?.task);
	if (!o || !task) throw new CodexCloudShapeError('Codex task: no "task"');
	if (str(task.id) !== id) throw new CodexCloudShapeError('Codex task: answer is for another task');
	for (const k of ['current_user_turn', 'current_assistant_turn', 'current_diff_task_turn']) {
		if (o[k] !== undefined && o[k] !== null && !obj(o[k])) throw new CodexCloudShapeError(`Codex task: "${k}" is not an object`);
	}
	return { raw: o };
}

/** Still working: wait, like Code Local waits for a quiet session. */
export const isRunning = (t: CodexTask): boolean => t.status === 'pending' || t.status === 'in_progress';

/** The version of a task: changes when it goes on. */
export const versionOf = (t: CodexTask): string => t.updated_at ?? t.created_at ?? '';

/** Text of one content fragment: a plain string or { content_type: "text", text }. */
function fragmentText(f: unknown): string | undefined {
	if (typeof f === 'string') return f.trim() ? f : undefined;
	const o = obj(f);
	if (!o) return undefined;
	const type = str(o.content_type);
	if (type && type.toLowerCase() !== 'text') return undefined;
	const t = str(o.text);
	return t?.trim() ? t : undefined;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texts = (content: unknown): string[] => list(content).flatMap((f) => fragmentText(f) ?? []);

/** The unified diff of a turn, if it made changes. */
function turnDiff(turn: Record<string, unknown> | undefined): string | undefined {
	for (const x of list(turn?.output_items)) {
		const item = obj(x);
		if (!item) continue;
		if (item.type === 'output_diff' && str(item.diff)) return str(item.diff);
		if (item.type === 'pr' && str(obj(item.output_diff)?.diff)) return str(obj(item.output_diff)?.diff);
	}
	return undefined;
}

export interface CodexPullRequest {
	number?: number;
	url: string;
	title?: string;
	state?: string;
	merged?: boolean;
}

function pullRequests(details: CodexTaskDetails): CodexPullRequest[] {
	const out: CodexPullRequest[] = [];
	for (const x of list(obj(details.raw.task)?.external_pull_requests)) {
		const pr = obj(obj(x)?.pull_request);
		const url = str(pr?.url);
		if (!pr || !url || !/^https:\/\//.test(url)) continue;
		out.push({ number: typeof pr.number === 'number' ? pr.number : undefined, url, title: str(pr.title), state: str(pr.state), merged: pr.merged === true });
	}
	return out;
}

export interface CodexCloudTranscript {
	session: DesktopSession;
	diff?: string;
	pullRequests: CodexPullRequest[];
	error?: string;
}

/**
 * The task as a session (like a local Codex thread), or null if it has no message from you.
 * Assistant messages and the steps in its work log come in the order the turn lists them;
 * work-log entries that are not the assistant's own words (commands, tool output) are counted
 * as tool steps, like the local sessions.
 */
export function parseCodexTask(task: CodexTask, details: CodexTaskDetails): CodexCloudTranscript | null {
	const d = details.raw;
	const user = obj(d.current_user_turn);
	const assistant = obj(d.current_assistant_turn);
	const diffTurn = obj(d.current_diff_task_turn);
	const t = new TurnBuilder();

	const prompt = list(user?.input_items)
		.map(obj)
		.filter((i) => i?.type === 'message' && (str(i.role) ?? 'user').toLowerCase() === 'user')
		.flatMap((i) => texts(i?.content))
		.join('\n\n');
	if (!prompt.trim()) return null;
	const created = isoOf(user?.created_at) ?? task.created_at ?? versionOf(task);
	t.user(prompt, created);

	const answerTime = isoOf(assistant?.created_at) ?? isoOf(diffTurn?.created_at);
	for (const turn of [diffTurn, assistant]) {
		if (!turn) continue;
		for (const x of list(obj(turn.worklog)?.messages)) {
			const m = obj(x);
			const role = str(obj(m?.author)?.role)?.toLowerCase();
			const words = list(obj(m?.content)?.parts).flatMap((f) => fragmentText(f) ?? []);
			if (role === 'assistant' && words.length) t.assistant(words.join('\n\n'), answerTime);
			else if (role && role !== 'user' && role !== 'system') t.tool(answerTime);
		}
		for (const x of list(turn.output_items)) {
			const item = obj(x);
			if (item?.type === 'message') {
				const words = texts(item.content);
				if (words.length) t.assistant(words.join('\n\n'), answerTime);
			}
		}
	}

	const err = obj(assistant?.error);
	const error = [str(err?.code), str(err?.message)].filter(Boolean).join(': ') || undefined;
	const session: DesktopSession = {
		app: 'codex',
		id: task.id,
		title: task.title?.trim() || str(obj(d.task)?.title)?.trim() || prompt.split('\n')[0]!.slice(0, 80),
		created,
		updated: versionOf(task) || created,
		isSubagent: false,
		turns: t.turns,
	};
	return { session, diff: turnDiff(diffTurn) ?? turnDiff(assistant), pullRequests: pullRequests(details), error };
}

/** Subfolder for a task: its environment's repository name. */
export function codexFolderName(task: CodexTask, fallback: string): string {
	const name = task.environment?.trim().split('/').pop();
	return name ? safeTitle(name) : fallback;
}

/** Where the task can be opened on chatgpt.com. */
export const codexTaskUrl = (id: string): string => `https://chatgpt.com/codex/tasks/${id}`;

/** Diffs above this are left in the raw file only, so a note stays readable. */
export const MAX_NOTE_DIFF = 200_000;

/** The "Changes" part of the note: pull requests, error and the diff in a folded callout. */
export function codexChangesSection(t: CodexCloudTranscript): string {
	const out: string[] = [];
	if (t.error) out.push('## Error', '', t.error, '');
	if (t.pullRequests.length) {
		out.push('## Pull requests', '');
		for (const pr of t.pullRequests) {
			const state = pr.merged ? 'merged' : pr.state;
			out.push(`- [${pr.number ? `#${pr.number} ` : ''}${(pr.title ?? pr.url).replace(/[[\]]/g, '')}](${pr.url})${state ? ` (${state})` : ''}`);
		}
		out.push('');
	}
	if (t.diff) {
		const files = new Set([...t.diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]));
		const added = (t.diff.match(/^\+(?!\+\+)/gm) ?? []).length;
		const removed = (t.diff.match(/^-(?!--)/gm) ?? []).length;
		out.push('## Changes', '', `${files.size} file${files.size === 1 ? '' : 's'}, +${added} −${removed}`, '');
		if (t.diff.length > MAX_NOTE_DIFF) out.push('*The diff is too long for the note; it is in the raw file.*', '');
		else {
			const longest = Math.max(2, ...[...t.diff.matchAll(/`+/g)].map((m) => m[0].length));
			const fence = '`'.repeat(longest + 1);
			out.push('> [!diff]- Diff', ...`${fence}diff\n${t.diff.replace(/\n$/, '')}\n${fence}`.split('\n').map((l) => `> ${l}`), '');
		}
	}
	return out.join('\n');
}

/** What is saved as the raw file: the list entry and the task's details. */
export function codexRaw(task: CodexTask, details: CodexTaskDetails): string {
	return JSON.stringify({ task: task.raw, details: details.raw }, null, 1);
}

/** Reads a raw file written by codexRaw back. */
export function parseCodexRaw(text: string): { task: CodexTask; details: CodexTaskDetails } {
	const o = obj(JSON.parse(text) as unknown);
	if (!o) throw new CodexCloudShapeError('saved Codex task: not an object');
	const { tasks } = checkCodexList({ items: [o.task] });
	return { task: tasks[0]!, details: checkCodexTask(o.details, tasks[0]!.id) };
}
