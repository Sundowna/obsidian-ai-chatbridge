// Finds Hermes profiles on this computer: the Hermes home (HERMES_HOME, else the platform default)
// holds the default profile's state.db, and <home>/profiles/<name>/state.db each named profile.
// Reading folder names only; nothing is opened here. Profiles whose state.db is gone stay in
// the list (you may still want their notes, or the folder may come back) until you remove them.

import { nodeRequire, isPrivatePath } from './reader';
import type { HermesProfile } from './types';

export const profileId = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

interface Found {
	label: string;
	path: string;
}

/** Hermes homes to look in: HERMES_HOME (or the root above it, if it is a profile), then the defaults. */
export function hermesRoots(env: Record<string, string | undefined>, home: string, platform: string): string[] {
	const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
	const out: string[] = [];
	const set = env.HERMES_HOME?.trim();
	if (set) {
		const p = norm(set);
		const m = /^(.*)\/profiles\/[^/]+$/i.exec(p);
		out.push(m?.[1] ?? p);
	}
	if (platform === 'win32' && env.LOCALAPPDATA) out.push(`${norm(env.LOCALAPPDATA)}/hermes`);
	out.push(`${norm(home)}/.hermes`);
	return [...new Set(out)];
}

/** The bits of Node's fs that finding profiles needs, so tests can pass a fake folder tree. */
export interface ProfileFs {
	existsSync(p: string): boolean;
	readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}

/** Every profile folder with a state.db under these Hermes homes. Private folders and deleted profiles (".deleted") are skipped. */
export function findProfiles(roots: string[], fs: ProfileFs): Found[] {
	const out: Found[] = [];
	for (const root of roots) {
		if (isPrivatePath(root)) continue;
		if (fs.existsSync(`${root}/state.db`)) out.push({ label: 'default', path: root });
		let dirs: { name: string; isDirectory(): boolean }[] = [];
		try {
			dirs = fs.readdirSync(`${root}/profiles`, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirs) {
			if (!d.isDirectory() || d.name.startsWith('.') || d.name.toLowerCase() === 'private') continue;
			const path = `${root}/profiles/${d.name}`;
			if (fs.existsSync(`${path}/state.db`)) out.push({ label: d.name, path });
		}
	}
	const seen = new Set<string>();
	return out.filter((f) => !seen.has(profileId(f.path)) && !!seen.add(profileId(f.path)));
}

/** Node's fs on desktop (and in the tests); null on mobile. */
export function nodeFs(): ProfileFs | null {
	const req = nodeRequire();
	return req ? (req('fs') as ProfileFs) : null;
}

/** Every profile on this computer: HERMES_HOME (or its root), then the platform defaults. */
export function discoverProfiles(): Found[] {
	const req = nodeRequire();
	const fs = nodeFs();
	if (!req || !fs) return [];
	const os = req('os') as { homedir(): string };
	const proc = req('process') as { env: Record<string, string | undefined>; platform: string };
	return findProfiles(hermesRoots(proc.env, os.homedir(), proc.platform), fs);
}

/** Why a saved profile can't be read any more, or null when its state.db is there. */
export type ProfileGone = 'folder' | 'database';

export function profileGone(profile: HermesProfile, fs: Pick<ProfileFs, 'existsSync'> | null = nodeFs()): ProfileGone | null {
	// No fs (mobile): nothing can be read anyway, and the tab says so; don't call profiles gone.
	if (!fs) return null;
	if (fs.existsSync(`${profile.path}/state.db`)) return null;
	return fs.existsSync(profile.path) ? 'database' : 'folder';
}

export interface RefreshResult {
	/** Profiles added by this refresh (turned off, like at start-up). */
	added: HermesProfile[];
	/** Profiles in the list whose state.db is gone. They stay in the list; nothing is removed. */
	missing: HermesProfile[];
	/** Profiles that were in the list and are found again. */
	present: number;
}

/**
 * Looks again: adds new profiles (turned off) and sorts the saved ones into found and gone.
 * Profiles added by path count too: only whether their state.db exists matters.
 */
export function refreshProfiles(list: HermesProfile[], found: Found[], fs: Pick<ProfileFs, 'existsSync'> | null): RefreshResult {
	const before = list.length;
	addFoundProfiles(list, found);
	const added = list.slice(before);
	const missing = list.slice(0, before).filter((p) => profileGone(p, fs));
	return { added, missing, present: before - missing.length };
}

/** "2 new profiles found, 1 no longer exists" – or that nothing changed. */
export function refreshSummary(r: RefreshResult): string {
	const parts: string[] = [];
	if (r.added.length) parts.push(`${r.added.length} new profile${r.added.length === 1 ? '' : 's'} found`);
	if (r.missing.length) parts.push(`${r.missing.length} no longer exist${r.missing.length === 1 ? 's' : ''}`);
	if (parts.length) return parts.join(', ');
	const n = r.present + r.added.length;
	return n ? `No changes: ${n === 1 ? 'the profile is' : `all ${n} profiles are`} still there` : 'No Hermes profiles found';
}

/**
 * Takes a profile off the list. Its notes in the vault stay where they are; only the plugin's
 * memory of what it synced goes, so adding the profile again would save its chats once more.
 */
export function removeProfile(list: HermesProfile[], profile: HermesProfile): boolean {
	const i = list.indexOf(profile);
	if (i < 0) return false;
	list.splice(i, 1);
	return true;
}

/**
 * A label no other profile has yet: "default", then "default (2)" … The label is also the
 * vault subfolder, so two profiles with the same label would share one folder.
 */
export function uniqueLabel(list: HermesProfile[], label: string, except?: HermesProfile): string {
	const taken = (l: string) => list.some((p) => p !== except && p.label.toLowerCase() === l.toLowerCase());
	if (!taken(label)) return label;
	for (let i = 2; ; i++) if (!taken(`${label} (${i})`)) return `${label} (${i})`;
}

/** Labels made unique, keeping the first of each; returns how many changed. */
export function dedupeLabels(list: HermesProfile[]): number {
	let changed = 0;
	list.forEach((p, i) => {
		const label = uniqueLabel(list.slice(0, i), p.label);
		if (label !== p.label) {
			p.label = label;
			changed++;
		}
	});
	return changed;
}

/** Adds found profiles that are not in the list yet, turned off. Returns how many were added. */
export function addFoundProfiles(list: HermesProfile[], found: Found[]): number {
	let added = 0;
	for (const f of found) {
		const id = profileId(f.path);
		if (list.some((p) => p.id === id)) continue;
		list.push(newProfile(uniqueLabel(list, f.label), f.path));
		added++;
	}
	return added;
}

export function newProfile(label: string, path: string): HermesProfile {
	return { id: profileId(path), label, path: path.replace(/\\/g, '/').replace(/\/+$/, ''), enabled: false, index: {} };
}
