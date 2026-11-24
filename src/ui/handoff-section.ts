// General tab: keeping the vault's Active Context note up to date (see handoff/).

import { Setting } from 'obsidian';
import { HANDOFF_ARCHIVE, HANDOFF_NOTE } from '../settings';
import { folderSetting, type PanelContext } from './fields';

/** A whole number field: bad input or a number below `min` is ignored. */
function numberSetting(el: HTMLElement, name: string, desc: string, get: () => number, set: (n: number) => void, save: () => Promise<void>, min: number): void {
	new Setting(el)
		.setName(name)
		.setDesc(desc)
		.addText((t) =>
			t.setValue(String(get())).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || n < min) return;
				set(n);
				await save();
			}),
		);
}

export function handoffSection(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	const h = plugin.settings.handoff;
	const save = () => plugin.saveSettings();

	new Setting(el).setName('Active Context').setHeading();
	new Setting(el)
		.setName('Keep Active Context up to date')
		.setDesc('After each sync, writes a "Live sessions" list (chats active lately, with a link and your last request) into the note. Once a day, moves "Recently done" lines older than the days below to the monthly archive, word for word, and asks about lines that stayed in "Now" too long. Only on the computer that syncs.')
		.addToggle((t) =>
			t.setValue(h.enabled).onChange(async (v) => {
				h.enabled = v;
				await save();
				ctx.refresh();
				if (v) void plugin.upkeepHandoff(false);
			}),
		);
	if (!h.enabled) return;
	folderSetting(
		ctx,
		el,
		'Handoff folder',
		`Holds the "${HANDOFF_NOTE}" note and the the "${HANDOFF_ARCHIVE}" folder with one "_YYYY-MM.md" file per month.`,
		() => h.folder,
		(p) => {
			// Another folder, another note: its daily pass and "Now" lines start fresh.
			if (p !== h.folder) {
				h.lastDaily = undefined;
				h.nowSeen = {};
			}
			h.folder = p;
		},
	);
	numberSetting(el, 'Live sessions: last hours', 'Chats with activity in this many hours are listed (at most 10).', () => h.liveHours, (n) => (h.liveHours = n), save, 1);
	numberSetting(el, 'Recently done: days kept', 'Older lines move to the archive.', () => h.keepDays, (n) => (h.keepDays = n), save, 1);
	numberSetting(el, 'Ask about "Now" lines after (days)', 'A line still in "Now" after this many days gets a question under "Waiting for Walter". 0 = never.', () => h.staleDays, (n) => (h.staleDays = n), save, 0);
	new Setting(el)
		.setName('Update now')
		.setDesc(`${h.lastDaily ? `Daily pass last ran on ${h.lastDaily}.` : 'The daily pass has not run yet.'} If the folder has no "${HANDOFF_NOTE}" yet, this makes one with the five parts, empty.`)
		.addButton((b) =>
			b.setButtonText('Update now').onClick(async () => {
				await plugin.upkeepHandoff(true);
				ctx.refresh();
			}),
		);
}
