// A memory capture as a note: properties, the list of places that were read, then one H2 per
// memory file with its text in a code block. The code block is what keeps the text untouched:
// a memory file's own headings and "---" lines cannot break the note, and Obsidian does not
// reformat what is inside. Pure code, no Obsidian.

import type { MemoryCapture, MemoryFile } from './types';

/** A fence longer than any run of backticks in the text, so the text cannot close it early. */
export function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return '`'.repeat(Math.max(3, longest + 1));
}

function fileSection(f: MemoryFile): string {
	if (f.text === undefined) return `## ${f.path}\n\n*${f.note ?? 'Not shown.'}*\n`;
	if (f.text === '') return `## ${f.path}\n\n*Empty file.*\n`;
	const fence = fenceFor(f.text);
	return `## ${f.path}\n\n${fence}${f.lang}\n${f.text}${f.text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

/** Everything below the properties. It holds no date, so the same memories give the same text. */
export function renderBody(c: MemoryCapture): string {
	const intro = [
		`Read from \`${c.home}\` on ${c.account}. Saved as the AI keeps it: nothing is filtered, translated or corrected.`,
		'',
		...c.places.map((p) => `- \`${p.name}\`: ${p.status}`),
	].join('\n');
	return `${[intro, ...c.files.map(fileSection)].join('\n\n').replace(/\n+$/, '')}\n`;
}

/** SHA-256 of the text, as hex. */
export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface NoteMeta {
	/** YYYY-MM-DD */
	synced: string;
	hash: string;
	/** For _latest.md: the dated snapshot it is a copy of (vault path without ".md"). */
	snapshot?: string;
}

export function renderNote(c: MemoryCapture, body: string, meta: NoteMeta): string {
	const props = [
		`provider: ${JSON.stringify(c.provider)}`,
		`account: ${JSON.stringify(c.account)}`,
		`source: ${c.source}`,
		`synced: ${meta.synced}`,
		`hash: ${meta.hash}`,
		`files: ${c.files.length}`,
	];
	if (meta.snapshot) props.push(`snapshot: ${JSON.stringify(`[[${meta.snapshot}|${meta.snapshot.split('/').pop() ?? ''}]]`)}`);
	props.push('unread: true');
	return `---\n${props.join('\n')}\n---\n\n${body}`;
}

/** The `hash:` property of a snapshot written earlier, or null. */
export function hashOfNote(md: string): string | null {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
	return (fm && /^hash: ([0-9a-f]{64})\s*$/m.exec(fm)?.[1]) ?? null;
}
