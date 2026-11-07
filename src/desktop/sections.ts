// Which sidebar section each desktop session belongs to, as the apps show it.
//  - Claude desktop, Code tab: your custom groups ("customGroupsByScope" in the app's
//    Local Storage). Sessions outside a group are listed by working folder.
//  - ChatGPT/Codex desktop: projects (~/.codex/.codex-global-state.json: "local-projects"
//    and "thread-project-assignments"). Threads outside a project are under Recents.
// Pure code, no Obsidian.

import { obj, str } from './turns';

export interface ClaudeDesktopMeta {
	/** The app's own ID ("local_…"), used by its sidebar groups. */
	localId: string;
	/** Claude Code session IDs (= transcript file names), current and earlier. */
	cliIds: string[];
	title?: string;
	/** Session this one was forked or started from; the sidebar nests it under that one. */
	parentLocalId?: string;
}

/** One Code-tab session file: <app data>/claude-code-sessions/<account>/<org>/local_<id>.json. */
export function parseClaudeMeta(text: string): ClaudeDesktopMeta | null {
	try {
		const o = obj(JSON.parse(text));
		const localId = str(o?.sessionId);
		const cli = str(o?.cliSessionId);
		if (!localId || !cli) return null;
		const prior = Array.isArray(o?.priorCliSessionIds) ? o.priorCliSessionIds.filter((x): x is string => typeof x === 'string') : [];
		const parentLocalId = str(o?.forkedFromSessionId) ?? str(obj(o?.spawnedFrom)?.sessionId);
		return { localId, cliIds: [cli, ...prior], title: str(o?.title)?.trim() || undefined, parentLocalId: parentLocalId !== localId ? parentLocalId : undefined };
	} catch {
		return null;
	}
}

/** Local session ID ("local_…") -> group name, from the stored "customGroupsByScope" value. */
export function claudeGroups(value: unknown): Map<string, string> {
	const out = new Map<string, string>();
	const scopes = obj(value);
	if (!scopes) return out;
	for (const scope of Object.values(scopes)) {
		const s = obj(scope);
		const names = new Map<string, string>();
		for (const g of Array.isArray(s?.groups) ? s.groups : []) {
			const id = str(obj(g)?.id);
			const name = str(obj(g)?.name)?.trim();
			if (id && name) names.set(id, name);
		}
		for (const [key, groupId] of Object.entries(obj(s?.assignments) ?? {})) {
			const name = typeof groupId === 'string' ? names.get(groupId) : undefined;
			const m = /^code:(.+)$/.exec(key);
			if (name && m) out.set(m[1]!, name);
		}
	}
	return out;
}

export interface ClaudePlacement {
	/** Sidebar group (own, or inherited from the session it was forked/started from). */
	group?: string;
	/** Title of the parent session, for nesting like the sidebar does. */
	parentTitle?: string;
}

/** Where the Code tab shows a session: its group (or its parent's) and the parent it is nested under. */
export function claudePlacement(localId: string, metas: Map<string, ClaudeDesktopMeta>, groups: Map<string, string>): ClaudePlacement {
	const parent = metas.get(localId)?.parentLocalId;
	let group = groups.get(localId);
	const seen = new Set([localId]);
	for (let id = parent; !group && id && !seen.has(id); id = metas.get(id)?.parentLocalId) {
		seen.add(id);
		group = groups.get(id);
	}
	return { group, parentTitle: parent ? metas.get(parent)?.title : undefined };
}

export interface CodexProjects {
	names: Map<string, string>;
	/** [normalized root folder, project name], longest first. */
	roots: [string, string][];
	/** thread ID -> project ID */
	assignments: Map<string, string>;
}

/** Comparable folder path: forward slashes, no "\\?\" prefix or trailing slash, lower case. */
export function normFolder(p: string): string {
	return p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function parseCodexState(text: string): CodexProjects {
	const out: CodexProjects = { names: new Map(), roots: [], assignments: new Map() };
	let o: Record<string, unknown> | undefined;
	try {
		o = obj(JSON.parse(text));
	} catch {
		return out;
	}
	for (const [id, p] of Object.entries(obj(o?.['local-projects']) ?? {})) {
		const name = str(obj(p)?.name)?.trim();
		if (!name) continue;
		out.names.set(id, name);
		const roots = obj(p)?.rootPaths;
		for (const r of Array.isArray(roots) ? roots : []) if (typeof r === 'string') out.roots.push([normFolder(r), name]);
	}
	out.roots.sort((a, b) => b[0].length - a[0].length);
	for (const [thread, a] of Object.entries(obj(o?.['thread-project-assignments']) ?? {})) {
		const id = str(obj(a)?.projectId);
		if (id) out.assignments.set(thread, id);
	}
	return out;
}

/** The Codex project a thread is filed under: its assignment, else the project whose folder it ran in. */
export function codexProjectFor(p: CodexProjects, threadId: string, cwd: string | undefined): string | undefined {
	const assigned = p.assignments.get(threadId);
	const name = assigned ? p.names.get(assigned) : undefined;
	if (name) return name;
	if (!cwd) return undefined;
	const c = normFolder(cwd);
	return p.roots.find(([root]) => c === root || c.startsWith(`${root}/`))?.[1];
}
