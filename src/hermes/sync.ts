// One Hermes sync run: snapshot each enabled profile's state.db (read-only, see reader.ts) ->
// skip unchanged and still-active sessions -> write a transcript for each new or changed one -> log.
// Like every other provider, a session has one note: when it goes on, the note is rewritten and
// the version before stays in the raw folder (see versions.ts). An unchanged one is never touched.

import { TFile } from 'obsidian';
import type AIChatBridge from '../main';
import { appendLog } from '../log';
import { baseName, dailyNoteName, safeTitle } from '../naming';
import type { ProgressFn } from '../progress';
import { cleanFolder } from '../settings';
import { createNew, ensureFolder, findFile, freeStem } from '../vaultio';
import { dirOf, masterRaw, mirrorRaw, rawLink } from '../raw-folders';
import { addVersion, editsLog, keepNoteAsVersion, keepVersion, noEdits, noteHash, recordEdit, withVersionInfo, writeNote, writeRaw, type EditedReport } from '../versions';
import { buildSession, columns, messagesSql, revisionOf, sessionsSql, toMessageRow, toSessionRow } from './parse';
import { profileGone } from './profiles';
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
	/** Profiles turned on whose state.db is gone: skipped, the others still sync. */
	missing: string[];
	/** Notes you had edited whose session went on. */
	edits: EditedReport;
	stopped?: string;
}

export const anyHermesEnabled = (plugin: AIChatBridge): boolean => plugin.settings.hermes.profiles.some((p) => p.enabled);

const CHUNK = 500;
const stemOf = (p: string): string => (p.split('/').pop() ?? '').replace(/\.md$/, '');

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
	const result: HermesSyncResult = { listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, active: 0, empty: 0, written: [], restored: [], missing: [], edits: noEdits() };
	const exists = (p: string | undefined): boolean => !!p && findFile(app, p) instanceof TFile;
	const quietMs = Math.max(0, s.desktop.quietMinutes) * 60_000;
	let budget = s.maxChatsPerRun > 0 ? s.maxChatsPerRun : Infinity;

	try {
		if (!nodeRequire()) throw new Error('Hermes chats can only be read on a computer.');
		const base = cleanFolder(h.folder);
		if (!base) throw new Error('The Hermes folder setting is empty or invalid.');
		// A profile whose state.db is gone (deleted, renamed, or a drive not plugged in) is skipped,
		// so one stale entry never stops the others. It stays in the list until you remove it.
		const wanted = h.profiles.filter((p) => p.enabled && (!only || p.id === only));
		// Private before missing: a Private profile is refused even when its folder is gone.
		const secret = wanted.find((p) => isPrivatePath(p.path));
		if (secret) throw new Error(`Profile "${secret.label}" is inside a Private folder and is never read.`);
		const profiles = wanted.filter((p) => !profileGone(p));
		result.missing = wanted.filter((p) => !profiles.includes(p)).map((p) => p.label);
		if (!profiles.length) return result;
		const reader = backend === undefined ? await pickBackend(h.pythonPath, profiles.map((p) => p.path)) : backend;
		if (!reader) throw new Error('No way to read SQLite here: Obsidian has no built-in SQLite and no working Python was found. Set one under Hermes → Advanced → Python.');
		result.backend = reader.name;

		for (const profile of profiles) {
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
		const before = isUpdate || restoreTo ? profile.index[row.id] : undefined;
		if (restoreTo && before) {
			const noteFolder = dirOf(restoreTo);
			const md = withVersionInfo(renderHermesTranscript(session, dbPath, before.json && exists(before.json) ? rawLink(noteFolder, before.json) : undefined), before.versions, noteFolder);
			await ensureFolder(app, noteFolder);
			await createNew(app, restoreTo, md);
			before.noteHash = noteHash(md);
			result.restored.push(stemOf(restoreTo));
			continue;
		}
		// A session that goes on keeps its one note, where it is now; only a new one is given a place.
		const noteFolder = before ? dirOf(before.md) : folder;
		const root = masterRaw(plugin.settings);
		const rawFolder = root !== undefined ? mirrorRaw(noteFolder, root) : noteFolder;
		await ensureFolder(app, noteFolder);
		const stem = before ? stemOf(before.md) : freeStem(app, folder, baseName(session.created, session.title), session.id, rawFolder);
		const path = before?.md ?? `${folder}/${stem}.md`;
		const jsonPath = before?.json ?? `${rawFolder}/${stem}.json`;
		// The raw file: the session's rows as state.db has them.
		const raw = JSON.stringify({ format: 'hermes-session', profile: profile.label, session: row, messages: messages.get(row.id) ?? [] }, null, '\t');
		// A session saved before it had a raw file: its old note text is the earlier version.
		const kept = !before ? null : before.json ? await keepVersion(app, [before.json], before.updated, raw) : await keepNoteAsVersion(app, before.md, jsonPath, before.updated);
		const versions = addVersion(before, kept);
		await writeRaw(app, jsonPath, raw);
		const note = await writeNote(app, path, withVersionInfo(renderHermesTranscript(session, dbPath, rawLink(noteFolder, jsonPath)), versions, noteFolder), { policy: plugin.settings.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced });
		recordEdit(result.edits, note, path);
		profile.index[row.id] = { rev: revisionOf(row), updated: session.updated, md: path, json: jsonPath, synced: new Date().toISOString(), versions, noteHash: note.hash };
		await plugin.saveSettings();
		result.written.push(stem);
		if (isUpdate) result.changedCount++;
		else result.newCount++;
	}
	return budget - now_.length;
}

async function writeLog(plugin: AIChatBridge, r: HermesSyncResult): Promise<void> {
	// A skipped profile alone is not worth a log line on every auto-sync; the Hermes tab lists it.
	if (!r.written.length && !r.restored.length && !r.stopped) return;
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`**Hermes:** ${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.active) parts.push(`${r.active} still active (next run)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	parts.push(...editsLog(r.edits));
	let line = `- [[${dailyNoteName(now)}]] ${time} – ${parts.join(', ')}`;
	if (r.written.length) {
		const shown = r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ');
		line += `: ${shown}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	}
	if (r.backend) line += ` (via ${r.backend})`;
	if (r.missing.length) line += ` – skipped, not found: ${r.missing.join(', ')}`;
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
