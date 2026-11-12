// SQL for a Hermes snapshot and turning its rows into a session. Pure code, no Obsidian.
// Hermes adds columns often (schema 31 in Nov 2026), so every optional column is checked first.

import type { Row, Snapshot } from './reader';
import type { HermesMessageRow, HermesSession, HermesSessionRow, HermesToolStep, HermesTurn } from './types';

/** Hermes stores list/dict content (multimodal parts) as this prefix plus JSON. */
const JSON_PREFIX = '\u0000json:';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined);

export async function columns(db: Snapshot, table: string): Promise<Set<string>> {
	const rows = await db.query(`PRAGMA table_info(${table})`);
	return new Set(rows.map((r) => String(r.name)));
}

export function sessionsSql(cols: Set<string>): string {
	const opt = (c: string, as = c) => (cols.has(c) ? `s.${c} AS ${as}` : `NULL AS ${as}`);
	return [
		'SELECT s.id AS id, s.source AS source, s.started_at AS started_at,',
		[opt('model'), opt('billing_provider', 'provider'), opt('title'), opt('ended_at'), opt('parent_session_id'), opt('cwd'), opt('model_config')].join(', ') + ',',
		'(SELECT MAX(m.id) FROM messages m WHERE m.session_id = s.id) AS last_id,',
		'(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n,',
		'(SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_ts',
		'FROM sessions s',
	].join(' ');
}

export function toSessionRow(r: Row): HermesSessionRow {
	const source = str(r.source) ?? 'unknown';
	const config = str(r.model_config) ?? '';
	return {
		id: String(r.id),
		source,
		model: str(r.model),
		provider: str(r.provider),
		title: str(r.title),
		startedAt: num(r.started_at) ?? 0,
		endedAt: num(r.ended_at),
		parentId: str(r.parent_session_id),
		cwd: str(r.cwd),
		lastMessageId: num(r.last_id) ?? 0,
		messageRows: num(r.n) ?? 0,
		lastMessageAt: num(r.last_ts),
		isSubagent: source === 'subagent' || config.includes('_delegate_from'),
	};
}

/** Changes whenever a message is added, removed or compacted. */
export const revisionOf = (s: HermesSessionRow): string => `${s.lastMessageId}:${s.messageRows}`;

/**
 * Messages the chat shows: live rows plus turns in-place compaction archived (never Undo/Rewind
 * rows), like Hermes' own display export. `ids` stays below SQLite's 999-variable limit.
 */
export function messagesSql(cols: Set<string>, count: number): string {
	const opt = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);
	const visible = cols.has('active') ? (cols.has('compacted') ? ' AND (active = 1 OR compacted = 1)' : ' AND active = 1') : '';
	return `SELECT id, session_id, role, content, ${opt('tool_calls')}, ${opt('tool_call_id')}, ${opt('tool_name')}, timestamp, ${opt('message_uid')}, ${opt('display_metadata')} FROM messages WHERE session_id IN (${Array(count).fill('?').join(',')})${visible} ORDER BY session_id, id`;
}

export function toMessageRow(r: Row): HermesMessageRow {
	let hidden = false;
	const meta = str(r.display_metadata);
	if (meta) {
		try {
			hidden = (JSON.parse(meta) as Record<string, unknown>)?.model_only === true;
		} catch {
			// not JSON: ignore
		}
	}
	return {
		id: num(r.id) ?? 0,
		sessionId: String(r.session_id),
		role: String(r.role),
		content: typeof r.content === 'string' ? r.content : null,
		toolCalls: str(r.tool_calls) ?? null,
		toolCallId: str(r.tool_call_id),
		toolName: str(r.tool_name),
		timestamp: num(r.timestamp) ?? 0,
		uid: str(r.message_uid),
		hidden,
	};
}

/** Message text: plain, or the text parts of multimodal content. */
export function messageText(content: string | null): string {
	if (!content) return '';
	if (!content.startsWith(JSON_PREFIX)) return content.trim();
	try {
		const parts = JSON.parse(content.slice(JSON_PREFIX.length)) as unknown;
		if (typeof parts === 'string') return parts.trim();
		const list = Array.isArray(parts) ? parts : [parts];
		return list
			.map((p) => {
				if (typeof p === 'string') return p;
				const o = p as { type?: string; text?: string };
				if (typeof o?.text === 'string') return o.text;
				if (o?.type && /image/.test(o.type)) return '*(image)*';
				if (o?.type && /audio/.test(o.type)) return '*(audio)*';
				if (o?.type && /file/.test(o.type)) return '*(file)*';
				return '';
			})
			.filter((t) => t.trim())
			.join('\n\n')
			.trim();
	} catch {
		return content.slice(JSON_PREFIX.length).trim();
	}
}

/** The calls in an assistant message's tool_calls JSON (OpenAI format: {id, function: {name, arguments}}). */
export function toolCalls(raw: string | null): { id?: string; step: HermesToolStep }[] {
	if (!raw) return [];
	let list: unknown;
	try {
		list = JSON.parse(raw);
	} catch {
		return [{ step: { name: 'tool', args: raw } }];
	}
	return (Array.isArray(list) ? list : [list]).map((c) => {
		const o = (c ?? {}) as { id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } };
		const name = str(o.function?.name) ?? str(o.name) ?? 'tool';
		const rawArgs = o.function?.arguments ?? o.arguments;
		const args = typeof rawArgs === 'string' ? rawArgs : rawArgs === undefined ? '' : JSON.stringify(rawArgs);
		return { id: str(o.id) ?? str(o.call_id), step: { name, args } };
	});
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * One session's transcript: your messages and Hermes' replies; tool calls and results become
 * "(n tool steps)". The same message can sit in two compaction generations (same message_uid):
 * it is shown once. Null when you wrote nothing (empty or helper-only sessions).
 */
export function buildSession(row: HermesSessionRow, messages: HermesMessageRow[], profile: string): HermesSession | null {
	const seen = new Set<string>();
	const turns: HermesTurn[] = [];
	let last: HermesTurn | undefined;
	/** Tool call ID -> its step, so a result row finds its call. */
	const pending = new Map<string, HermesToolStep>();
	let first: number | undefined;
	let latest: number | undefined;
	let fromYou = false;
	const push = (role: 'user' | 'assistant', ts: number): HermesTurn => {
		if (last && last.role === role) return last;
		last = { role, time: iso(ts), parts: [] };
		turns.push(last);
		return last;
	};
	const addSteps = (t: HermesTurn, steps: HermesToolStep[]) => {
		const end = t.parts[t.parts.length - 1];
		if (end && 'steps' in end) end.steps.push(...steps);
		else t.parts.push({ steps: [...steps] });
	};
	for (const m of messages) {
		if (m.hidden) continue;
		const key = m.uid ?? `${m.role}\u0001${m.timestamp}\u0001${m.content ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (m.role === 'system' || m.role === 'session_meta') continue;
		if (m.role === 'user') {
			const text = messageText(m.content);
			if (!text) continue;
			fromYou = true;
			push('user', m.timestamp).parts.push({ text });
		} else if (m.role === 'assistant') {
			const text = messageText(m.content);
			const calls = toolCalls(m.toolCalls);
			if (!text && !calls.length) continue;
			const t = push('assistant', m.timestamp);
			if (text) t.parts.push({ text });
			if (calls.length) {
				for (const c of calls) if (c.id) pending.set(c.id, c.step);
				addSteps(t, calls.map((c) => c.step));
			}
		} else if (m.role === 'tool') {
			// The result of a tool call: attach it to its call (or show it as a step of its own).
			const result = messageText(m.content);
			const step = m.toolCallId ? pending.get(m.toolCallId) : undefined;
			if (step) step.result = result;
			else if (last?.role === 'assistant') addSteps(last, [{ name: m.toolName ?? 'tool', args: '', result }]);
			continue;
		} else continue;
		first ??= m.timestamp;
		latest = m.timestamp;
	}
	if (!fromYou) return null;
	const created = iso(first ?? row.startedAt);
	return {
		id: row.id,
		profile,
		title: row.title ?? firstLine(turns) ?? 'Untitled',
		created,
		updated: iso(latest ?? row.lastMessageAt ?? row.startedAt),
		model: row.model,
		provider: row.provider,
		source: row.source,
		cwd: row.cwd,
		parentId: row.parentId,
		isSubagent: row.isSubagent,
		turns,
	};
}

function firstLine(turns: HermesTurn[]): string | undefined {
	const t = turns.find((x) => x.role === 'user');
	const p = t?.parts.find((x): x is { text: string } => 'text' in x);
	const line = p?.text.split('\n').find((l) => l.trim())?.trim();
	if (!line) return undefined;
	return Array.from(line).length > 60 ? `${Array.from(line).slice(0, 60).join('')}…` : line;
}
