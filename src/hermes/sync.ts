// One Hermes sync run: snapshot each enabled profile's state.db (read-only, see reader.ts) ->
// skip unchanged and still-active sessions -> write a transcript for each new or changed one -> log.
// Like every other provider, files are only ever CREATED: a changed session gets a new
// "(updated …)" transcript next to the old one; an unchanged one is never touched again.

import { TFile } from 'obsidian';
import type AIChatBridge from '../main';
import { appendLog } from '../log';
import { baseName, dailyNoteName, localStamp, safeTitle } from '../naming';
import type { ProgressFn } from '../progress';
import { cleanFolder } from '../settings';
import { createNew, ensureFolder, freeStem } from '../vaultio';
import { buildSession, columns, messagesSql, revisionOf, sessionsSql, toMessageRow, toSessionRow } from './parse';
import { isPrivatePath, nodeRequire, pickBackend, type Snapshot, type SqliteBackend } from './reader';
import { renderHermesTranscript } from './render';
import type { HermesMessageRow, HermesProfile, HermesSession, HermesSessionRow } from './types';

export interface HermesSyncResult {
	listed: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	/** Sessions with a message in the last few minutes (still being written). */
	active: number;
	empty: number;
	written: string[];
	restored: string[];
	/** Which SQLite reader was used. */
	backend?: string;
	stopped?: string;
}

export const anyHermesEnabled = (plugin: AIChatBridge): boolean => plugin.settings.hermes.profiles.some((p) => p.enabled);

const CHUNK = 500;

async function loadMessages(db: Snapshot, cols: Set<string>, ids: string[]): Promise<Map<string, HermesMessageRow[]>> {
	const out = new Map<string, HermesMessageRow[]>(ids.map((id) => [id, []]));
	for (let i = 0; i < ids.length; i += CHUNK) {
		const part = ids.slice(i, i + CHUNK);
		for (const r of await db.query(messagesSql(cols, part.length), part)) {
			const m = toMessageRow(r);
			out.get(m.sessionId)?.push(m);
		}
	}
	return out;
}

interface Todo {
	row: HermesSessionRow;
	session: HermesSession;
	isUpdate: boolean;
	restoreTo?: string;
}

/**
 * @param only     sync just this profile (its Sync button)
 * @param backend  the SQLite reader; found automatically when left out (tests pass their own)
 */
export async function runHermesSync(
	plugin: AIChatBridge,
	progress: ProgressFn = () => undefined,
	only?: string,
	backend?: SqliteBackend | null,
	now = Date.now(),
): Promise<HermesSyncResult> {
	const app = plugin.app;
	const s = plugin.settings;
	const h = s.hermes;
	const result: HermesSyncResult = { listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, active: 0, empty: 0, written: [], restored: [] };
	const exists = (p: string | undefined): boolean => !!p && app.vault.getAbstractFileByPath(p) instanceof TFile;
	const quietMs = Math.max(0, s.desktop.quietMinutes) * 60_000;
	let budget = s.maxChatsPerRun > 0 ? s.maxChatsPerRun : Infinity;

	try {
		if (!nodeRequire()) throw new Error('Hermes chats can only be read on a computer.');
		const base = cleanFolder(h.folder);
		if (!base) throw new Error('The Hermes folder setting is empty or invalid.');
		const profiles = h.profiles.filter((p) => p.enabled && (!only || p.id === only));
		if (!profiles.length) return result;
		const reader = backend === undefined ? await pickBackend(h.pythonPath, profiles.map((p) => p.path)) : backend;
		if (!reader) throw new Error('No way to read SQLite here: Obsidian has no built-in SQLite and no working Python was found. Set one under Hermes → Advanced → Python.');
		result.backend = reader.name;

		for (const profile of profiles) {
			if (isPrivatePath(profile.path)) throw new Error(`Profile "${profile.label}" is inside a Private folder and is never read.`);
			progress(`Hermes ${profile.label}: reading sessions…`);
			const db = await reader.snapshot(`${profile.path}/state.db`);
			try {
				budget = await syncProfile(plugin, profile, db, `${base}/${safeTitle(profile.label)}`, result, progress, quietMs, now, budget, exists);
			} finally {
				await db.close();
			}
			await plugin.saveSettings();
		}
	} catch (e) {
		result.stopped = e instanceof Error ? e.message : String(e);
	}
	await writeLog(plugin, result);
	return result;
}

async function syncProfile(
	plugin: AIChatBridge,
	profile: HermesProfile,
	db: Snapshot,
	folder: string,
	result: HermesSyncResult,
	progress: ProgressFn,
	quietMs: number,
	now: number,
	budget: number,
	exists: (p: string | undefined) => boolean,
): Promise<number> {
	const app = plugin.app;
	const sessionCols = await columns(db, 'sessions');
	const messageCols = await columns(db, 'messages');
	if (!sessionCols.has('id') || !messageCols.has('session_id')) throw new Error(`${profile.label}: state.db has no Hermes sessions table.`);
	const rows = (await db.query(sessionsSql(sessionCols))).map(toSessionRow);
	result.listed += rows.length;
	const ignored = (profile.ignored ??= {});
	const includeSubagents = plugin.settings.desktop.includeSubagents;

	const candidates: { row: HermesSessionRow; isUpdate: boolean; restoreTo?: string }[] = [];
	for (const row of rows) {
		if (!row.messageRows) continue;
		if ((row.isSubagent && !includeSubagents) || (row.cwd && isPrivatePath(row.cwd))) continue;
		const rev = revisionOf(row);
		if (row.lastMessageAt && now - row.lastMessageAt * 1000 < quietMs) {
			result.active++;
			continue;
		}
		if (ignored[row.id] === rev) {
			result.empty++;
			continue;
		}
		const entry = profile.index[row.id];
		if (entry && entry.rev === rev) {
			if (exists(entry.md)) {
				result.unchanged++;
				continue;
			}
			// Transcript deleted from the vault: write it again under the same name, so links stay valid.
			candidates.push({ row, isUpdate: false, restoreTo: entry.md });
			continue;
		}
		candidates.push({ row, isUpdate: !!entry });
	}

	const messages = await loadMessages(db, messageCols, candidates.map((c) => c.row.id));
	const todo: Todo[] = [];
	for (const c of candidates) {
		const session = buildSession(c.row, messages.get(c.row.id) ?? [], profile.label);
		if (!session) {
			ignored[c.row.id] = revisionOf(c.row);
			result.empty++;
			continue;
		}
		delete ignored[c.row.id];
		todo.push({ ...c, session });
	}
	// Newest first, like the other syncs: a limited run saves what you worked on last.
	todo.sort((a, b) => b.session.updated.localeCompare(a.session.updated));
	const now_ = todo.slice(0, Math.max(0, budget));
	result.leftForLater += todo.length - now_.length;

	const dbPath = `${profile.path}/state.db`;
	for (const [i, { row, session, isUpdate, restoreTo }] of now_.entries()) {
		progress(`Hermes ${profile.label}: ${i + 1} of ${now_.length}: ${session.title}`, i, now_.length);
		const md = renderHermesTranscript(session, dbPath);
		if (restoreTo) {
			await ensureFolder(app, restoreTo.split('/').slice(0, -1).join('/'));
			await createNew(app, restoreTo, md);
			result.restored.push(restoreTo.split('/').pop()!.replace(/\.md$/, ''));
			continue;
		}
		await ensureFolder(app, folder);
		let stem = baseName(session.created, session.title);
		if (isUpdate) stem = `${stem} (updated ${localStamp(session.updated)})`;
		stem = freeStem(app, folder, stem, session.id);
		const path = `${folder}/${stem}.md`;
		await createNew(app, path, md);
		profile.index[row.id] = { rev: revisionOf(row), updated: session.updated, md: path, synced: new Date().toISOString() };
		await plugin.saveSettings();
		result.written.push(stem);
		if (isUpdate) result.changedCount++;
		else result.newCount++;
	}
	return budget - now_.length;
}

async function writeLog(plugin: AIChatBridge, r: HermesSyncResult): Promise<void> {
	if (!r.written.length && !r.restored.length && !r.stopped) return;
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`**Hermes:** ${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.active) parts.push(`${r.active} still active (next run)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – ${parts.join(', ')}`;
	if (r.written.length) {
		const shown = r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ');
		line += `: ${shown}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	}
	if (r.backend) line += ` (via ${r.backend})`;
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
