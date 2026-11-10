// Draws the icons of ChatGPT layout cards in transcripts. ChatGPT names Lucide icons
// ("arrow-up-down", "folder-open"); Obsidian ships Lucide, so the note keeps the name
// (data-icon) and a text stand-in, and the reading view swaps in the real icon.

import { setIcon, type Plugin } from 'obsidian';

export function registerLayoutIcons(plugin: Plugin): void {
	plugin.registerMarkdownPostProcessor((el) => {
		for (const span of Array.from(el.querySelectorAll<HTMLElement>('.ccs-gpt-icon[data-icon]'))) {
			const name = span.dataset.icon ?? '';
			if (!/^[a-z0-9-]+$/.test(name)) continue;
			for (const id of [name, 'lucide-' + name]) {
				const probe = createSpan();
				setIcon(probe, id);
				if (probe.querySelector('svg')) {
					span.empty();
					span.append(...Array.from(probe.childNodes));
					break;
				}
			}
		}
	});
}
