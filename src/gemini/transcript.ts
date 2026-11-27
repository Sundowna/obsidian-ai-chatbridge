// Gemini chats and AI Studio prompts as Markdown transcripts. Pure code, no AI.

import { localDateTime } from '../naming';
import type { GeminiChat, GeminiGenerated, GeminiImage, StudioPrompt } from './types';
import { GENERATED_PLACEHOLDER } from './wire';

const y = (s: string): string => JSON.stringify(s);

function callout(title: string, text: string): string {
	return [`> [!note]- ${title}`, ...text.trim().split('\n').map((l) => `> ${l}`)].join('\n');
}

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const plain = (s: string): string => s.replace(/[[\]*_`<>|]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Gemini writes pictures into its answers as <Image alt="…" caption="…" src="image_agent_tag_…"/>.
 * They become a line with a link to the picture, so opening a note loads nothing from the web.
 */
export function imagesAsLinks(answer: string, images: readonly GeminiImage[] = []): string {
	return answer.replace(/<Image\b[^>]*\/?>/g, (tag) => {
		const src = attr(tag, 'src') ?? '';
		const image = images.find((i) => i.tag === src);
		const what = plain(attr(tag, 'caption') || attr(tag, 'alt') || 'picture');
		const links: string[] = [];
		if (image?.url) links.push(`[view](<${image.url}>)`);
		if (image?.page) links.push(`from [${plain(image.site ?? 'source')}](<${image.page}>)`);
		return `*(Image: ${what}${links.length ? `, ${links.join(', ')}` : ', not saved'})*`;
	});
}

/**
 * Pictures Gemini made stand in its answers as a placeholder address that leads nowhere.
 * Each becomes a line with a link to the picture on Google's servers (it opens only while
 * signed in to Google), or "not saved" when the chat data gave no address.
 */
export function generatedAsLinks(answer: string, generated: readonly GeminiGenerated[] = [], saved?: ReadonlyMap<string, string>): string {
	return answer.replace(GENERATED_PLACEHOLDER, (placeholder) => {
		const url = generated.find((g) => g.placeholder === placeholder)?.url;
		const path = url ? saved?.get(url) : undefined;
		if (path) return `![[${path}]]`;
		return url ? `*(Generated image, [view](<${url}>), opens while signed in to Google)*` : '*(Generated image, not saved)*';
	});
}

/** `showReasoning`: the AI's reasoning, folded, above each answer (the account's switch; on unless turned off). */
export function renderGeminiTranscript(chat: GeminiChat, jsonFileName: string, showReasoning = true, pictures?: ReadonlyMap<string, string>): string {
	const fm = ['---', `uuid: ${chat.id}`, `created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`];
	if (chat.pinned) fm.push('pinned: true');
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body = chat.turns.flatMap((t) => {
		const answer: string[] = [];
		if (t.reasoning && showReasoning) answer.push(callout('Reasoning', t.reasoning));
		answer.push(generatedAsLinks(imagesAsLinks(t.answer, t.images), t.generated, pictures).trim() || '*(no text)*');
		if (t.otherDrafts) answer.push(`*(${t.otherDrafts} other draft${t.otherDrafts === 1 ? '' : 's'} in the raw file)*`);
		return [
			`## You · ${localDateTime(t.createdAt)}`, '', t.prompt.trim() || '*(no text)*', '',
			`## Gemini${t.model ? ` (${t.model})` : ''}`, '', answer.join('\n\n'), '',
		];
	});
	return fm.join('\n') + body.join('\n');
}

/** A code block whose fence is longer than any backtick run inside. */
function fenced(lang: string, text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

/** Picture chunks AI Studio repeats (the same picture twice in a row) are shown and saved once. */
function repeatedPicture(p: StudioPrompt, i: number): boolean {
	const m = p.messages[i];
	const before = p.messages[i - 1];
	if (!m?.picture || !before?.picture) return false;
	const data = (k: number): string => {
		const raw: unknown = p.raw;
		const outer = Array.isArray(raw) ? (raw as unknown[])[13] : undefined;
		const chunks = Array.isArray(outer) ? (outer as unknown[])[0] : undefined;
		const c = Array.isArray(chunks) ? (chunks as unknown[])[k] : undefined;
		const pic = Array.isArray(c) ? (c as unknown[])[12] : undefined;
		return Array.isArray(pic) ? String((pic as unknown[])[1]) : '';
	};
	return data(m.picture.chunk) !== '' && data(m.picture.chunk) === data(before.picture.chunk);
}

/** The pictures of an AI Studio prompt, each with the file name it is saved under (repeats left out). */
export function studioPictures(p: StudioPrompt): { url: string; name: string; chunk: number; type: string }[] {
	const out: { url: string; name: string; chunk: number; type: string }[] = [];
	p.messages.forEach((m, i) => {
		if (!m.picture || repeatedPicture(p, i)) return;
		out.push({ url: `studio:${p.id}#${m.picture.chunk}`, name: `AI Studio picture ${out.length + 1}`, chunk: m.picture.chunk, type: m.picture.type });
	});
	return out;
}

/**
 * An AI Studio prompt as a note. A model turn's parts (the code it ran, the code's output, the
 * pictures it made) stay under one heading. `pictures`: saved picture files by their key.
 */
export function renderStudioTranscript(p: StudioPrompt, jsonFileName: string, showReasoning = true, pictures?: ReadonlyMap<string, string>): string {
	const fm = ['---', `uuid: ${p.id}`, `updated: ${p.updatedAt}`];
	if (p.model) fm.push(`model: ${y(p.model)}`);
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body: string[] = [];
	if (p.systemInstruction?.trim()) body.push(callout('System instructions', p.systemInstruction), '');
	let open: 'user' | 'model' | null = null;
	const heading = (m: StudioPrompt['messages'][number]) => {
		if (open === m.role) return;
		const when = m.createdAt ? ` · ${localDateTime(m.createdAt)}` : '';
		body.push(`## ${m.role === 'user' ? 'You' : 'Model'}${when}`, '');
		open = m.role;
	};
	p.messages.forEach((m, i) => {
		if (m.thought) {
			if (showReasoning) body.push(callout('Thinking', m.text || '(empty)'), '');
			return;
		}
		if (m.code) {
			heading(m);
			body.push(callout(`Code (${m.code.language})`, fenced(m.code.language, m.code.text)), '');
			return;
		}
		if (m.codeResult !== undefined) {
			heading(m);
			if (m.codeResult.trim()) body.push(callout('Code output', fenced('', m.codeResult)), '');
			return;
		}
		if (m.picture) {
			if (repeatedPicture(p, i)) return;
			heading(m);
			const path = pictures?.get(`studio:${p.id}#${m.picture.chunk}`);
			body.push(path ? `![[${path}]]` : '*(Picture, not saved)*', '');
			return;
		}
		// Text: a new heading only when the speaker changes; an empty message shows only as a turn of its own.
		const fresh = open !== m.role;
		heading(m);
		if (m.text.trim()) body.push(m.text.trim(), '');
		else if (fresh) body.push('*(no text)*', '');
	});
	return fm.join('\n') + body.join('\n');
}

/** The pictures Gemini made in a chat, each with the file name it is saved under. */
export function chatPictures(chat: GeminiChat): { url: string; name: string }[] {
	const out: { url: string; name: string }[] = [];
	chat.turns.forEach((t, i) => (t.generated ?? []).forEach((g, k) => {
		if (g.url) out.push({ url: g.url, name: `Gemini picture ${i + 1}-${k + 1}` });
	}));
	return out;
}
