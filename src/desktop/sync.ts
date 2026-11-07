// One desktop sync run: find session files -> skip unchanged and still-active ones ->
// write a transcript (and optionally a raw copy) for each new or changed session -> log.
// Like the other providers, files are only ever CREATED: a changed session gets a new
// "(updated …)" transcript next to the old one.

import { TFile } from 'obsidian';
import type AIChatBridge from '../main';
import { appendLog } from '../log';
import { baseName, dailyNoteName, localStamp, safeTitle } from '../naming';
import type { ProgressFn } from '../progress';
import { cleanFolder } from '../settings';
import { createNew, ensureFolder } from '../vaultio';
import { parseClaudeSession } from './claude-code';
import { codexTitles, parseCodexSession } from './codex';
import { findLatestJson } from './leveldb';
import { renderDesktopTranscript, sessionFolderName } from './render';
import { claudeDesktopMetaFiles, claudeLocalStorageFiles, codexHome, listSessionFiles, nodeDesktopFs, type DesktopFs, type SourceFile } from './scan';
import { claudeGroups, claudePlacement, codexProjectFor, parseClaudeMeta, parseCodexState, type ClaudeDesktopMeta, type CodexProjects } from './sections';
import { APP_LABEL, type DesktopApp, type DesktopSession } from './types';

export interface DesktopSyncResult {
	listed: number;
	unchanged: number;
	newCount: number;
	changedCount: number;
	leftForLater: number;
	/** Files still being written (changed within the quiet period). */
	active: number;
	/** Files with no message from you (empty or helper-only sessions). */
	empty: number;
	written: string[];
	restored: string[];
	stopped?: string;
}

const APPS: DesktopApp[] = ['claude', 'codex'];
/** Folder for sessions without a recorded working folder. */
const NO_FOLDER = 'Other';
/** Codex threads outside a project, like the app's "Recents". */
const RECENT = 'Recent';

interface ClaudeApp {
	metas: Map<string, ClaudeDesktopMeta>;
	byCli: Map<string, ClaudeDesktopMeta>;
	groups: Map<string, string>;
}

export function anyDesktopEnabled(plugin: AIChatBridge): boolean {
	const d = plugin.settings.desktop;
	return APPS.some((a) => d[a].enabled);
}

interface Todo {
	file: SourceFile;
	session: DesktopSession;
	text: string;
	isUpdate: boolean;
}

export async function runDesktopSync(
	plugin: AIChatBridge,
	progress: ProgressFn = () => undefined,
	fs: DesktopFs | null = nodeDesktopFs(),
	now = Date.now(),
): Promise<DesktopSyncResult> {
	const app = plugin.app;
	const s = plugin.settings;
	const d = s.desktop;
	const result: DesktopSyncResult = { listed: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, active: 0, empty: 0, written: [], restored: [] };
	const exists = (p: string | undefined): boolean => !!p && app.vault.getAbstractFileByPath(p) instanceof TFile;
	const quietMs = Math.max(0, d.quietMinutes) * 60_000;

	const pathTaken = (p: string) => app.vault.getAbstractFileByPath(p) !== null;
	/** A stem free for both the .md and the raw .jsonl. */
	const freeStem = (folder: string, stem: string, id: string): string => {
		const free = (x: string) => !pathTaken(`${folder}/${x}.md`) && !pathTaken(`${folder}/${x}.jsonl`);
		if (free(stem)) return stem;
		const withId = `${stem} (${id.slice(0, 8)})`;
		if (free(withId)) return withId;
		for (let i = 2; i < 1000; i++) if (free(`${withId} ${i}`)) return `${withId} ${i}`;
		throw new Error(`No free file name for ${stem}`);
	};

	try {
		if (!fs) throw new Error('Desktop app chats can only be read on a computer.');
		const todo: Todo[] = [];
		let codexTitleMap: Map<string, string> | null = null;
		let codexProjects: CodexProjects | null = null;
		let claude: ClaudeApp | null = null;
		/** The Code tab's titles, groups and nesting, as the Claude desktop app shows them. */
		const loadClaude = async (): Promise<ClaudeApp> => {
			const metas = new Map<string, ClaudeDesktopMeta>();
			const byCli = new Map<string, ClaudeDesktopMeta>();
			for (const p of await claudeDesktopMetaFiles(fs)) {
				const m = parseClaudeMeta((await fs.readText(p)) ?? '');
				if (!m) continue;
				metas.set(m.localId, m);
				for (const id of m.cliIds) if (!byCli.has(id)) byCli.set(id, m);
			}
			const conf = d.claude;
			let groups = claudeGroups(findLatestJson(await claudeLocalStorageFiles(fs), 'customGroupsByScope'));
			// The app may be mid-write: then use the groups seen last time.
			if (groups.size) conf.groupCache = Object.fromEntries(groups);
			else groups = new Map(Object.entries(conf.groupCache ?? {}));
			return { metas, byCli, groups };
		};
		/** Subfolder inside the app's folder: the sidebar section (and parent session, if nested). */
		const sectionOf = (session: DesktopSession): string => {
			if (session.app === 'codex') return codexProjectFor(codexProjects!, session.id, session.cwd) ?? RECENT;
			const meta = claude!.byCli.get(session.id);
			const place = meta ? claudePlacement(meta.localId, claude!.metas, claude!.groups) : {};
			const section = place.group ? safeTitle(place.group) : sessionFolderName(session.cwd, NO_FOLDER);
			return place.parentTitle ? `${section}/${safeTitle(place.parentTitle)}` : section;
		};

		for (const which of APPS) {
			const conf = d[which];
			if (!conf.enabled) continue;
			if (!cleanFolder(conf.folder)) throw new Error(`The ${APP_LABEL[which]} folder setting is empty or invalid.`);
			progress(`${APP_LABEL[which]}: looking for sessions…`);
			const files = await listSessionFiles(fs, which, conf.extraFolders);
			result.listed += files.length;
			conf.ignored ??= {};

			for (const file of files) {
				if (now - file.mtime < quietMs) {
					result.active++;
					continue;
				}
				const key = file.path.toLowerCase();
				if (conf.ignored[key] === file.mtime) {
					result.empty++;
					continue;
				}
				const known = Object.values(conf.index).find((e) => e.source.toLowerCase() === key);
				if (known && known.size === file.size && known.mtime === file.mtime && exists(known.md)) {
					result.unchanged++;
					continue;
				}
				const text = await fs.readText(file.path);
				if (text === null) continue; // vanished or locked: try again next run
				let session: DesktopSession | null;
				if (which === 'claude') {
					claude ??= await loadClaude();
					const titles = new Map([...claude.byCli].flatMap(([id, m]) => (m.title ? [[id, m.title] as [string, string]] : [])));
					session = parseClaudeSession(text, (file.path.split('/').pop() ?? '').replace(/\.jsonl$/, ''), titles);
				} else {
					codexTitleMap ??= codexTitles((await fs.readText(`${codexHome(fs)}/session_index.jsonl`)) ?? '');
					codexProjects ??= parseCodexState((await fs.readText(`${codexHome(fs)}/.codex-global-state.json`)) ?? '');
					session = parseCodexSession(text, codexTitleMap);
				}
				if (session) session.section = sectionOf(session);
				if (!session || (session.isSubagent && !d.includeSubagents)) {
					conf.ignored[key] = file.mtime;
					result.empty++;
					continue;
				}
				delete conf.ignored[key];

				const entry = conf.index[session.id];
				if (entry && entry.updated === session.updated) {
					// Same conversation (only moved, or bookkeeping lines added).
					Object.assign(entry, { size: file.size, mtime: file.mtime, source: file.path });
					if (exists(entry.md)) {
						result.unchanged++;
						continue;
					}
					// Transcript deleted from the vault: write it again under the same name, so links stay valid.
					const folder = entry.md.split('/').slice(0, -1).join('/');
					await ensureFolder(app, folder);
					await createNew(app, entry.md, renderDesktopTranscript(session, { source: file.path, rawFileName: exists(entry.raw) ? entry.raw!.split('/').pop() : undefined }));
					result.restored.push(entry.md.split('/').pop()!.replace(/\.md$/, ''));
					continue;
				}
				todo.push({ file, session, text, isUpdate: !!entry });
			}
			await plugin.saveSettings();
		}

		// Oldest first, so a limited run keeps the vault's order sensible.
		todo.sort((a, b) => a.session.updated.localeCompare(b.session.updated));
		const limit = s.maxChatsPerRun > 0 ? s.maxChatsPerRun : todo.length;
		result.leftForLater = Math.max(0, todo.length - limit);

		for (const [i, { file, session, text, isUpdate }] of todo.slice(0, limit).entries()) {
			progress(`${i + 1} of ${Math.min(limit, todo.length)} sessions: ${session.title}`, i, Math.min(limit, todo.length));
			const conf = d[session.app];
			const base = cleanFolder(conf.folder)!;
			const folder = d.projectSubfolders && session.section ? `${base}/${session.section}` : base;
			await ensureFolder(app, folder);
			let stem = baseName(session.created, session.title);
			if (isUpdate) stem = `${stem} (updated ${localStamp(session.updated)})`;
			stem = freeStem(folder, stem, session.id);
			const mdPath = `${folder}/${stem}.md`;
			const rawPath = d.keepRaw ? `${folder}/${stem}.jsonl` : undefined;
			if (rawPath) await createNew(app, rawPath, text);
			await createNew(app, mdPath, renderDesktopTranscript(session, { source: file.path, rawFileName: rawPath ? `${stem}.jsonl` : undefined }));
			conf.index[session.id] = { updated: session.updated, size: file.size, mtime: file.mtime, source: file.path, md: mdPath, raw: rawPath, synced: new Date().toISOString() };
			await plugin.saveSettings();
			result.written.push(stem);
			if (isUpdate) result.changedCount++;
			else result.newCount++;
		}
	} catch (e) {
		result.stopped = e instanceof Error ? e.message : String(e);
	}

	await writeLog(plugin, result);
	return result;
}

async function writeLog(plugin: AIChatBridge, r: DesktopSyncResult): Promise<void> {
	// Quiet runs (nothing written, nothing wrong) leave no log line.
	if (!r.written.length && !r.restored.length && !r.stopped) return;
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const parts = [`Desktop apps: ${r.newCount} new`, `${r.changedCount} changed`, `${r.unchanged} unchanged`];
	if (r.active) parts.push(`${r.active} still active (next run)`);
	if (r.leftForLater) parts.push(`${r.leftForLater} left for next run`);
	if (r.restored.length) parts.push(`${r.restored.length} restored after deletion: ${r.restored.map((w) => `[[${w}]]`).join(', ')}`);
	let line = `- [[${dailyNoteName(now)}]] ${time} – ${parts.join(', ')}`;
	if (r.written.length) {
		const shown = r.written.slice(0, 20).map((w) => `[[${w}]]`).join(', ');
		line += `: ${shown}${r.written.length > 20 ? ` +${r.written.length - 20} more` : ''}`;
	}
	if (r.stopped) line += ` – **stopped:** ${r.stopped}`;
	try {
		await appendLog(plugin.app, plugin.settings.logPath, line, now);
	} catch (e) {
		console.error('AI ChatBridge: could not write log', e instanceof Error ? e.message : e);
	}
}
