// Codex cloud tasks (chatgpt.com/codex) -> the account's Codex Cloud folder.
// Runs as part of the ChatGPT sync, after the chats, with the same login, delay and per-run limit.
// Like everywhere else, a task has one note: when it goes on, the note is rewritten and the
// version before stays in the raw folder (see versions.ts).

import { TFile, type App } from 'obsidian';
import { StopError } from '../api';
import { guardMissing } from '../missing-guard';
import { baseName, tagAccount } from '../naming';
import type { ProgressFn } from '../progress';
import { masterRaw, mirrorRaw, rawBase, rawLink } from '../raw-folders';
import { cleanFolder, type ChatgptAccount, type CloudIndexEntry, type Settings } from '../settings';
import { createNew, ensureFolder, freeStem } from '../vaultio';
import { addVersion, keepVersion, noteHash, recordEdit, withVersionInfo, writeNote, writeRaw } from '../versions';
import { renderDesktopTranscript } from '../desktop/render';
import {
	checkCodexList, checkCodexTask, codexChangesSection, codexFolderName, codexRaw, codexTaskUrl, isRunning, parseCodexRaw, parseCodexTask, versionOf,
	type CodexCloudTranscript, type CodexTask, type CodexTaskDetails,
} from './codex-cloud';
import type { CloudSyncResult } from './sync';

const MAX_LIST_PAGES = 50;
const NO_FOLDER = 'Other';
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const stemOf = (p: string) => (p.split('/').pop() ?? '').replace(/\.md$/, '');
export const CODEX_CLOUD_APP_LABEL = 'Codex (cloud)';

/** The parts of GptApi this needs (a fake in the tests). */
export interface CodexCloudApi {
	get(path: string): Promise<{ json: unknown }>;
	codexTasksPath(cursor?: string): string;
	codexTaskPath(id: string): string;
}

export interface CodexCloudContext {
	app: App;
	settings: Settings;
	account: ChatgptAccount;
	api: CodexCloudApi;
	delayMs: number;
	progress: ProgressFn;
	save: () => Promise<void>;
	sleep: (ms: number) => Promise<unknown>;
}

async function listTasks(c: CodexCloudContext): Promise<CodexTask[]> {
	const out: CodexTask[] = [];
	let cursor: string | undefined;
	for (let page = 0; ; page++) {
		if (page >= MAX_LIST_PAGES) throw new StopError('Codex task list did not end after 50 pages – stopped.');
		await c.sleep(c.delayMs);
		const { json } = await c.api.get(c.api.codexTasksPath(cursor));
		const p = checkCodexList(json);
		out.push(...p.tasks);
		c.progress(`reading Codex cloud tasks… ${out.length}`);
		if (!p.cursor || p.tasks.length === 0 || p.cursor === cursor) break;
		cursor = p.cursor;
	}
	const seen = new Set<string>();
	return out.filter((t) => !seen.has(t.id) && seen.add(t.id));
}

async function fetchTask(c: CodexCloudContext, id: string): Promise<CodexTaskDetails> {
	await c.sleep(c.delayMs);
	const { json } = await c.api.get(c.api.codexTaskPath(id));
	return checkCodexTask(json, id);
}

/** Transcript and raw folders for a task, as the settings say today. */
export function codexCloudFolders(settings: Settings, account: ChatgptAccount, task: CodexTask): { md: string; raw: string } {
	const w = account.web;
	const base = cleanFolder(w.codexCloudFolder);
	if (!base) throw new StopError('The Codex Cloud folder setting is empty or invalid.');
	const sub = w.projectSubfolders ? codexFolderName(task, NO_FOLDER) : '';
	const join = (b: string) => (sub ? `${b}/${sub}` : b);
	const md = join(base);
	const root = masterRaw(settings);
	if (root !== undefined) return { md, raw: mirrorRaw(md, root) };
	const rb = rawBase(w.codexCloudRawFolder);
	return { md, raw: rb ? join(rb) : md };
}

function transcript(account: ChatgptAccount, task: CodexTask, t: CodexCloudTranscript, mdFolder: string, jsonPath: string): string {
	const extra: [string, string][] = [];
	if (task.environment) extra.push(['environment', task.environment]);
	if (task.status) extra.push(['status', task.status]);
	const pr = t.pullRequests[0];
	if (pr) extra.push(['pull_request', pr.url]);
	const md = renderDesktopTranscript(t.session, {
		source: codexTaskUrl(task.id),
		rawFileName: rawLink(mdFolder, jsonPath),
		appLabel: CODEX_CLOUD_APP_LABEL,
		extra,
	});
	const changes = codexChangesSection(t);
	return tagAccount(changes ? `${md.replace(/\n*$/, '\n')}\n${changes}` : md, account.label);
}

/**
 * Saves new and changed Codex cloud tasks, and writes again what was deleted from the vault.
 * `r` is filled as it goes, so a stop keeps what was done.
 */
export async function syncCodexCloud(c: CodexCloudContext, r: CloudSyncResult): Promise<void> {
	const { app, account } = c;
	const index = (account.web.codexCloudIndex ??= {});
	const exists = (p: string) => !!p && app.vault.getAbstractFileByPath(p) instanceof TFile;

	const tasks = await listTasks(c);
	r.listed = tasks.length;

	// Before anything is written: many saved tasks missing means a wrong sync history, not deletions.
	const saved = Object.values(index).filter((e) => e.md);
	guardMissing('Codex cloud tasks', saved.length, saved.filter((e) => !exists(e.md) || !exists(e.json)).length);

	const todoAll: { task: CodexTask; entry?: CloudIndexEntry }[] = [];
	for (const task of tasks) {
		const entry = index[task.id];
		if (isRunning(task)) {
			if (!entry || entry.updated !== versionOf(task)) r.running++;
			continue;
		}
		if (entry && entry.updated === versionOf(task)) continue;
		todoAll.push({ task, entry });
	}
	// Oldest first, so a per-run limit works through them in order.
	todoAll.sort((a, b) => versionOf(a.task).localeCompare(versionOf(b.task)));
	r.unchanged = tasks.length - todoAll.length - r.running;
	const max = c.settings.maxChatsPerRun;
	const todo = max > 0 ? todoAll.slice(0, max) : todoAll;
	r.leftForLater = todoAll.length - todo.length;
	const done = new Set<string>();

	for (const [i, { task, entry }] of todo.entries()) {
		c.progress(`${i + 1} of ${todo.length} Codex cloud tasks: ${task.title ?? task.id}`, i, todo.length);
		const details = await fetchTask(c, task.id);
		const parsed = parseCodexTask(task, details);
		done.add(task.id);
		if (!parsed) {
			// No message from you: remember the version so it is not fetched again until it changes.
			index[task.id] = { ...(entry ?? { md: '', json: '' }), updated: versionOf(task), synced: new Date().toISOString() };
			await c.save();
			continue;
		}
		// A task that goes on keeps its one note, where it is now; only a new one is given a place.
		const before = entry?.md ? entry : undefined;
		const today = codexCloudFolders(c.settings, account, task);
		const folder = before ? dirOf(before.md) : today.md;
		const stem = before ? stemOf(before.md) : freeStem(app, folder, baseName(parsed.session.created, parsed.session.title), task.id.replace(/^task_(?:e_)?/, ''), today.raw);
		const mdPath = before?.md ?? `${folder}/${stem}.md`;
		const jsonPath = before?.json || `${today.raw}/${stem}.json`;
		await ensureFolder(app, folder);

		const raw = codexRaw(task, details);
		const versions = addVersion(before, before ? await keepVersion(app, [jsonPath], before.updated, raw) : null);
		await writeRaw(app, jsonPath, raw);
		const note = await writeNote(app, mdPath, withVersionInfo(transcript(account, task, parsed, folder, jsonPath), versions, folder), { policy: c.settings.editedNotes, lastHash: before?.noteHash, lastSynced: before?.synced });
		recordEdit(r.edits, note, mdPath);

		index[task.id] = { updated: versionOf(task), md: mdPath, json: jsonPath, synced: new Date().toISOString(), versions, noteHash: note.hash };
		await c.save();
		r.written.push(stem);
		if (before) r.changedCount++;
		else r.newCount++;
	}

	// Restore: saved tasks whose .md or .json was deleted from the vault.
	for (const task of tasks) {
		const entry = index[task.id];
		if (!entry?.md || done.has(task.id)) continue;
		const mdOk = exists(entry.md);
		const jsonOk = exists(entry.json);
		if (mdOk && jsonOk) continue;
		let kept: { task: CodexTask; details: CodexTaskDetails };
		if (jsonOk) {
			try {
				kept = parseCodexRaw(await app.vault.adapter.read(entry.json));
			} catch {
				continue; // unreadable saved file: leave it alone
			}
		} else {
			// The .json is gone: fetch the task again (its current version).
			kept = { task, details: await fetchTask(c, task.id) };
		}
		const parsed = parseCodexTask(kept.task, kept.details);
		if (!parsed) continue;
		const jsonPath = entry.json && dirOf(entry.json) ? entry.json : `${codexCloudFolders(c.settings, account, task).raw}/${stemOf(entry.md)}.json`;
		await ensureFolder(app, dirOf(jsonPath));
		await ensureFolder(app, dirOf(entry.md));
		if (!jsonOk) await createNew(app, jsonPath, codexRaw(kept.task, kept.details));
		let hash = entry.noteHash;
		if (!mdOk) {
			const md = withVersionInfo(transcript(account, kept.task, parsed, dirOf(entry.md), jsonPath), entry.versions, dirOf(entry.md));
			await createNew(app, entry.md, md);
			hash = noteHash(md);
		}
		index[task.id] = { ...entry, json: jsonPath, noteHash: hash };
		await c.save();
		r.restored.push(stemOf(entry.md));
	}
}
