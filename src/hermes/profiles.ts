// Finds Hermes profiles on this computer: the Hermes home (HERMES_HOME, else the platform default)
// holds the default profile's state.db, and <home>/profiles/<name>/state.db each named profile.
// Reading folder names only; nothing is opened here.

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

/** Every profile folder with a state.db. Private folders and deleted profiles (".deleted") are skipped. */
export function discoverProfiles(): Found[] {
	const req = nodeRequire();
	if (!req) return [];
	const fs = req('fs') as { existsSync(p: string): boolean; readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] };
	const os = req('os') as { homedir(): string };
	const proc = req('process') as { env: Record<string, string | undefined>; platform: string };
	const out: Found[] = [];
	for (const root of hermesRoots(proc.env, os.homedir(), proc.platform)) {
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

/** Adds found profiles that are not in the list yet, turned off. Returns how many were added. */
export function addFoundProfiles(list: HermesProfile[], found: Found[]): number {
	let added = 0;
	for (const f of found) {
		const id = profileId(f.path);
		if (list.some((p) => p.id === id)) continue;
		list.push(newProfile(f.label, f.path));
		added++;
	}
	return added;
}

export function newProfile(label: string, path: string): HermesProfile {
	return { id: profileId(path), label, path: path.replace(/\\/g, '/').replace(/\/+$/, ''), enabled: false, index: {} };
}
