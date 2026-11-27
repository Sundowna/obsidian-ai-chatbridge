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
export function generatedAsLinks(answer: string, generated: readonly GeminiGenerated[] = []): string {
	return answer.replace(GENERATED_PLACEHOLDER, (placeholder) => {
		const url = generated.find((g) => g.placeholder === placeholder)?.url;
		return url ? `*(Generated image, [view](<${url}>), opens while signed in to Google)*` : '*(Generated image, not saved)*';
	});
}

/** `showReasoning`: the AI's reasoning, folded, above each answer (the account's switch; on unless turned off). */
export function renderGeminiTranscript(chat: GeminiChat, jsonFileName: string, showReasoning = true): string {
	const fm = ['---', `uuid: ${chat.id}`, `created: ${chat.createdAt}`, `updated: ${chat.updatedAt}`];
	if (chat.pinned) fm.push('pinned: true');
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body = chat.turns.flatMap((t) => {
		const answer: string[] = [];
		if (t.reasoning && showReasoning) answer.push(callout('Reasoning', t.reasoning));
		answer.push(generatedAsLinks(imagesAsLinks(t.answer, t.images), t.generated).trim() || '*(no text)*');
		if (t.otherDrafts) answer.push(`*(${t.otherDrafts} other draft${t.otherDrafts === 1 ? '' : 's'} in the raw file)*`);
		return [
			`## You · ${localDateTime(t.createdAt)}`, '', t.prompt.trim() || '*(no text)*', '',
			`## Gemini${t.model ? ` (${t.model})` : ''}`, '', answer.join('\n\n'), '',
		];
	});
	return fm.join('\n') + body.join('\n');
}

export function renderStudioTranscript(p: StudioPrompt, jsonFileName: string, showReasoning = true): string {
	const fm = ['---', `uuid: ${p.id}`, `updated: ${p.updatedAt}`];
	if (p.model) fm.push(`model: ${y(p.model)}`);
	fm.push(`raw: ${y(`[[${jsonFileName}]]`)}`, 'unread: true', '---', '');
	const body: string[] = [];
	if (p.systemInstruction?.trim()) body.push(callout('System instructions', p.systemInstruction), '');
	for (const m of p.messages) {
		if (m.thought) {
			if (showReasoning) body.push(callout('Thinking', m.text || '(empty)'), '');
			continue;
		}
		const when = m.createdAt ? ` · ${localDateTime(m.createdAt)}` : '';
		body.push(`## ${m.role === 'user' ? 'You' : 'Model'}${when}`, '', m.text.trim() || '*(no text)*', '');
	}
	return fm.join('\n') + body.join('\n');
}
