// "Hand over a chat": pick a synced chat (or right-click its note), get a ready message for the
// next AI on the clipboard.

import { App, FileSystemAdapter, Notice, Platform, SuggestModal } from 'obsidian';
import { ago, allChats, handoverText, noteTitle, type LiveItem } from '../handoff/core';
import { askOf } from '../handoff/run';
import { handoffNote, type Settings } from '../settings';

/** How many recent chats the picker offers. */
export const HANDOVER_CHOICES = 20;

/** Builds the hand-over message for this chat and puts it on the clipboard. */
export async function copyHandover(app: App, settings: Settings, item: LiveItem): Promise<void> {
	const adapter = app.vault.adapter;
	const full = adapter instanceof FileSystemAdapter ? `${adapter.getBasePath()}/${item.md}` : undefined;
	const absolute = full && Platform.isWin ? full.replace(/\//g, '\\') : full;
	const text = handoverText(item, await askOf(app, item), Date.now(), handoffNote(settings.handoff), absolute);
	try {
		await navigator.clipboard.writeText(text);
		new Notice('Hand-over message copied. Paste it into the other AI.');
	} catch {
		new Notice(`Could not copy. The message is:\n\n${text}`, 30_000);
	}
}

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
		void copyHandover(this.app, this.settings, item);
	}
}
