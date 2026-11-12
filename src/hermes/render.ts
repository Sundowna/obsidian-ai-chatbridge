// Markdown transcript of a Hermes session. Pure code, no Obsidian.
// Same body as the desktop app transcripts (## You / ## Hermes, tool steps counted);
// front matter dates are YYYY-MM-DD, with the times kept separately.

import { localDate, localDateTime } from '../naming';
import type { HermesSession } from './types';

const y = (s: string) => JSON.stringify(s);

export function renderHermesTranscript(s: HermesSession, dbPath: string): string {
	const fm = [
		'---',
		'source: hermes',
		`hermes_profile: ${y(s.profile)}`,
		`session_id: ${y(s.id)}`,
		`title: ${y(s.title)}`,
		`created: ${localDate(s.created)}`,
		`updated: ${localDate(s.updated)}`,
		`created_time: ${y(localDateTime(s.created))}`,
		`updated_time: ${y(localDateTime(s.updated))}`,
	];
	if (s.model) fm.push(`model: ${y(s.model)}`);
	if (s.provider) fm.push(`provider: ${y(s.provider)}`);
	fm.push(`hermes_source: ${y(s.source)}`);
	if (s.cwd) fm.push(`cwd: ${y(s.cwd.replace(/\\/g, '/'))}`);
	if (s.parentId) fm.push(`parent_session: ${y(s.parentId)}`);
	if (s.isSubagent) fm.push('subagent: true');
	fm.push(`source_file: ${y(dbPath.replace(/\\/g, '/'))}`, 'unread: true', '---', '');

	const body: string[] = [];
	for (const t of s.turns) {
		const parts = t.parts.map((p) => ('text' in p ? p.text : `*(${p.tools} tool step${p.tools === 1 ? '' : 's'})*`));
		if (!parts.length) continue;
		const when = t.time ? ` · ${localDateTime(t.time)}` : '';
		body.push(`## ${t.role === 'user' ? 'You' : 'Hermes'}${when}`, '', parts.join('\n\n'), '');
	}
	return fm.join('\n') + body.join('\n');
}
