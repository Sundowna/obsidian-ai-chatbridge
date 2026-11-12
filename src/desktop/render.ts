// Markdown transcript and folder name for a desktop session. Pure code, no Obsidian.

import { localDateTime, safeTitle } from '../naming';
import { IMAGE_MARKER } from './claude-files';
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
	/** Saved files: file key -> vault path. */
	files?: Map<string, string>;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const fileLink = (path: string, name: string) => (IMAGE_EXT.test(path) ? `![[${path}]]` : `📎 [[${path}|${name}]]`);

/** Files and published artifacts not shown inside a message, listed at the end. */
function filesSection(s: DesktopSession, files: Map<string, string>): string[] {
	const out: string[] = [];
	const list = (kind: 'attachment' | 'artifact', heading: string) => {
		// Pasted images are shown in your message already.
		const lines = (s.files ?? []).filter((f) => f.kind === kind && !f.key.startsWith('image:')).flatMap((f) => {
			const p = files.get(f.key);
			return p ? [fileLink(p, f.name)] : [];
		});
		if (lines.length) out.push(`### ${heading}`, '', ...lines.map((l) => `- ${l}`), '');
	};
	list('attachment', 'Attachments');
	list('artifact', 'Artifacts');
	if (s.links?.length) {
		out.push('### On claude.ai', '', ...s.links.map((l) => `- [${l.title.replace(/[[\]]/g, '')}](${l.url})${l.kind === 'doc' ? ' (Claude Doc)' : ''}`), '');
	}
	return out.length ? ['## Files', '', ...out] : [];
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
		const files = meta.files ?? new Map<string, string>();
		const parts = t.parts.map((p) => ('text' in p ? p.text.replace(IMAGE_MARKER, (_m, key: string) => {
			const path = files.get(key);
			return path ? `![[${path}]]` : '*[image]*';
		}) : toolLine(p.tools)));
		if (!parts.length) continue;
		const when = t.time ? ` · ${localDateTime(t.time)}` : '';
		body.push(`## ${t.role === 'user' ? 'You' : name}${when}`, '', parts.join('\n\n'), '');
	}
	body.push(...filesSection(s, meta.files ?? new Map<string, string>()));
	return fm.join('\n') + body.join('\n');
}
