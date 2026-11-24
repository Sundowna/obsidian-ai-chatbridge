// General tab: keeping the vault's Active Context note up to date (see handoff/).

import { Setting } from 'obsidian';
import { cleanFolder } from '../settings';
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
	new Setting(el)
		.setName('Active Context note')
		.setDesc('Vault path of the note.')
		.addText((t) =>
			t.setPlaceholder('90 System/Memory/Active Context.md').setValue(h.file).onChange(async (v) => {
				const p = cleanFolder(v);
				if (!p || !p.toLowerCase().endsWith('.md')) return;
				h.file = p;
				await save();
			}),
		);
	folderSetting(ctx, el, 'Archive folder', 'One file per month. New ones are named "_YYYY-MM.md"; an existing "YYYY-MM.md" is added to.', () => h.archiveFolder, (p) => (h.archiveFolder = p));
	numberSetting(el, 'Live sessions: last hours', 'Chats with activity in this many hours are listed (at most 10).', () => h.liveHours, (n) => (h.liveHours = n), save, 1);
	numberSetting(el, 'Recently done: days kept', 'Older lines move to the archive.', () => h.keepDays, (n) => (h.keepDays = n), save, 1);
	numberSetting(el, 'Ask about "Now" lines after (days)', 'A line still in "Now" after this many days gets a question under "Waiting for Walter". 0 = never.', () => h.staleDays, (n) => (h.staleDays = n), save, 0);
	new Setting(el)
		.setName('Update now')
		.setDesc(h.lastDaily ? `Daily pass last ran on ${h.lastDaily}.` : 'The daily pass has not run yet.')
		.addButton((b) =>
			b.setButtonText('Update now').onClick(async () => {
				await plugin.upkeepHandoff(true);
				ctx.refresh();
			}),
		);
}
