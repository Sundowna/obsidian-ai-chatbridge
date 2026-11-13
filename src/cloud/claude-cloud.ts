// Claude Code sessions run in Anthropic's cloud (claude.ai/code). Pure code, no Obsidian.
//
// Shapes seen 2026-11-13:
//   GET claude.ai/v1/code/sessions?statuses=…&limit=…&cursor=…
//     -> { data: [session], next_cursor }  session: { id: "cse_…", title, created_at, updated_at,
//        last_event_at, status, status_bucket, worker_status ("running" | "idle"),
//        environment_kind ("anthropic_cloud" | "bridge"), config: { model, sources: [{ type, url }] }, tags }
//     "bridge" sessions are local Claude Code sessions steered from claude.ai (Remote Control):
//     their file is on the computer and the Code Local sync saves them, so they are skipped here.
//   GET claude.ai/v1/code/sessions/<id>/events?limit=…&cursor=…
//     -> { data: [event], next_cursor?, resume_cursor }, newest first.
//     event: { event_id, event_type, sequence_num ("55"), created_at, payload }
//     payload of "user" / "assistant" events: the same record as a line of a local session file
//     ({ type, message: { role, content }, uuid, timestamp? }); "system"/"init" holds cwd and model.
//     Other event types (env_manager_log, control_request, rate_limit_event …) are bookkeeping.

import { parseClaudeSession } from '../desktop/claude-code';
import { obj, str } from '../desktop/turns';
import type { DesktopSession } from '../desktop/types';
import { safeTitle } from '../naming';

export class CloudShapeError extends Error {}

export interface CloudSession {
	id: string;
	title?: string;
	created_at: string;
	/** Last message or tool step: what decides "changed". */
	last_event_at?: string;
	updated_at?: string;
	status?: string;
	worker_status?: string;
	environment_kind?: string;
	model?: string;
	/** GitHub repository the session worked on (first git source), if any. */
	repo?: string;
	/** The list entry exactly as claude.ai sent it, saved in the raw file. */
	raw: Record<string, unknown>;
}

export interface CloudEvent {
	sequence: number;
	created_at?: string;
	type?: string;
	payload: Record<string, unknown>;
	raw: Record<string, unknown>;
}

/** Repository name from a source URL: "https://github.com/me/jhu(.git)" -> "me/jhu". */
function repoOf(config: Record<string, unknown> | undefined): string | undefined {
	const sources = Array.isArray(config?.sources) ? config.sources : [];
	for (const s of sources) {
		const url = str(obj(s)?.url);
		const m = url ? /github\.com\/([^/]+\/[^/?#]+?)(?:\.git)?\/?$/i.exec(url) : null;
		if (m) return m[1];
	}
	return undefined;
}

/** One page of the session list. Throws CloudShapeError if it does not look as expected. */
export function checkCloudList(json: unknown): { sessions: CloudSession[]; cursor?: string } {
	const o = obj(json);
	if (!o || !Array.isArray(o.data)) throw new CloudShapeError('Claude Code session list: no "data" list');
	const sessions = o.data.map((x, i) => {
		const r = obj(x);
		const id = str(r?.id);
		const created = str(r?.created_at);
		if (!r || !id || !created) throw new CloudShapeError(`Claude Code session list: entry ${i} has no id or created_at`);
		const config = obj(r.config);
		return {
			id,
			title: str(r.title),
			created_at: created,
			last_event_at: str(r.last_event_at),
			updated_at: str(r.updated_at),
			status: str(r.status),
			worker_status: str(r.worker_status),
			environment_kind: str(r.environment_kind),
			model: str(config?.model),
			repo: repoOf(config),
			raw: r,
		};
	});
	return { sessions, cursor: str(o.next_cursor) || undefined };
}

/** One page of a session's events. */
export function checkCloudEvents(json: unknown): { events: CloudEvent[]; cursor?: string } {
	const o = obj(json);
	if (!o || !Array.isArray(o.data)) throw new CloudShapeError('Claude Code session events: no "data" list');
	const events = o.data.map((x, i) => {
		const r = obj(x);
		const seq = Number(r?.sequence_num);
		if (!r || !Number.isFinite(seq)) throw new CloudShapeError(`Claude Code session events: event ${i} has no sequence_num`);
		return { sequence: seq, created_at: str(r.created_at), type: str(r.event_type), payload: obj(r.payload) ?? {}, raw: r };
	});
	return { events, cursor: str(o.next_cursor) || undefined };
}

/** Synced here: sessions that ran in the cloud. Remote Control ("bridge") sessions are saved by Code Local. */
export const isCloudSession = (s: CloudSession): boolean => s.environment_kind !== 'bridge';

/** Still working: wait, like Code Local waits for a quiet session. */
export const isRunning = (s: CloudSession): boolean => s.worker_status === 'running';

/** The version of a session: changes with every new message or tool step. */
export const versionOf = (s: CloudSession): string => s.last_event_at ?? s.updated_at ?? s.created_at;

/** Events in the order they happened, each once. */
export function inOrder(events: CloudEvent[]): CloudEvent[] {
	const seen = new Map<number, CloudEvent>();
	for (const e of events) seen.set(e.sequence, e);
	return [...seen.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The session as a Claude Code session (like a local one), or null if it has no message from you.
 * Files keep only what the session itself holds (pasted images, files Claude wrote in full):
 * their paths are inside the cloud machine, not on this computer.
 */
export function parseCloudSession(session: CloudSession, events: CloudEvent[]): DesktopSession | null {
	const ordered = inOrder(events);
	const init = ordered.find((e) => e.payload.type === 'system' && e.payload.subtype === 'init')?.payload;
	const cwd = str(init?.cwd);
	const lines = ordered
		.filter((e) => e.payload.type === 'user' || e.payload.type === 'assistant')
		.map((e) => JSON.stringify({ ...e.payload, sessionId: session.id, cwd, timestamp: str(e.payload.timestamp) ?? e.created_at }));
	const titles = new Map<string, string>();
	if (session.title?.trim()) titles.set(session.id, session.title.trim());
	const parsed = parseClaudeSession(lines.join('\n'), session.id, titles);
	if (!parsed) return null;
	return {
		...parsed,
		model: parsed.model ?? str(init?.model) ?? session.model,
		files: parsed.files?.map((f) => ({ ...f, source: undefined })).filter((f) => f.base64 !== undefined || f.text !== undefined),
	};
}

/** Subfolder for a session: its repository's name, else the folder it ran in. */
export function cloudFolderName(session: CloudSession, cwd: string | undefined, fallback: string): string {
	const repo = session.repo?.split('/').pop();
	if (repo) return safeTitle(repo);
	const name = cwd?.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
	return name ? safeTitle(name) : fallback;
}

/** Where the session can be opened on claude.ai. */
export const cloudUrl = (id: string): string => `https://claude.ai/code/${id}`;

/** What is saved as the raw file: the list entry and every event, in order. */
export function cloudRaw(session: CloudSession, events: CloudEvent[]): string {
	return JSON.stringify({ session: session.raw, events: inOrder(events).map((e) => e.raw) }, null, 1);
}

/** Reads a raw file written by cloudRaw back. */
export function parseCloudRaw(text: string): { session: CloudSession; events: CloudEvent[] } {
	const o = obj(JSON.parse(text) as unknown);
	if (!o) throw new CloudShapeError('saved Claude Code session: not an object');
	const { sessions } = checkCloudList({ data: [o.session] });
	const { events } = checkCloudEvents({ data: o.events });
	return { session: sessions[0]!, events };
}
