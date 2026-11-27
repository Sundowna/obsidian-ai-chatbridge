// One AI memory run: read each source that is turned on -> fingerprint what was read ->
// if it differs from the last snapshot, write a new dated snapshot and refresh _latest.md -> log.
// Unchanged memories write nothing at all. A dated snapshot is never written over; only
// _latest.md is.

import { TFile } from 'obsidian';
import type AIChatBridge from '../main';
import { loginRef } from '../accounts';
import { ClaudeApi } from '../api';
import { GptApi } from '../chatgpt/api';
import { claudeAuth } from '../claude-auth';
import { computerName } from '../computer';
import { pastedSession } from '../cookies';
import { nodeDesktopFs, type DesktopFs } from '../desktop/scan';
import { isPrivatePath, pickBackend, type SqliteBackend } from '../hermes/reader';
import { appendLog } from '../log';
import { dailyNoteName, safeTitle } from '../naming';
import type { ProgressFn } from '../progress';
import { cleanFolder, type ChatgptAccount, type ClaudeAccount, type GeminiAccount, type LumoAccount } from '../settings';
import { createNew, ensureFolder, findFile, writeOver } from '../vaultio';
import { captureChatgpt, type MemoryGptApi } from './chatgpt-web';
import { captureClaude, type MemoryClaudeApi } from './claude-web';
import { captureLumo, type MemoryLumoApi } from './lumo-web';
import { captureGemini, type MemoryGeminiApi } from './gemini-web';
import { GeminiApi } from '../gemini/api';
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

/** The ChatGPT accounts whose memories on chatgpt.com are turned on (accounts that were removed do not count). */
export const chatgptMemoryAccounts = (plugin: AIChatBridge): ChatgptAccount[] => plugin.settings.chatgpt.filter((a) => plugin.settings.memory.chatgptWeb[a.id]);

/** The Claude accounts whose memories on claude.ai are turned on. */
export const claudeMemoryAccounts = (plugin: AIChatBridge): ClaudeAccount[] => plugin.settings.claude.filter((a) => plugin.settings.memory.claudeWeb[a.id]);

/** The Lumo accounts whose memories in Lumo are turned on. */
export const lumoMemoryAccounts = (plugin: AIChatBridge): LumoAccount[] => plugin.settings.lumo.filter((a) => plugin.settings.memory.lumoWeb?.[a.id] === true);

/** The Gemini accounts whose own Gems are turned on. */
export const geminiMemoryAccounts = (plugin: AIChatBridge): GeminiAccount[] => plugin.settings.gemini.filter((a) => plugin.settings.memory.geminiWeb?.[a.id] === true);

export const anyMemoryEnabled = (plugin: AIChatBridge): boolean =>
	plugin.settings.memory.codexLocal || plugin.settings.memory.claudeCodeLocal || claudeMemoryAccounts(plugin).length > 0 || chatgptMemoryAccounts(plugin).length > 0 || lumoMemoryAccounts(plugin).length > 0 || geminiMemoryAccounts(plugin).length > 0;

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface MemoryRunOptions {
	fs?: DesktopFs | null;
	/** The SQLite reader for Codex's memory database; found automatically when left out. */
	backend?: SqliteBackend | null;
	now?: Date;
	/** The account folder for local sources: this computer's name. */
	account?: string;
	/** The connection to chatgpt.com for an account; a test hands in a fake. */
	gpt?: (account: ChatgptAccount) => Promise<MemoryGptApi>;
	/** The connection to claude.ai for an account; a test hands in a fake. */
	claude?: (account: ClaudeAccount) => Promise<MemoryClaudeApi>;
	/** The wait between two memory file reads on claude.ai, and between two pages of Lumo's project list (ms). */
	pauseMs?: number;
	/** The connection to Gemini for an account; a test hands in a fake. */
	gemini?: (account: GeminiAccount) => Promise<MemoryGeminiApi>;
	/** The connection to Lumo for an account; a test hands in a fake. Closed by the caller when given. */
	lumo?: (account: LumoAccount) => Promise<MemoryLumoApi>;
}

export async function runMemorySync(plugin: AIChatBridge, progress: ProgressFn = () => undefined, o: MemoryRunOptions = {}): Promise<MemorySyncResult> {
	const m = plugin.settings.memory;
	const result: MemorySyncResult = { newCount: 0, changedCount: 0, unchanged: 0, written: [], restored: [], leftForLater: 0, nothing: [], redactions: [] };
	const now = o.now ?? new Date();
	try {
		const local = m.codexLocal || m.claudeCodeLocal;
		const web = chatgptMemoryAccounts(plugin);
		const claudeWeb = claudeMemoryAccounts(plugin);
		const lumoWeb = lumoMemoryAccounts(plugin);
		const geminiWeb = geminiMemoryAccounts(plugin);
		const steps = (m.codexLocal ? 1 : 0) + (m.claudeCodeLocal ? 1 : 0) + claudeWeb.length + web.length + lumoWeb.length + geminiWeb.length;
		let step = 0;
		const fs = o.fs === undefined ? nodeDesktopFs() : o.fs;
		if (local && !fs) throw new Error('AI memory on this computer can only be read in Obsidian on desktop.');
		const base = cleanFolder(m.folder);
		if (!base) throw new Error('The memory folder setting is empty or invalid.');
		if (isPrivatePath(base)) throw new Error('The memory folder is inside a Private folder, which is never written to.');
		const account = o.account ?? (local ? computerName() : '');

		if (m.codexLocal && fs) {
			progress('AI memory: reading Codex…', step++, steps);
			const backend = o.backend === undefined ? await pickBackend(plugin.settings.hermes.pythonPath, []) : o.backend;
			await save(plugin, await captureCodex(fs, account, backend), base, now, result);
		}
		if (m.claudeCodeLocal && fs) {
			progress('AI memory: reading Claude Code…', step++, steps);
			await save(plugin, await captureClaudeCode(fs, account), base, now, result);
		}
		// The websites last: a login that has run out stops the run, and the local snapshots are saved by then.
		for (const acc of claudeWeb) {
			progress(`AI memory: reading Claude (${acc.label})…`, step++, steps);
			let api: MemoryClaudeApi;
			if (o.claude) api = await o.claude(acc);
			else {
				const auth = await claudeAuth(plugin, acc);
				api = new ClaudeApi(auth.orgId, auth.getKey, { provider: 'claude', accountId: acc.id }, auth.transport);
			}
			const pauseMs = o.pauseMs ?? 300;
			await save(plugin, await captureClaude(api, acc.label, () => (pauseMs > 0 ? new Promise((done) => window.setTimeout(done, pauseMs)) : Promise.resolve())), base, now, result);
		}
		for (const acc of web) {
			progress(`AI memory: reading ChatGPT (${acc.label})…`, step++, steps);
			const api = o.gpt ? await o.gpt(acc) : await GptApi.connect(loginRef('chatgpt', acc), pastedSession(plugin.app, acc.web.secretId));
			await save(plugin, await captureChatgpt(api, acc.label), base, now, result);
		}
		for (const acc of geminiWeb) {
			progress(`AI memory: reading Gemini (${acc.label})…`, step++, steps);
			if (o.gemini) {
				await save(plugin, await captureGemini(await o.gemini(acc), acc.label), base, now, result);
				continue;
			}
			const g = await GeminiApi.connect(loginRef('gemini', acc), pastedSession(plugin.app, acc.web.secretId));
			try {
				await save(plugin, await captureGemini(g, acc.label), base, now, result);
			} finally {
				g.close();
			}
		}
		for (const acc of lumoWeb) {
			progress(`AI memory: reading Lumo (${acc.label})…`, step++, steps);
			if (o.lumo) {
				await save(plugin, await captureLumo(await o.lumo(acc), acc.label), base, now, result);
				continue;
			}
			const pauseMs = o.pauseMs ?? Math.max(1, plugin.settings.delaySeconds) * 1000;
			const wait = () => new Promise<void>((done) => window.setTimeout(done, pauseMs));
			// Loaded only when a Lumo memory is read: it brings Proton's key library with it.
			const [{ LumoApi }, { projectInstructions }, { allSpaces }] = await Promise.all([import('../lumo/api'), import('../lumo/chat'), import('../lumo/sync')]);
			const a = await LumoApi.connect(loginRef('lumo', acc));
			try {
				const capture = await captureLumo({
					userSettings: () => a.userSettings(),
					projects: async () => projectInstructions(await allSpaces(a, wait, () => undefined), a.masterKeys),
				}, acc.label);
				await save(plugin, capture, base, now, result);
			} finally {
				a.close();
			}
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
		const f = findFile(app, p);
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
	const name = names.find((n) => !findFile(app, `${folder}/${n}.md`));
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
