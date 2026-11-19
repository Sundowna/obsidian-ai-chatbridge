// Codex cloud tasks (chatgpt.com/codex). Pure code, no Obsidian.
//
// Shapes seen in DevTools on 2026-11-18, over the Codex app-server connection (codex-app-server.ts):
//   thread/list { limit, cursor? }
//     -> { data: [thread], nextCursor }   newest first
//     thread: { id (UUID), name (the first prompt, cut, or null), createdAt, updatedAt (seconds since
//               1970), status: { type: "idle" | "active" … }, originator ("codex_cloud" = started on
//               chatgpt.com/codex, "codex_work_web" / "codex_work_mobile" = started from ChatGPT),
//               model, reasoningEffort, environments: [{ environmentId, cwd }], turns: [] }
//   thread/turns/list { threadId, limit, cursor? }
//     -> { data: [turn], nextCursor }      newest first; nextCursor goes back in time
//     turn: { id, status ("completed", "interrupted", "failed", "inProgress"), error, startedAt,
//             completedAt, items: [], itemsView: "notLoaded" }
//     (itemsView "full" would bring the items too, but hangs on long tasks – seen with 10 MB.)
//   thread/items/list { threadId, cursor, limit, sortDirection: "asc" }
//     -> { data: [{ turnId, item, startedAtMs, completedAtMs }], nextCursor, backwardsCursor }
//     This is how the Codex page itself reads a task's steps.
//     item: { type: "userMessage", content: [{ type: "text", text }] }
//         | { type: "agentMessage", text, phase: "commentary" | "final_answer" }
//         | { type: "commandExecution", command, exitCode, aggregatedOutput }
//         | { type: "mcpToolCall", server, tool, arguments, result }
//         | { type: "reasoning" } (empty) | { type: "fileChange", changes: [{ path, kind, diff }] }
//     every item has startedAtMs / completedAtMs.
// thread/read does not take includeTurns.
// When a task goes on (a follow-up turn), its note is rewritten and the version before stays as
// raw .json (see versions.ts), so nothing is lost.

import { obj, str, TurnBuilder } from '../desktop/turns';
import type { DesktopSession } from '../desktop/types';

export class CodexCloudShapeError extends Error {}

/** Thread IDs are UUIDs ("6afdb9e6-40c4-8191-a1c1-04b03bf000fe"). Anything else is refused. */
export const isThreadId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export interface CodexTask {
	id: string;
	/** Codex's name for it: usually the first prompt, cut off. */
	title?: string;
	/** ISO times. */
	created_at?: string;
	updated_at?: string;
	/** status.type: "idle" when nothing runs, "active" while Codex works. */
	status?: string;
	/** Where it was started: codex_cloud, codex_work_web, codex_work_mobile … */
	originator?: string;
	model?: string;
	/** The list entry exactly as chatgpt.com sent it, saved in the raw file. */
	raw: Record<string, unknown>;
}

export interface CodexTaskDetails {
	/** All turns, oldest first, exactly as chatgpt.com sent them. */
	turns: Record<string, unknown>[];
}

/** Seconds since 1970 or milliseconds or an ISO string -> ISO string. */
function isoOf(v: unknown): string | undefined {
	if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v > 1e12 ? v : v * 1000).toISOString();
	if (typeof v === 'string' && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
	return undefined;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const page = (json: unknown, what: string): { data: unknown[]; cursor?: string } => {
	const o = obj(json);
	if (!o || !Array.isArray(o.data)) throw new CodexCloudShapeError(`${what}: no "data" list`);
	return { data: o.data, cursor: str(o.nextCursor) || undefined };
};

/** One page of thread/list. Throws CodexCloudShapeError if it does not look as expected. */
export function checkCodexList(json: unknown): { tasks: CodexTask[]; cursor?: string } {
	const p = page(json, 'Codex task list');
	const tasks = p.data.map((x, i) => {
		const r = obj(x);
		const id = str(r?.id);
		if (!r || !id) throw new CodexCloudShapeError(`Codex task list: entry ${i} has no id`);
		if (!isThreadId(id)) throw new CodexCloudShapeError(`Codex task list: entry ${i} has an odd id`);
		return {
			id,
			title: str(r.name)?.trim() || undefined,
			created_at: isoOf(r.createdAt),
			updated_at: isoOf(r.updatedAt),
			status: str(obj(r.status)?.type),
			originator: str(r.originator),
			model: str(r.model),
			raw: r,
		};
	});
	return { tasks, cursor: p.cursor };
}

/** One page of thread/turns/list: the turns' status and times (their items may be left out). */
export function checkCodexTurns(json: unknown): { turns: Record<string, unknown>[]; cursor?: string } {
	const p = page(json, 'Codex task turns');
	const turns = p.data.map((x, i) => {
		const t = obj(x);
		if (!t || !str(t.id)) throw new CodexCloudShapeError(`Codex task turns: turn ${i} has no id`);
		if (t.items !== undefined && !Array.isArray(t.items)) throw new CodexCloudShapeError(`Codex task turns: turn ${i} has odd items`);
		return t;
	});
	return { turns, cursor: p.cursor };
}

/** Longest text kept per field of a step (command output, tool results). Words are never cut. */
export const MAX_STEP_TEXT = 50_000;

/**
 * A step with its long texts cut to `max` characters, marked "…[cut N characters]".
 * Long scheduled runs carry megabytes of command output per step – whole, the raw file of one
 * task outgrew what JavaScript can hold as one text (seen 2026-11-18). Your messages and
 * Codex's answers are kept whole.
 */
export function trimStep(item: Record<string, unknown>, max = MAX_STEP_TEXT): Record<string, unknown> {
	if (item.type === 'userMessage' || item.type === 'agentMessage') return item;
	const cut = (v: unknown): unknown => {
		if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…[cut ${v.length - max} characters]` : v;
		if (Array.isArray(v)) return v.map(cut);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
		return v;
	};
	return cut(item) as Record<string, unknown>;
}

/**
 * Only the conversation: your messages and Codex's answers. Each run of other steps between them
 * becomes one placeholder { type: "stepsSkipped", count, kinds: { commandExecution: 7, … } }, so the note still counts them
 * where they happened. Reasoning (empty anyway) is dropped. A long scheduled run shrinks from
 * tens of MB to a few KB this way.
 */
export function interactionsOnly(turns: Record<string, unknown>[]): Record<string, unknown>[] {
	return turns.map((turn) => {
		const out: Record<string, unknown>[] = [];
		let run: { type: 'stepsSkipped'; count: number; kinds: Record<string, number>; startedAtMs?: unknown } | null = null;
		for (const x of list(turn.items)) {
			const item = obj(x);
			const type = str(item?.type);
			if (!item || !type || type === 'reasoning') continue;
			if (type === 'userMessage' || type === 'agentMessage') {
				run = null;
				out.push(item);
			} else if (type === 'stepsSkipped') {
				run = null;
				out.push(item); // already filtered before
			} else {
				if (!run) {
					run = { type: 'stepsSkipped', count: 0, kinds: {}, startedAtMs: item.startedAtMs };
					out.push(run);
				}
				run.count++;
				run.kinds[type] = (run.kinds[type] ?? 0) + 1;
			}
		}
		return { ...turn, items: out };
	});
}

/** One page of thread/items/list: { turnId, item } entries, oldest first. */
export function checkCodexItems(json: unknown): { items: { turnId: string; item: Record<string, unknown> }[]; cursor?: string } {
	const p = page(json, 'Codex task steps');
	const items = p.data.map((x, i) => {
		const e = obj(x);
		const turnId = str(e?.turnId);
		const item = obj(e?.item);
		if (!turnId || !item || !str(item.type)) throw new CodexCloudShapeError(`Codex task steps: entry ${i} has no turn or no item`);
		return { turnId, item: trimStep(item) };
	});
	return { items, cursor: p.cursor };
}

/**
 * The turns (oldest first) with their items filled in from thread/items/list, as one list.
 * Items of a turn the turn list did not name get a turn of their own, so nothing is dropped.
 */
export function joinTurns(turns: Record<string, unknown>[], items: { turnId: string; item: Record<string, unknown> }[]): Record<string, unknown>[] {
	const byTurn = new Map<string, Record<string, unknown>[]>();
	for (const { turnId, item } of items) {
		const seen = byTurn.get(turnId);
		if (seen) {
			if (!seen.some((x) => x.id !== undefined && x.id === item.id)) seen.push(item);
		} else byTurn.set(turnId, [item]);
	}
	const out: Record<string, unknown>[] = orderTurns(turns).map((t) => ({ ...t, items: byTurn.get(str(t.id)!) ?? [], itemsView: 'full' }));
	for (const [turnId, its] of byTurn) {
		if (!out.some((t) => t.id === turnId)) out.push({ id: turnId, items: its, itemsView: 'full' });
	}
	return out;
}

/** Turns gathered from all pages, oldest first, each once. */
export function orderTurns(turns: Record<string, unknown>[]): Record<string, unknown>[] {
	const seen = new Set<string>();
	const once = turns.filter((t) => {
		const id = str(t.id)!;
		return !seen.has(id) && seen.add(id);
	});
	const at = (t: Record<string, unknown>) => (typeof t.startedAt === 'number' ? t.startedAt : 0);
	return once.sort((a, b) => at(a) - at(b));
}

/** Codex is still working on it: wait, like Code Local waits for a quiet session. */
export const isRunning = (t: CodexTask): boolean => t.status === 'active';

/** The last turn is still running (seen after fetching, when the list said idle). */
export const turnsRunning = (d: CodexTaskDetails): boolean => {
	const last = d.turns[d.turns.length - 1];
	return !!last && /^(inProgress|in_progress|running|pending)$/.test(str(last.status) ?? '');
};

/** The version of a task: changes when it goes on. */
export const versionOf = (t: CodexTask): string => t.updated_at ?? t.created_at ?? '';

function userText(item: Record<string, unknown>): string {
	return list(item.content)
		.map(obj)
		.filter((c) => c && (c.type === undefined || c.type === 'text'))
		.map((c) => str(c!.text) ?? '')
		.filter((t) => t.trim())
		.join('\n\n');
}

export interface CodexFileChange {
	path: string;
	kind?: string;
	diff?: string;
}

export interface CodexCloudTranscript {
	session: DesktopSession;
	/** Files changed in fileChange steps, with their diffs. */
	changes: CodexFileChange[];
	error?: string;
}

/** Steps that are not words: commands, tool calls, file edits, searches … */
const TOOL_ITEMS = /^(commandExecution|mcpToolCall|fileChange|webSearch|imageView|dynamicToolCall|collabAgentToolCall|toolCall|functionCall)$/;

/**
 * The task as a session (like a local Codex thread), or null if it has no message from you.
 * Messages come in the order the turns list them; steps that are not words are counted as
 * tool steps, like the local sessions. Reasoning is left out (it is empty anyway).
 */
export function parseCodexTask(task: CodexTask, details: CodexTaskDetails): CodexCloudTranscript | null {
	const t = new TurnBuilder();
	const changes: CodexFileChange[] = [];
	let first: string | undefined;
	let created: string | undefined;
	for (const turn of details.turns) {
		for (const x of list(turn.items)) {
			const item = obj(x);
			const type = str(item?.type);
			if (!item || !type) continue;
			const time = isoOf(item.startedAtMs) ?? isoOf(turn.startedAt);
			if (type === 'userMessage') {
				const text = userText(item);
				if (!text.trim()) continue;
				first ??= text;
				created ??= time;
				t.user(text, time);
			} else if (type === 'agentMessage') {
				t.assistant(str(item.text) ?? '', time);
			} else if (type === 'stepsSkipped') {
				const n = typeof item.count === 'number' && item.count > 0 ? item.count : 0;
				if (n) t.tool(time, n);
			} else if (TOOL_ITEMS.test(type)) {
				t.tool(time);
				if (type === 'fileChange') {
					for (const c of list(item.changes)) {
						const ch = obj(c);
						const path = str(ch?.path);
						if (path) changes.push({ path, kind: str(obj(ch!.kind)?.type) ?? str(ch!.kind), diff: str(ch!.diff) });
					}
				}
			}
		}
	}
	if (!first) return null;

	const last = details.turns[details.turns.length - 1];
	const err = obj(last?.error);
	const lastStatus = str(last?.status);
	const error = str(err?.message) ?? (lastStatus === 'failed' ? 'The last turn failed.' : undefined);
	const created0 = created ?? task.created_at ?? versionOf(task);
	const session: DesktopSession = {
		app: 'codex',
		id: task.id,
		title: titleOf(task, first),
		created: created0,
		updated: versionOf(task) || created0,
		model: task.model,
		isSubagent: false,
		turns: t.result(),
	};
	return { session, changes, error };
}

/** Codex's name, unless it is just the prompt cut off: then the prompt's first line. */
function titleOf(task: CodexTask, prompt: string): string {
	// A scheduled run from ChatGPT starts with its instructions; they name the schedule.
	if (/^System instruction \(automation runtime/.test(prompt.trim())) {
		const scheduled = /^- Title: (.+)$/m.exec(prompt)?.[1]?.trim();
		if (scheduled) return scheduled;
	}
	const line = prompt.trim().split('\n')[0]!.trim();
	const name = task.title?.replace(/…$/, '').trim();
	if (name && !line.startsWith(name)) return name;
	return line.length > 80 ? `${line.slice(0, 80).trim()}…` : line;
}

/** Subfolder for a task: where it was started. */
export function codexFolderName(task: CodexTask, fallback: string): string {
	const o = task.originator ?? '';
	if (o === 'codex_cloud') return 'Tasks';
	if (o.startsWith('codex_work')) return 'Work';
	return fallback;
}

/** Where the task can be opened on chatgpt.com. */
export const codexTaskUrl = (id: string): string => `https://chatgpt.com/local/${id}`;

/** Diffs above this are left in the raw file only, so a note stays readable. */
export const MAX_NOTE_DIFF = 200_000;

/** The end of the note: the error of the last turn and the files changed, diff folded. */
export function codexChangesSection(t: CodexCloudTranscript): string {
	const out: string[] = [];
	if (t.error) out.push('## Error', '', t.error, '');
	if (t.changes.length) {
		const diff = t.changes.map((c) => c.diff ?? '').filter(Boolean).join('\n');
		const files = new Set(t.changes.map((c) => c.path));
		const added = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
		const removed = (diff.match(/^-(?!--)/gm) ?? []).length;
		out.push('## Changes', '', `${files.size} file${files.size === 1 ? '' : 's'}, +${added} −${removed}`, '');
		for (const f of files) out.push(`- \`${f.replace(/`/g, '')}\``);
		out.push('');
		if (diff.length > MAX_NOTE_DIFF) out.push('*The diff is too long for the note; it is in the raw file.*', '');
		else if (diff) {
			const longest = Math.max(2, ...[...diff.matchAll(/`+/g)].map((m) => m[0].length));
			const fence = '`'.repeat(longest + 1);
			out.push('> [!diff]- Diff', ...`${fence}diff\n${diff.replace(/\n$/, '')}\n${fence}`.split('\n').map((l) => `> ${l}`), '');
		}
	}
	return out.join('\n');
}

/** What is saved as the raw file: the list entry and all turns. */
export function codexRaw(task: CodexTask, details: CodexTaskDetails): string {
	// No indentation: long tasks are big enough as it is.
	return JSON.stringify({ thread: task.raw, turns: details.turns });
}

/** Reads a raw file written by codexRaw back. */
export function parseCodexRaw(text: string): { task: CodexTask; details: CodexTaskDetails } {
	const o = obj(JSON.parse(text) as unknown);
	if (!o) throw new CodexCloudShapeError('saved Codex task: not an object');
	const { tasks } = checkCodexList({ data: [o.thread] });
	const { turns } = checkCodexTurns({ data: o.turns });
	return { task: tasks[0]!, details: { turns: orderTurns(turns) } };
}
