// One AI memory run: read each source that is turned on -> fingerprint what was read ->
// if it differs from the last snapshot, write a new dated snapshot and refresh _latest.md -> log.
// Unchanged memories write nothing at all. A dated snapshot is never written over; only
// _latest.md is.

import { TFile } from 'obsidian';
import type AIChatBridge from '../main';
import { computerName } from '../computer';
import { nodeDesktopFs, type DesktopFs } from '../desktop/scan';
import { isPrivatePath, pickBackend, type SqliteBackend } from '../hermes/reader';
import { appendLog } from '../log';
import { dailyNoteName, safeTitle } from '../naming';
import type { ProgressFn } from '../progress';
import { cleanFolder } from '../settings';
import { createNew, ensureFolder, writeOver } from '../vaultio';
import { describeHits, redact } from './redact';
import { hashOfNote, renderBody, renderNote, sha256 } from './render';
import { captureClaudeCode, captureCodex } from './sources';
import type { MemoryCapture } from './types';

export interface MemorySyncResult {
	/** First snapshot of a source. */
	newCount: number;
	/** A later snapshot, because the memories changed. */
	changedCount: number;
	unchanged: number;
	/** Snapshots written, as vault paths without ".md". */
	written: string[];
	restored: string[];
	leftForLater: number;
	/** Sources turned on with nothing to read (the AI has no home folder here). */
	nothing: string[];
	/** What the privacy filter replaced in the snapshots written: "1 password in Codex /memories/x.md". Never a value. */
	redactions: string[];
	stopped?: string;
}

export const LATEST = '_latest.md';

export const anyMemoryEnabled = (plugin: AIChatBridge): boolean => plugin.settings.memory.codexLocal || plugin.settings.memory.claudeCodeLocal;

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface MemoryRunOptions {
	fs?: DesktopFs | null;
	/** The SQLite reader for Codex's memory database; found automatically when left out. */
	backend?: SqliteBackend | null;
	now?: Date;
	/** The account folder for local sources: this computer's name. */
	account?: string;
}

export async function runMemorySync(plugin: AIChatBridge, progress: ProgressFn = () => undefined, o: MemoryRunOptions = {}): Promise<MemorySyncResult> {
	const m = plugin.settings.memory;
	const result: MemorySyncResult = { newCount: 0, changedCount: 0, unchanged: 0, written: [], restored: [], leftForLater: 0, nothing: [], redactions: [] };
	const now = o.now ?? new Date();
	try {
		const fs = o.fs === undefined ? nodeDesktopFs() : o.fs;
		if (!fs) throw new Error('AI memory on this computer can only be read in Obsidian on desktop.');
		const base = cleanFolder(m.folder);
		if (!base) throw new Error('The memory folder setting is empty or invalid.');
		if (isPrivatePath(base)) throw new Error('The memory folder is inside a Private folder, which is never written to.');
		const account = o.account ?? computerName();

		if (m.codexLocal) {
			progress('AI memory: reading Codex…', 0, 2);
			const backend = o.backend === undefined ? await pickBackend(plugin.settings.hermes.pythonPath, []) : o.backend;
			await save(plugin, await captureCodex(fs, account, backend), base, now, result);
		}
		if (m.claudeCodeLocal) {
			progress('AI memory: reading Claude Code…', 1, 2);
			await save(plugin, await captureClaudeCode(fs, account), base, now, result);
		}
	} catch (e) {
		result.stopped = e instanceof Error ? e.message : String(e);
	}
	await writeLog(plugin, result, now);
	return result;
}

/** Writes a snapshot if this capture differs from the last one. */
async function save(plugin: AIChatBridge, c: MemoryCapture, base: string, now: Date, result: MemorySyncResult): Promise<void> {
	const app = plugin.app;
	if (!c.found) {
		result.nothing.push(c.provider);
		return;
	}
	const fileAt = (p: string): TFile | null => {
		const f = app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	};
	const key = `${c.provider}/${c.account}`;
	const folder = `${base}/${safeTitle(c.provider)}/${safeTitle(c.account)}`;
	const latestPath = `${folder}/${LATEST}`;
	// The privacy filter runs before anything is fingerprinted or written, so a replaced value never reaches the vault.
	const found: string[] = [];
	if (plugin.settings.memory.redact) {
		let total = 0;
		c = {
			...c,
			files: c.files.map((f) => {
				if (!f.text) return f;
				const r = redact(f.text);
				if (!r.total) return f;
				total += r.total;
				found.push(`${describeHits(r.hits)} in ${c.provider} ${f.path}`);
				return { ...f, text: r.text };
			}),
		};
		if (total) c.redacted = total;
	}
	const body = renderBody(c);
	const hash = await sha256(body);

	const states = plugin.settings.memory.states;
	const state = states[key];
	const latest = fileAt(latestPath);
	// The sync history first; without it (new vault copy, cleared settings) the hash in _latest.md.
	const before = state?.hash ?? (latest ? hashOfNote(await app.vault.read(latest)) : null);
	// Unchanged counts only while a snapshot is still there: delete them all and the next sync saves again.
	if (before === hash && (latest || (state && fileAt(state.snapshot)))) {
		if (!state) {
			states[key] = { hash, snapshot: latestPath, synced: now.toISOString(), files: c.files.length };
			await plugin.saveSettings();
		}
		result.unchanged++;
		return;
	}

	await ensureFolder(app, folder);
	const date = dateOf(now);
	// A second change on the same day gets the time in its name: a snapshot is never written over.
	const names = [date, `${date} (${pad(now.getHours())}${pad(now.getMinutes())})`, `${date} (${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())})`];
	const name = names.find((n) => !app.vault.getAbstractFileByPath(`${folder}/${n}.md`));
	if (!name) throw new Error(`No free file name for a ${c.provider} snapshot in ${folder}.`);
	const stem = `${folder}/${name}`;
	await createNew(app, `${stem}.md`, renderNote(c, body, { synced: date, hash }));
	await writeOver(app, latestPath, renderNote(c, body, { synced: date, hash, snapshot: stem }));
	states[key] = { hash, snapshot: `${stem}.md`, synced: now.toISOString(), files: c.files.length };
	await plugin.saveSettings();
	result.written.push(stem);
	result.redactions.push(...found);
	if (before) result.changedCount++;
	else result.newCount++;
}

async function writeLog(plugin: AIChatBridge, r: MemorySyncResult, now: Date): Promise<void> {
	if (!r.written.length && !r.stopped) return;
	const parts = [`**AI memory:** ${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	let line = `- [[${dailyNoteName(now)}]] ${pad(now.getHours())}:${pad(now.getMinutes())} – ${parts.join(', ')}`;
	if (r.written.length) line += `: ${r.written.map((w) => `[[${w}|${w.split('/').slice(-3).join(' / ')}]]`).join(', ')}`;
	if (r.redactions.length) line += ` – replaced by [REDACTED]: ${r.redactions.join('; ')}`;
	if (r.nothing.length) line += ` – nothing to read for: ${r.nothing.join(', ')}`;
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
