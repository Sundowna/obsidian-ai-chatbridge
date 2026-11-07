// Markdown transcript and folder name for a desktop session. Pure code, no Obsidian.

import { localDateTime, safeTitle } from '../naming';
import { APP_LABEL, ASSISTANT_NAME, type DesktopSession } from './types';

/** YAML-safe string (JSON strings are valid YAML double-quoted strings). */
const y = (s: string) => JSON.stringify(s);

/** Subfolder for a session: the name of the folder it ran in. */
export function sessionFolderName(cwd: string | undefined, fallback: string): string {
	if (!cwd) return fallback;
	const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
	// Sessions started without a project folder run in a scratch workspace the app made:
	// Claude desktop ".../scratch-workspaces/<account>/<org>/scratch-<date>", Codex "Documents/Codex/<date>/<slug>".
	if (/\/scratch[-_/]?workspaces?\//i.test(norm) || /\/scratch$/i.test(norm) || /\/Codex\/\d{4}-\d{2}-\d{2}\/[^/]+$/i.test(norm)) return 'Scratch';
	const name = norm.split('/').pop() ?? '';
	return name && !/^[a-z]:$/i.test(name) ? safeTitle(name) : fallback;
}

function toolLine(n: number): string {
	return `*(${n} tool step${n === 1 ? '' : 's'})*`;
}

export interface DesktopRenderMeta {
	/** Source file on this computer. */
	source: string;
	/** Vault name of the raw copy, if kept. */
	rawFileName?: string;
}

export function renderDesktopTranscript(s: DesktopSession, meta: DesktopRenderMeta): string {
	const fm = ['---', `app: ${y(APP_LABEL[s.app])}`, `session: ${s.id}`, `title: ${y(s.title)}`, `created: ${s.created}`, `updated: ${s.updated}`];
	if (s.section) fm.push(`section: ${y(s.section)}`);
	if (s.cwd) fm.push(`cwd: ${y(s.cwd)}`);
	if (s.model) fm.push(`model: ${y(s.model)}`);
	if (s.forkedFrom) fm.push(`forked_from: ${s.forkedFrom}`);
	if (s.isSubagent) fm.push('subagent: true');
	fm.push(`source: ${y(meta.source.replace(/\\/g, '/'))}`);
	if (meta.rawFileName) fm.push(`raw: ${y(`[[${meta.rawFileName}]]`)}`);
	fm.push('unread: true', '---', '');

	const body: string[] = [];
	const name = ASSISTANT_NAME[s.app];
	for (const t of s.turns) {
		const parts = t.parts.map((p) => ('text' in p ? p.text : toolLine(p.tools)));
		if (!parts.length) continue;
		const when = t.time ? ` · ${localDateTime(t.time)}` : '';
		body.push(`## ${t.role === 'user' ? 'You' : name}${when}`, '', parts.join('\n\n'), '');
	}
	return fm.join('\n') + body.join('\n');
}
