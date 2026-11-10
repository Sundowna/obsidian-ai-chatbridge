// Turns a ChatGPT chat's JSON into a plain Markdown transcript. Pure code, no AI.
// One section per turn: your message, then everything ChatGPT did until your next
// message (tool steps collapsed to one line, generated images embedded).

import { localDateTime } from '../naming';
import { fallbackMarkdown, imageParts, pointerId, sandboxKey, sandboxLinks } from './files';
import type { GptChat, GptMessage, GptPart } from './types';
import { hasVideo, isAudioPointer, isTranscription, NO_TRANSCRIPTION, pointerTranscription, transcriptionText } from './voice';

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
function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function cleanMarkers(text: string, references?: unknown): string {
	const citations = new Map<string, string>();
	if (Array.isArray(references)) {
		for (const value of references as unknown[]) {
			const ref = asRecord(value);
			if (typeof ref.matched_text !== 'string' || !ref.matched_text.includes('\uE200')) continue;
			const candidates = [ref.url];
			for (const field of [ref.items, ref.sources, ref.fallback_items]) {
				if (Array.isArray(field)) for (const item of field as unknown[]) candidates.push(asRecord(item).url);
			}
			if (typeof ref.alt === 'string') {
				for (const match of ref.alt.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) candidates.push(match[1]);
			}
			const urls = [...new Set(candidates.filter((url): url is string =>
				typeof url === 'string' && /^https?:\/\/[^<>\s]+$/i.test(url)))];
			if (urls.length) citations.set(ref.matched_text, urls.map((url, i) => '[Source' + (urls.length > 1 ? ' ' + (i + 1) : '') + '](<' + url + '>)').join(', '));
		}
	}
	return text.replace(/([^]*)((?:[^]*)*)/g, (marker, kind: string, rest: string) => {
		const citation = citations.get(marker);
		if (citation) return citation;
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
		if (kind === 'cite' && references !== undefined) return '[Unresolved source]';
		return '';
	});
}

/**
 * ChatGPT's newer answers mix layout code (<box>, <AsyncImage>, …) into the text and add
 * a clean Markdown version in metadata.model_dil_v2.fallbackMarkdown. Use that when present.
 */
/** What one message adds to the transcript. */
function pieces(m: GptMessage, chatId: string, filePaths: Map<string, string>): Piece[] {
	const out: Piece[] = [];
	const c = m.content;
	const role = m.author.role;
	const renderText = (value: string): string => {
		const clean = cleanMarkers(value, m.metadata?.content_references ?? []).trim();
		if (role !== 'assistant') return clean;
		return sandboxLinks(clean, (label, path) => {
			const local = filePaths.get(sandboxKey(chatId, m.id, path));
			const name = label.replace(/[[|\]]/g, '') || 'Generated file';
			return local ? '[[' + local + '|' + name + ']]' : name + ' *(generated file not downloaded)*';
		});
	};
	// A message to a tool (e.g. the image generator's settings) is a tool step.
	if (role === 'assistant' && m.recipient && m.recipient !== 'all') return [{ kind: 'tool' }];
	switch (c.content_type) {
		case 'text':
		case 'multimodal_text': {
			const clean = fallbackMarkdown(m);
			if (clean) {
				const t = renderText(clean);
				if (t) out.push({ kind: 'text', md: t });
			}
			const parts = Array.isArray(c.parts) ? c.parts : [];
			const objects = parts.filter((p): p is GptPart => typeof p === 'object' && p !== null);
			// Spoken words come as transcription parts; the audio pointer then needs no line.
			const heard = objects.some((p) => transcriptionText(p) !== null);
			const hasPointer = objects.some(isAudioPointer);
			for (const p of parts) {
				if (typeof p === 'string') {
					if (clean) continue; // the clean version above replaces the text parts
					const t = renderText(p);
					if (t) out.push({ kind: 'text', md: t });
					continue;
				}
				if (p?.content_type === 'image_asset_pointer') {
					const id = pointerId(p.asset_pointer);
					const path = id ? filePaths.get(id) : undefined;
					out.push({ kind: 'text', md: path ? `![[${path}]]` : '*[image – not downloaded]*' });
				} else if (p && isTranscription(p)) {
					const spoken = transcriptionText(p);
					const t = spoken ? renderText(spoken) : '';
					if (t) out.push({ kind: 'text', md: t });
					else if (!heard && !hasPointer) out.push({ kind: 'text', md: NO_TRANSCRIPTION });
				} else if (p && isAudioPointer(p)) {
					if (!heard) {
						const spoken = pointerTranscription(p);
						out.push({ kind: 'text', md: spoken ? renderText(spoken) || NO_TRANSCRIPTION : NO_TRANSCRIPTION });
					}
					if (hasVideo(p)) out.push({ kind: 'text', md: '*[video – see raw JSON]*' });
				} else if (typeof p?.content_type === 'string') {
					out.push({ kind: 'text', md: `*[${p.content_type} – see raw JSON]*` });
				}
			}
			// Uploaded files that are not images: link them.
			const shown = new Set(imageParts(m).map((p) => pointerId(p.asset_pointer)));
			for (const a of Array.isArray(m.metadata?.attachments) ? m.metadata.attachments : []) {
				if (!a?.id || shown.has(a.id)) continue;
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
		for (const p of pieces(m, chat.conversation_id, filePaths)) {
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
