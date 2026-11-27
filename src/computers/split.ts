// One vault, several computers, one file syncing tool (Proton Drive, Syncthing, Obsidian Sync…).
// data.json travels with the vault, so two computers must never both rewrite it after every
// chat. It holds only what you set. What a computer synced (the indexes, cooldowns, the last
// runs) and its own folder paths (Claude Code extra folders, Hermes profiles) go to that
// computer's own file, computers/<name>.json, which no other computer writes.
//
// In memory nothing changes: the plugin works on one Settings object, as before. Only saving
// splits it, and loading joins it again. Pure functions, no Obsidian.

import type { Settings } from '../settings';

/** data.json carries this once it has been split; older data.json files hold everything. */
export const STORAGE_VERSION = 2;
export const COMPUTER_FILE_VERSION = 1;

/** Fields of one web account that a sync writes: they stay with the computer. */
export const WEB_LOCAL = {
	claude: ['index', 'fileIndex', 'cloudIndex', 'cooldownUntil', 'resumeAfter429', 'projectCatalog', 'archiveCleanup'],
	chatgpt: ['index', 'fileIndex', 'codexCloudIndex', 'cooldownUntil', 'resumeAfter429', 'assetRetries', 'pendingCaptures', 'inventories', 'chatProgress', 'projectCatalog', 'archiveCleanup'],
	lumo: ['index', 'fileIndex', 'cooldownUntil', 'resumeAfter429', 'projectCatalog'],
	gemini: ['index', 'cooldownUntil', 'resumeAfter429'],
} as const;
export const STUDIO_LOCAL = ['index', 'cooldownUntil', 'resumeAfter429'] as const;
/** A desktop app's sessions exist on one computer only, and so do its extra folders. */
export const DESKTOP_LOCAL = ['extraFolders', 'index', 'ignored', 'groupCache'] as const;

export type Provider = keyof typeof WEB_LOCAL;
export const PROVIDERS: Provider[] = ['claude', 'chatgpt', 'lumo', 'gemini'];

type Obj = Record<string, unknown>;

/** What one computer keeps for itself. */
export interface ComputerFile {
	v: typeof COMPUTER_FILE_VERSION;
	computer: string;
	savedAt: string;
	/** "<provider>:<account id>" -> that account's own fields, by surface. */
	accounts: Record<string, { web?: Obj; desktop?: Obj; studio?: Obj }>;
	/** Hermes profiles are folders on this computer. */
	hermes?: { profiles: unknown[]; pythonPath?: string };
	/** AI memory: the last snapshot per "<provider>/<account>". */
	memoryStates?: Record<string, unknown>;
	lastRuns?: Record<string, unknown>;
	lastAll?: unknown;
}

export const accountKey = (provider: Provider, id: string): string => `${provider}:${id}`;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `o` without `keys`, and the removed part (only keys that were there). */
function cut(o: Obj, keys: readonly string[]): { rest: Obj; taken: Obj } {
	const rest: Obj = { ...o };
	const taken: Obj = {};
	for (const k of keys) {
		if (k in rest) {
			if (rest[k] !== undefined) taken[k] = rest[k];
			delete rest[k];
		}
	}
	return { rest, taken };
}

const notEmpty = (o: Obj): Obj | undefined => (Object.keys(o).length ? o : undefined);

/**
 * Settings -> what goes to data.json and what goes to this computer's file. Shallow copies:
 * the big indexes are shared by reference, never copied, since this runs after every chat.
 */
export function splitSettings(s: Settings, computer: string, now = new Date()): { shared: Obj; local: ComputerFile } {
	const accounts: ComputerFile['accounts'] = {};
	const shared: Obj = { ...(s as unknown as Obj), storage: STORAGE_VERSION };
	for (const provider of PROVIDERS) {
		shared[provider] = (s[provider] as unknown as Obj[]).map((account) => {
			const out: Obj = { ...account };
			const own: { web?: Obj; desktop?: Obj; studio?: Obj } = {};
			if (isObj(account.web)) {
				const { rest, taken } = cut(account.web, WEB_LOCAL[provider]);
				out.web = rest;
				own.web = notEmpty(taken);
			}
			if (isObj(account.desktop)) {
				const { rest, taken } = cut(account.desktop, DESKTOP_LOCAL);
				out.desktop = rest;
				own.desktop = notEmpty(taken);
			}
			if (isObj(account.studio)) {
				const { rest, taken } = cut(account.studio, STUDIO_LOCAL);
				out.studio = rest;
				own.studio = notEmpty(taken);
			}
			if (own.web || own.desktop || own.studio) accounts[accountKey(provider, String(account.id))] = own;
			return out;
		});
	}
	const { profiles, pythonPath, ...hermes } = s.hermes;
	shared.hermes = hermes;
	const { states, ...memory } = s.memory;
	shared.memory = memory;
	delete shared.lastRuns;
	delete shared.lastAll;
	const local: ComputerFile = {
		v: COMPUTER_FILE_VERSION,
		computer,
		savedAt: now.toISOString(),
		accounts,
		hermes: { profiles, pythonPath },
		memoryStates: states,
		lastRuns: s.lastRuns,
	};
	if (s.lastAll) local.lastAll = s.lastAll;
	return { shared, local };
}

/** data.json plus this computer's file -> one settings object, ready for normalizeSettings. */
export function joinSaved(shared: unknown, local: ComputerFile | null): unknown {
	if (!isObj(shared)) return shared;
	const out: Obj = { ...shared };
	delete out.storage;
	for (const provider of PROVIDERS) {
		const list = out[provider];
		if (!Array.isArray(list)) continue;
		out[provider] = list.map((account: unknown) => {
			if (!isObj(account)) return account;
			const own = local?.accounts[accountKey(provider, String(account.id))];
			const joined: Obj = { ...account };
			// Never take these from data.json, even if an older build left them there.
			for (const [surface, keys] of [['web', WEB_LOCAL[provider]], ['desktop', DESKTOP_LOCAL], ['studio', STUDIO_LOCAL]] as const) {
				const part = account[surface];
				if (!isObj(part)) continue;
				joined[surface] = { ...cut(part, keys).rest, ...(own?.[surface] ?? {}) };
			}
			return joined;
		});
	}
	const hermes = isObj(out.hermes) ? out.hermes : {};
	out.hermes = { ...hermes, profiles: local?.hermes?.profiles ?? [], ...(local?.hermes?.pythonPath !== undefined ? { pythonPath: local.hermes.pythonPath } : {}) };
	const memory = isObj(out.memory) ? out.memory : {};
	out.memory = { ...memory, states: local?.memoryStates ?? {} };
	out.lastRuns = local?.lastRuns ?? {};
	out.lastAll = local?.lastAll;
	return out;
}

/** data.json from before the split: it still holds every index. */
export const isUnsplit = (shared: unknown): boolean => isObj(shared) && shared.storage !== STORAGE_VERSION;

/** A computer file as read from disk, or null when it is not one (half written, foreign). */
export function parseComputerFile(text: string): ComputerFile | null {
	let o: unknown;
	try {
		o = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObj(o) || o.v !== COMPUTER_FILE_VERSION || typeof o.computer !== 'string' || !isObj(o.accounts)) return null;
	return o as unknown as ComputerFile;
}

/** The part of a computer file that only makes sense on that computer: its desktop apps and Hermes. */
export function machinePart(f: ComputerFile): ComputerFile {
	const accounts: ComputerFile['accounts'] = {};
	for (const [key, own] of Object.entries(f.accounts)) if (own.desktop) accounts[key] = { desktop: own.desktop };
	return { v: COMPUTER_FILE_VERSION, computer: f.computer, savedAt: f.savedAt, accounts, hermes: f.hermes };
}

/** `f` without its desktop apps and Hermes (they belong to another computer). */
export function withoutMachinePart(f: ComputerFile): ComputerFile {
	const accounts: ComputerFile['accounts'] = {};
	for (const [key, own] of Object.entries(f.accounts)) {
		const rest = { ...own };
		delete rest.desktop;
		if (rest.web || rest.studio) accounts[key] = rest;
	}
	return { ...f, accounts, hermes: undefined };
}

/** The folder paths a computer file points to on its computer, to tell whether it is this one. */
export function machinePaths(f: ComputerFile): string[] {
	const paths: string[] = [];
	for (const own of Object.values(f.accounts)) {
		const d = own.desktop;
		if (!d) continue;
		if (Array.isArray(d.extraFolders)) for (const p of d.extraFolders) if (typeof p === 'string') paths.push(p);
		if (isObj(d.index)) {
			let n = 0;
			for (const e of Object.values(d.index)) {
				if (isObj(e) && typeof e.source === 'string') paths.push(e.source);
				if (++n >= 20) break;
			}
		}
	}
	for (const p of f.hermes?.profiles ?? []) if (isObj(p) && typeof p.path === 'string') paths.push(p.path);
	return paths;
}

/** Whether a computer file has anything that belongs to one computer only. */
export const hasMachinePart = (f: ComputerFile): boolean => machinePaths(f).length > 0 || Object.values(f.accounts).some((a) => a.desktop);
