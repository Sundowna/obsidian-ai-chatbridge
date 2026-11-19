// General tab: which computer this is, and the other computers that sync this vault.

import { Setting } from 'obsidian';
import { when } from '../last-run';
import type { PanelContext } from './fields';

export function computersSection(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	new Setting(el).setName('Computers').setHeading();
	const here = new Setting(el)
		.setName('This computer')
		.setDesc('Each computer keeps what it synced in a file of its own, so several computers can share this vault through a file syncing app without writing over each other. Whichever computer you are on syncs everything; a chat another computer already saved is not fetched again.');
	here.controlEl.createSpan({ cls: 'ccs-computer-name', text: plugin.computers.here });
	const others = new Setting(el).setName('Other computers').setDesc('Looking…');
	void plugin.computers.others().then((files) => {
		const names = new Map<string, string>();
		for (const f of files) if (f.computer && f.computer !== plugin.computers.here) {
			const seen = names.get(f.computer);
			if (!seen || f.savedAt > seen) names.set(f.computer, f.savedAt);
		}
		if (!names.size) {
			others.setDesc('None yet. Another computer appears here after its first sync of this vault.');
			return;
		}
		others.setDesc('');
		const list = others.descEl.createEl('ul', { cls: 'ccs-computer-list' });
		for (const [name, at] of [...names].sort((a, b) => b[1].localeCompare(a[1]))) {
			const ms = Date.parse(at);
			list.createEl('li', { text: Number.isNaN(ms) ? name : `${name}: last synced ${when(ms)}` });
		}
	});
}
