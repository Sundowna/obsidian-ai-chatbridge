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
import { claudeDesktopMetaFiles, claudeLocalStorageFiles, codexHomes, listSessionFiles, nodeDesktopFs, sameOrUnder, type DesktopFs, type SourceFile } from './scan';
import { claudeGroups, claudePlacement, codexProjectFor, parseClaudeMeta, parseCodexState, type ClaudeDesktopMeta, type CodexProjects } from './sections';
import { APP_LABEL, type DesktopApp, type DesktopIndexEntry, type DesktopSession } from './types';
import type { AnyAccount } from '../accounts';
import type { Provider } from '../login';
import type { ChatgptAccount, ClaudeAccount, Settings } from '../settings';

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
	/** Session ID -> the claude.ai organization whose folder its Code-tab file sits in. */
	orgByCli: Map<string, string>;
	groups: Map<string, string>;
}

const PROVIDER: Record<DesktopApp, Provider> = { claude: 'claude', codex: 'chatgpt' };
const accountsFor = (s: Settings, app: DesktopApp): AnyAccount[] => s[PROVIDER[app]];
const ownerIdOf = (app: DesktopApp, a: AnyAccount): string | undefined =>
	app === 'claude' ? (a as ClaudeAccount).web.orgId : (a as ChatgptAccount).web.workspaceId;

export function anyDesktopEnabled(plugin: AIChatBridge): boolean {
	const s = plugin.settings;
	return [...s.claude, ...s.chatgpt].some((a) => a.desktop.enabled);
}

/**
 * Which account a session belongs to: the account whose own folder holds it, else the one
 * whose login made it, else the first account. Each session has exactly one owner, so two
 * accounts can read the same app folder without saving anything twice.
 *
 * Null = wait: the session is clearly not the first account's, and an added account has not
 * logged in yet. Saving it now would file it under the wrong account for good.
 */
export function desktopOwner(accounts: AnyAccount[], app: DesktopApp, path: string, ownerId: string | undefined): AnyAccount | null {
	const byFolder = accounts.find((a) => a.desktop.extraFolders.some((f) => sameOrUnder(path, f)));
	if (byFolder) return byFolder;
	const byLogin = ownerId ? accounts.find((a) => ownerIdOf(app, a) === ownerId) : undefined;
	if (byLogin) return byLogin;
	const [first, ...rest] = accounts as [AnyAccount, ...AnyAccount[]];
	const unidentified = rest.some((a) => !ownerIdOf(app, a) && !a.desktop.extraFolders.length);
	return ownerId && ownerIdOf(app, first) && unidentified ? null : first;
}

/** Limits a run to one account (its Sync button in the settings). */
export interface DesktopOnly {
	provider: Provider;
	id: string;
}

interface Todo {
	file: SourceFile;
	session: DesktopSession;
	text: string;
	isUpdate: boolean;
	owner: AnyAccount;
}

export async function runDesktopSync(
	plugin: AIChatBridge,
	progress: ProgressFn = () => undefined,
	fs: DesktopFs | null = nodeDesktopFs(),
	now = Date.now(),
	only?: DesktopOnly,
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
			const orgByCli = new Map<string, string>();
			for (const p of await claudeDesktopMetaFiles(fs)) {
				const m = parseClaudeMeta((await fs.readText(p)) ?? '');
				if (!m) continue;
				metas.set(m.localId, m);
				// .../claude-code-sessions/<account>/<organization>/local_<id>.json
				const org = p.split('/').slice(-2, -1)[0];
				for (const id of m.cliIds) {
					if (!byCli.has(id)) byCli.set(id, m);
					if (org && !orgByCli.has(id)) orgByCli.set(id, org);
				}
			}
			const conf = s.claude[0]!.desktop;
			let groups = claudeGroups(findLatestJson(await claudeLocalStorageFiles(fs), 'customGroupsByScope'));
			// The app may be mid-write: then use the groups seen last time.
			if (groups.size) conf.groupCache = Object.fromEntries(groups);
			else groups = new Map(Object.entries(conf.groupCache ?? {}));
			return { metas, byCli, orgByCli, groups };
		};
		/** Thread titles and projects from every Codex home in use (each login can have its own). */
		const loadCodex = async (extraFolders: string[]): Promise<{ titles: Map<string, string>; projects: CodexProjects }> => {
			const titles = new Map<string, string>();
			const projects: CodexProjects = { names: new Map(), roots: [], assignments: new Map() };
			for (const home of codexHomes(fs, extraFolders)) {
				for (const [id, name] of codexTitles((await fs.readText(`${home}/session_index.jsonl`)) ?? '')) titles.set(id, name);
				const one = parseCodexState((await fs.readText(`${home}/.codex-global-state.json`)) ?? '');
				for (const [id, name] of one.names) projects.names.set(id, name);
				for (const [id, project] of one.assignments) projects.assignments.set(id, project);
				projects.roots.push(...one.roots);
			}
			projects.roots.sort((a, b) => b[0].length - a[0].length);
			return { titles, projects };
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
			const accounts = accountsFor(s, which);
			const wanted = (a: AnyAccount) => a.desktop.enabled && (!only || (only.provider === PROVIDER[which] && only.id === a.id));
			if (!accounts.some(wanted)) continue;
			for (const a of accounts.filter(wanted)) {
				if (!cleanFolder(a.desktop.folder)) throw new Error(`The ${APP_LABEL[which]} folder setting of "${a.label}" is empty or invalid.`);
			}
			progress(`${APP_LABEL[which]}: looking for sessions…`);
			const extraFolders = accounts.filter((a) => a.desktop.enabled).flatMap((a) => a.desktop.extraFolders);
			const files = await listSessionFiles(fs, which, extraFolders);
			result.listed += files.length;
			// Skipped files are skipped for every account, so one list is enough.
			const ignored = (accounts[0]!.desktop.ignored ??= {});
			const bySource = new Map<string, DesktopIndexEntry>();
			for (const a of accounts) for (const e of Object.values(a.desktop.index)) bySource.set(e.source.toLowerCase(), e);

			for (const file of files) {
				if (now - file.mtime < quietMs) {
					result.active++;
					continue;
				}
				const key = file.path.toLowerCase();
				if (ignored[key] === file.mtime) {
					result.empty++;
					continue;
				}
				const known = bySource.get(key);
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
					if (session) session.ownerId = claude.orgByCli.get(session.id);
				} else {
					if (!codexTitleMap || !codexProjects) {
						const codex = await loadCodex(extraFolders);
						codexTitleMap = codex.titles;
						codexProjects = codex.projects;
					}
					session = parseCodexSession(text, codexTitleMap);
				}
				if (session) session.section = sectionOf(session);
				if (!session || (session.isSubagent && !d.includeSubagents)) {
					ignored[key] = file.mtime;
					result.empty++;
					continue;
				}
				delete ignored[key];

				// A session already saved stays with its account, so nothing is ever saved twice.
				const sessionId = session.id;
				const owner = accounts.find((a) => a.desktop.index[sessionId]) ?? desktopOwner(accounts, which, file.path, session.ownerId);
				if (!owner || !wanted(owner)) continue;
				const conf = owner.desktop;
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
				todo.push({ file, session, text, isUpdate: !!entry, owner });
			}
			await plugin.saveSettings();
		}

		// Oldest first, so a limited run keeps the vault's order sensible.
		todo.sort((a, b) => a.session.updated.localeCompare(b.session.updated));
		const limit = s.maxChatsPerRun > 0 ? s.maxChatsPerRun : todo.length;
		result.leftForLater = Math.max(0, todo.length - limit);

		for (const [i, { file, session, text, isUpdate, owner }] of todo.slice(0, limit).entries()) {
			progress(`${i + 1} of ${Math.min(limit, todo.length)} sessions: ${session.title}`, i, Math.min(limit, todo.length));
			const conf = owner.desktop;
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
