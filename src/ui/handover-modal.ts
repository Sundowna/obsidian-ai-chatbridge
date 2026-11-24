// "Hand over a chat": pick a synced chat, get a ready message for the next AI on the clipboard.

import { App, FileSystemAdapter, Notice, Platform, SuggestModal } from 'obsidian';
import { ago, allChats, handoverText, noteTitle, type LiveItem } from '../handoff/core';
import { askOf } from '../handoff/run';
import type { Settings } from '../settings';

/** How many recent chats the picker offers. */
export const HANDOVER_CHOICES = 20;

export class HandoverModal extends SuggestModal<LiveItem> {
	private readonly items: LiveItem[];

	constructor(app: App, private readonly settings: Settings) {
		super(app);
		this.items = allChats(settings).slice(0, HANDOVER_CHOICES);
		this.setPlaceholder('Which chat should the next AI continue?');
		this.emptyStateText = 'No synced chat yet. Sync first.';
	}

	getSuggestions(query: string): LiveItem[] {
		const q = query.toLowerCase().trim();
		return q ? this.items.filter((i) => `${i.label} ${noteTitle(i.md)}`.toLowerCase().includes(q)) : this.items;
	}

	renderSuggestion(item: LiveItem, el: HTMLElement): void {
		el.createDiv({ text: noteTitle(item.md) });
		el.createEl('small', { text: `${item.label} · active ${ago(Date.now(), item.updated)} · synced ${ago(Date.now(), item.synced)}` });
	}

	onChooseSuggestion(item: LiveItem): void {
		void (async () => {
			const adapter = this.app.vault.adapter;
			const full = adapter instanceof FileSystemAdapter ? `${adapter.getBasePath()}/${item.md}` : undefined;
			const absolute = full && Platform.isWin ? full.replace(/\//g, '\\') : full;
			const text = handoverText(item, await askOf(this.app, item), Date.now(), this.settings.handoff.file, absolute);
			try {
				await navigator.clipboard.writeText(text);
				new Notice('Hand-over message copied. Paste it into the other AI.');
			} catch {
				new Notice(`Could not copy. The message is:\n\n${text}`, 30_000);
			}
		})();
	}
}
