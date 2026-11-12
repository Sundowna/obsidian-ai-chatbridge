// Markdown transcript of a Hermes session. Pure code, no Obsidian.
// Same body as the desktop app transcripts (## You / ## Hermes), with each tool step in a collapsed callout;
// front matter dates are YYYY-MM-DD, with the times kept separately.

import { localDate, localDateTime } from '../naming';
import type { HermesSession, HermesToolStep } from './types';

/** Longest arguments and result kept per tool step (characters). Tool results can be tens of KB. */
export const ARGS_MAX = 600;
export const RESULT_MAX = 1200;

const PRIVATE = /(^|[\\/])private([\\/]|$)/i;

function cut(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return `${chars.slice(0, max).join('')}\n… (${(chars.length - max).toLocaleString('en')} more characters)`;
}

/** A fenced block inside a callout; the fence is longer than any run of ~ in the text. */
function fenced(text: string, lang = ''): string[] {
	const longest = Math.max(2, ...Array.from(text.matchAll(/~+/g), (m) => m[0].length));
	const fence = '~'.repeat(longest + 1);
	return [`${fence}${lang}`, ...text.split(/\r?\n/), fence];
}

/** Arguments as indented JSON when they are JSON, else as stored. */
function prettyArgs(args: string): string {
	try {
		return JSON.stringify(JSON.parse(args), null, 1);
	} catch {
		return args;
	}
}

/**
 * A tool result as readable text. Hermes often wraps output in JSON ({"content": "…"} for files,
 * {"output": "…"} for commands): that text is unwrapped so its line breaks show; other JSON is indented.
 */
export function prettyResult(result: string): string {
	const text = result.trim();
	if (!text.startsWith('{') && !text.startsWith('[')) return text;
	try {
		const v = JSON.parse(text) as unknown;
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const o = v as Record<string, unknown>;
			for (const key of ['content', 'output', 'result', 'text', 'stdout']) {
				const value = o[key];
				if (typeof value !== 'string') continue;
				const rest = Object.entries(o).filter(([k]) => k !== key);
				const extra = rest.length ? `\n\n${JSON.stringify(Object.fromEntries(rest))}` : '';
				return `${value}${extra}`.trim();
			}
		}
		return JSON.stringify(v, null, 1);
	} catch {
		return text;
	}
}

/**
 * A run of tool steps as a collapsed callout: each step's tool, arguments and (shortened) result.
 * Steps that mention a Private folder keep only the tool name.
 */
export function renderToolSteps(steps: HermesToolStep[]): string {
	const lines = [`[!example]- ${steps.length} tool step${steps.length === 1 ? '' : 's'}`];
	steps.forEach((st, i) => {
		lines.push(`**${i + 1}. ${st.name}**`);
		if (PRIVATE.test(st.args) || PRIVATE.test(st.result ?? '')) {
			lines.push('*(details not saved: they mention a Private folder)*');
			return;
		}
		const args = st.args.trim();
		if (args && args !== '{}') lines.push(...fenced(cut(prettyArgs(args), ARGS_MAX), 'json'));
		if (st.result === undefined) lines.push('*(no result recorded)*');
		else if (!st.result.trim()) lines.push('*(empty result)*');
		else lines.push('Result:', ...fenced(cut(prettyResult(st.result), RESULT_MAX)));
	});
	return lines.map((l) => (l ? `> ${l}` : '>')).join('\n');
}

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
		const parts = t.parts.map((p) => ('text' in p ? p.text : renderToolSteps(p.steps)));
		if (!parts.length) continue;
		const when = t.time ? ` · ${localDateTime(t.time)}` : '';
		body.push(`## ${t.role === 'user' ? 'You' : 'Hermes'}${when}`, '', parts.join('\n\n'), '');
	}
	return fm.join('\n') + body.join('\n');
}
