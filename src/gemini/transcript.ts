// Gemini chats and AI Studio prompts as Markdown transcripts. Pure code, no AI.

import { localDateTime } from '../naming';
import type { GeminiChat, GeminiImage, StudioPrompt } from './types';

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

export function renderGeminiTranscript(chat: GeminiChat, jsonFileName: string): string {
	const fm = ['---', `uuid: ${chat.id}`, `created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`];
	if (chat.pinned) fm.push('pinned: true');
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body = chat.turns.flatMap((t) => {
		const answer: string[] = [];
		if (t.reasoning) answer.push(callout('Reasoning', t.reasoning));
		answer.push(imagesAsLinks(t.answer, t.images).trim() || '*(no text)*');
		if (t.otherDrafts) answer.push(`*(${t.otherDrafts} other draft${t.otherDrafts === 1 ? '' : 's'} in the raw file)*`);
		return [
			`## You · ${localDateTime(t.createdAt)}`, '', t.prompt.trim() || '*(no text)*', '',
			`## Gemini${t.model ? ` (${t.model})` : ''}`, '', answer.join('\n\n'), '',
		];
	});
	return fm.join('\n') + body.join('\n');
}

export function renderStudioTranscript(p: StudioPrompt, jsonFileName: string): string {
	const fm = ['---', `uuid: ${p.id}`, `updated: ${p.updatedAt}`];
	if (p.model) fm.push(`model: ${y(p.model)}`);
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body: string[] = [];
	if (p.systemInstruction?.trim()) body.push(callout('System instructions', p.systemInstruction), '');
	for (const m of p.messages) {
		if (m.thought) {
			body.push(callout('Thinking', m.text || '(empty)'), '');
			continue;
		}
		const when = m.createdAt ? ` · ${localDateTime(m.createdAt)}` : '';
		body.push(`## ${m.role === 'user' ? 'You' : 'Model'}${when}`, '', m.text.trim() || '*(no text)*', '');
	}
	return fm.join('\n') + body.join('\n');
}
