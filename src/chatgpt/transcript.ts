// Turns a ChatGPT chat's JSON into a plain Markdown transcript. Pure code, no AI.
// One section per turn: your message, then everything ChatGPT did until your next
// message (tool steps collapsed to one line, generated images embedded).

import { localDateTime } from '../naming';
import { imageParts, pointerId } from './files';
import type { GptChat, GptMessage } from './types';

export const isoFromUnix = (s: number): string => new Date(s * 1000).toISOString();

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function y(s: string): string {
	return JSON.stringify(s);
}

type Piece = { kind: 'text'; md: string } | { kind: 'tool' };

/**
 * ChatGPT marks names, links, sources and image galleries in its text as
 * U+E200 type U+E202 arg U+E202 arg … U+E201 (seen 2026-11-06). Names and links are
 * kept as plain text, sources (internal numbers only) and image searches are dropped.
 */
export function cleanMarkers(text: string): string {
	return text.replace(/([^]*)((?:[^]*)*)/g, (_m, kind: string, rest: string) => {
		const args = rest.split('').slice(1);
		if (kind === 'entity') {
			try {
				const v = JSON.parse(args[0] ?? '') as unknown;
				if (Array.isArray(v) && typeof v[1] === 'string') return v[1];
			} catch {
				/* fall through */
			}
			return '';
		}
		if (kind === 'url' && args.length >= 2 && /^https?:\/\//.test(args[1] ?? '')) return `[${args[0]}](${args[1]})`;
		return ''; // cite, image_group and anything unknown
	});
}

/**
 * ChatGPT's newer answers mix layout code (<box>, <AsyncImage>, …) into the text and add
 * a clean Markdown version in metadata.model_dil_v2.fallbackMarkdown. Use that when present.
 */
function fallbackMarkdown(m: GptMessage): string | null {
	const dil = m.metadata?.model_dil_v2;
	const fb = typeof dil === 'object' && dil !== null ? (dil as { fallbackMarkdown?: unknown }).fallbackMarkdown : undefined;
	return typeof fb === 'string' && fb.trim() ? fb : null;
}

/** What one message adds to the transcript. */
function pieces(m: GptMessage, filePaths: Map<string, string>): Piece[] {
	const out: Piece[] = [];
	const c = m.content;
	const role = m.author.role;
	// A message to a tool (e.g. the image generator's settings) is a tool step.
	if (role === 'assistant' && m.recipient && m.recipient !== 'all') return [{ kind: 'tool' }];
	switch (c.content_type) {
		case 'text':
		case 'multimodal_text': {
			const clean = fallbackMarkdown(m);
			if (clean) {
				const t = cleanMarkers(clean).trim();
				if (t) out.push({ kind: 'text', md: t });
			}
			for (const p of c.parts ?? []) {
				if (typeof p === 'string') {
					if (clean) continue; // the clean version above replaces the text parts
					const t = cleanMarkers(p).trim();
					if (t) out.push({ kind: 'text', md: t });
					continue;
				}
				if (p.content_type === 'image_asset_pointer') {
					const id = pointerId(p.asset_pointer);
					const path = id ? filePaths.get(id) : undefined;
					out.push({ kind: 'text', md: path ? `![[${path}]]` : '*[image – not downloaded]*' });
				} else if (typeof p.content_type === 'string') {
					out.push({ kind: 'text', md: `*[${p.content_type} – see raw JSON]*` });
				}
			}
			// Uploaded files that are not images: link them.
			const shown = new Set(imageParts(m).map((p) => pointerId(p.asset_pointer)));
			for (const a of m.metadata?.attachments ?? []) {
				if (!a.id || shown.has(a.id)) continue;
				const path = filePaths.get(a.id);
				if (path) out.push({ kind: 'text', md: IMAGE_EXT.test(path) ? `![[${path}]]` : `📎 [[${path}|${a.name ?? 'file'}]]` });
				else if (a.name) out.push({ kind: 'text', md: `*Attachment: ${a.name}*` });
			}
			// Text a tool sent back (search results etc.) is machine output: one tool line.
			// (Images a tool made – e.g. generated pictures – are always shown.)
			if (role === 'tool' && imageParts(m).length === 0) return [{ kind: 'tool' }];
			return out;
		}
		// ChatGPT's private reasoning: kept in the raw JSON, left out here.
		case 'thoughts':
		case 'reasoning_recap':
		case 'model_editable_context':
			return [];
		case 'code':
		case 'execution_output':
		case 'tether_browsing_display':
		case 'tether_quote':
		case 'system_error':
			return [{ kind: 'tool' }];
		default:
			return [{ kind: 'text', md: `*[${c.content_type} – see raw JSON]*` }];
	}
}

export interface GptTranscriptMeta {
	projectName?: string;
	jsonFileName: string;
	filePaths?: Map<string, string>;
}

export function renderGptTranscript(chat: GptChat, meta: GptTranscriptMeta): string {
	const fm = [
		'---',
		`uuid: ${chat.conversation_id}`,
		`url: https://chatgpt.com/c/${chat.conversation_id}`,
		`created: ${isoFromUnix(chat.create_time)}`,
		`updated: ${isoFromUnix(chat.update_time)}`,
	];
	if (meta.projectName) fm.push(`project: ${y(meta.projectName)}`);
	fm.push(`raw: ${y(`[[${meta.jsonFileName}]]`)}`, 'unread: true', '---', '');

	const filePaths = meta.filePaths ?? new Map<string, string>();
	const body: string[] = [];
	let speaker: 'You' | 'ChatGPT' | null = null;
	let when = '';
	let lines: string[] = [];
	let tools = 0;
	const flushTools = () => {
		if (tools) lines.push(`*(${tools} tool step${tools === 1 ? '' : 's'})*`);
		tools = 0;
	};
	const flush = () => {
		flushTools();
		if (speaker) body.push(`## ${speaker}${when}`, '', lines.join('\n\n') || '*(no text)*', '');
		lines = [];
	};

	// A finished answer ends its section, so answers that follow each other without a
	// message from you in between (e.g. scheduled tasks, seen 2026-11-06) each get their own heading.
	let answerFinished = false;
	for (const m of chat.messages) {
		if (m.author.role === 'system' || m.metadata?.is_visually_hidden_from_conversation) continue;
		const who = m.author.role === 'user' ? 'You' : 'ChatGPT';
		if (who !== speaker || who === 'You' || answerFinished) {
			flush();
			speaker = who;
			when = typeof m.create_time === 'number' ? ` · ${localDateTime(isoFromUnix(m.create_time))}` : '';
		}
		answerFinished = who === 'ChatGPT' && m.channel === 'final';
		for (const p of pieces(m, filePaths)) {
			if (p.kind === 'tool') tools++;
			else {
				flushTools();
				lines.push(p.md);
			}
		}
	}
	flush();
	return fm.join('\n') + body.join('\n');
}
