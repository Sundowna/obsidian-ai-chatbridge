// Claude Code cloud sessions (claude.ai/code) -> the account's Code Cloud folder.
// Runs as part of the claude.ai sync, with the same login, delay and per-run limit.
// Like everywhere else, files are only ever CREATED: a changed session gets a new
// "(updated …)" transcript next to the old one.

import { TFile, type App } from 'obsidian';
import { type ClaudeApi, StopError } from '../api';
import { guardMissing } from '../missing-guard';
import { baseName, localStamp, tagAccount } from '../naming';
import type { ProgressFn } from '../progress';
import { masterRaw, mirrorRaw, rawBase, rawLink } from '../raw-folders';
import { cleanFolder, type ClaudeAccount, type CloudIndexEntry, type Settings } from '../settings';
import { createNew, ensureFolder, freeStem } from '../vaultio';
import { renderDesktopTranscript } from '../desktop/render';
import type { DesktopFs } from '../desktop/scan';
import { saveSessionFiles } from '../desktop/session-save';
import type { DesktopSession } from '../desktop/types';
import {
	checkCloudEvents, checkCloudList, cloudFolderName, cloudRaw, cloudUrl, isCloudSession, isRunning, parseCloudRaw, parseCloudSession, versionOf,
	type CloudEvent, type CloudSession,
} from './claude-cloud';

const MAX_LIST_PAGES = 50;
const MAX_EVENT_PAGES = 200;
const NO_FOLDER = 'Other';
export const CLOUD_APP_LABEL = 'Claude Code (cloud)';

export interface CloudSyncResult {
	listed: number;
	unchanged: number;
	/** Still working on claude.ai: saved once they are done. */
	running: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	written: string[];
	restored: string[];
	filesSaved: number;
}

export const emptyCloudResult = (): CloudSyncResult => ({ listed: 0, unchanged: 0, running: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], filesSaved: 0 });

export interface CloudSyncContext {
	app: App;
	settings: Settings;
	account: ClaudeAccount;
	api: ClaudeApi;
	delayMs: number;
	progress: ProgressFn;
	save: () => Promise<void>;
	sleep: (ms: number) => Promise<unknown>;
}

/** Cloud files have no path on this computer, so nothing is ever read from disk. */
const NO_DISK: DesktopFs = {
	home: '',
	env: () => undefined,
	readDir: () => Promise.resolve([]),
	stat: () => Promise.resolve(null),
	readText: () => Promise.resolve(null),
	readBytes: () => Promise.resolve(null),
};

async function listSessions(c: CloudSyncContext): Promise<CloudSession[]> {
	const out: CloudSession[] = [];
	let cursor: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= MAX_LIST_PAGES) throw new StopError('Claude Code session list did not end after 50 pages – stopped.');
		if (page > 0) await c.sleep(c.delayMs);
		const { json } = await c.api.get(c.api.codeSessionsPath(cursor));
		const p = checkCloudList(json);
		out.push(...p.sessions);
		c.progress(`reading Claude Code cloud sessions… ${out.length}`);
		if (!p.cursor || p.sessions.length === 0 || p.cursor === cursor) break;
		cursor = p.cursor;
	}
	const seen = new Set<string>();
	return out.filter((s) => !seen.has(s.id) && seen.add(s.id));
}

async function fetchEvents(c: CloudSyncContext, id: string): Promise<CloudEvent[]> {
	const out: CloudEvent[] = [];
	let cursor: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= MAX_EVENT_PAGES) throw new StopError('A Claude Code session had more than 200 pages of events – stopped.');
		await c.sleep(c.delayMs);
		const { json } = await c.api.get(c.api.codeEventsPath(id, cursor));
		const p = checkCloudEvents(json);
		out.push(...p.events);
		if (!p.cursor || p.events.length === 0 || p.cursor === cursor) break;
		cursor = p.cursor;
	}
	return out;
}

/** Transcript and raw folders for a session, as the settings say today. */
export function cloudFolders(settings: Settings, account: ClaudeAccount, session: CloudSession, parsed: DesktopSession): { md: string; raw: string } {
	const w = account.web;
	const base = cleanFolder(w.codeFolder);
	if (!base) throw new StopError('The Code Cloud folder setting is empty or invalid.');
	const sub = w.projectSubfolders ? cloudFolderName(session, parsed.cwd, NO_FOLDER) : '';
	const join = (b: string) => (sub ? `${b}/${sub}` : b);
	const md = join(base);
	const root = masterRaw(settings);
	if (root !== undefined) return { md, raw: mirrorRaw(md, root) };
	const rb = rawBase(w.codeRawFolder);
	return { md, raw: rb ? join(rb) : md };
}

function transcript(account: ClaudeAccount, session: CloudSession, parsed: DesktopSession, mdFolder: string, jsonPath: string, files: Record<string, string>): string {
	return tagAccount(renderDesktopTranscript(parsed, {
		source: cloudUrl(session.id),
		rawFileName: rawLink(mdFolder, jsonPath),
		files: new Map(Object.entries(files)),
		appLabel: CLOUD_APP_LABEL,
		extra: session.repo ? [['repo', session.repo]] : [],
	}), account.label);
}

/**
 * Saves new and changed cloud sessions, and writes again what was deleted from the vault.
 * `r` is filled as it goes, so a stop keeps what was done.
 */
export async function syncClaudeCloud(c: CloudSyncContext, r: CloudSyncResult): Promise<void> {
	const { app, account } = c;
	const w = account.web;
	const index = (w.cloudIndex ??= {});
	const exists = (p: string) => !!p && app.vault.getAbstractFileByPath(p) instanceof TFile;
	const saveFiles = c.settings.desktop.saveFiles;

	const sessions = (await listSessions(c)).filter(isCloudSession);
	r.listed = sessions.length;

	// Before anything is written: many saved sessions missing means a wrong sync history, not deletions.
	const saved = Object.values(index).filter((e) => e.md);
	guardMissing('Claude Code cloud sessions', saved.length, saved.filter((e) => !exists(e.md) || !exists(e.json)).length);

	const todoAll: { session: CloudSession; entry?: CloudIndexEntry }[] = [];
	for (const session of sessions) {
		const entry = index[session.id];
		if (isRunning(session)) {
			if (!entry || entry.updated !== versionOf(session)) r.running++;
			continue;
		}
		if (entry && entry.updated === versionOf(session)) continue;
		todoAll.push({ session, entry });
	}
	// Oldest first, so a per-run limit works through them in order.
	todoAll.sort((a, b) => versionOf(a.session).localeCompare(versionOf(b.session)));
	r.unchanged = sessions.length - todoAll.length - r.running;
	const max = c.settings.maxChatsPerRun;
	const todo = max > 0 ? todoAll.slice(0, max) : todoAll;
	r.leftForLater = todoAll.length - todo.length;
	const done = new Set<string>();

	for (const [i, { session, entry }] of todo.entries()) {
		c.progress(`${i + 1} of ${todo.length} Claude Code cloud sessions: ${session.title ?? session.id}`, i, todo.length);
		const events = await fetchEvents(c, session.id);
		const parsed = parseCloudSession(session, events);
		done.add(session.id);
		if (!parsed) {
			// No message from you yet: remember the version so it is not fetched again until it changes.
			index[session.id] = { ...(entry ?? { md: '', json: '' }), updated: versionOf(session), synced: new Date().toISOString() };
			await c.save();
			continue;
		}
		const isUpdate = !!entry?.md;
		const { md: folder, raw: rawFolder } = cloudFolders(c.settings, account, session, parsed);
		await ensureFolder(app, folder);
		await ensureFolder(app, rawFolder);
		let stem = baseName(parsed.created, parsed.title);
		if (isUpdate) stem = `${stem} (updated ${localStamp(versionOf(session))})`;
		stem = freeStem(app, folder, stem, session.id.replace(/^cse_/, ''), rawFolder);

		const jsonPath = `${rawFolder}/${stem}.json`;
		const mdPath = `${folder}/${stem}.md`;
		await createNew(app, jsonPath, cloudRaw(session, events));
		const files = saveFiles ? await saveSessionFiles({ app, fs: NO_DISK }, parsed, folder, stem, entry?.files) : { files: {}, saved: 0 };
		r.filesSaved += files.saved;
		await createNew(app, mdPath, transcript(account, session, parsed, folder, jsonPath, files.files));

		index[session.id] = { updated: versionOf(session), md: mdPath, json: jsonPath, synced: new Date().toISOString(), files: files.files };
		await c.save();
		r.written.push(stem);
		if (isUpdate) r.changedCount++;
		else r.newCount++;
	}

	// Restore: saved sessions whose .md or .json was deleted from the vault.
	for (const session of sessions) {
		const entry = index[session.id];
		if (!entry?.md || done.has(session.id)) continue;
		const mdOk = exists(entry.md);
		const jsonOk = exists(entry.json);
		if (mdOk && jsonOk) continue;
		let saved: { session: CloudSession; events: CloudEvent[] };
		if (jsonOk) {
			try {
				saved = parseCloudRaw(await app.vault.adapter.read(entry.json));
			} catch {
				continue; // unreadable saved file: leave it alone
			}
		} else {
			// The .json is gone: fetch the session again (its current version).
			saved = { session, events: await fetchEvents(c, session.id) };
		}
		const parsed = parseCloudSession(saved.session, saved.events);
		if (!parsed) continue;
		const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
		const jsonPath = entry.json && dirOf(entry.json) ? entry.json : `${cloudFolders(c.settings, account, session, parsed).raw}/${(entry.md.split('/').pop() ?? 'session').replace(/\.md$/, '')}.json`;
		await ensureFolder(app, dirOf(jsonPath));
		await ensureFolder(app, dirOf(entry.md));
		if (!jsonOk) await createNew(app, jsonPath, cloudRaw(saved.session, saved.events));
		if (!mdOk) await createNew(app, entry.md, transcript(account, saved.session, parsed, dirOf(entry.md), jsonPath, entry.files ?? {}));
		index[session.id] = { ...entry, json: jsonPath };
		await c.save();
		r.restored.push((entry.md.split('/').pop() ?? '').replace(/\.md$/, ''));
	}
}
