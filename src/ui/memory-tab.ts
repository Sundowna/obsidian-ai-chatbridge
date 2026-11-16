// The Memory tab: which AI's memories are saved, where, and how often. Every source is off
// until you turn it on.

import { Setting } from 'obsidian';
import { computerName } from '../computer';
import { claudeHome, codexHome, nodeDesktopFs } from '../desktop/scan';
import { MEMORY, lastRunLine, when } from '../last-run';
import { MIN_INTERVAL_MINUTES } from '../settings';
import { bindSyncButton, count, folderSetting, type PanelContext } from './fields';

export function memoryTab(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	const m = plugin.settings.memory;
	const save = () => plugin.saveSettings();
	const fs = nodeDesktopFs();

	if (!fs) {
		new Setting(el).setName('AI memory').setDesc('Codex and Claude Code keep their memories on a computer, so they can only be saved in Obsidian on desktop.');
		return;
	}

	const anyOn = m.codexLocal || m.claudeCodeLocal;
	const top = new Setting(el)
		.setName('AI memory')
		.setDesc('What each AI keeps about you between chats: its memory files and your global instructions. Saved as dated snapshots, exactly as the AI keeps them. A new snapshot is written only when something changed. Read-only: the AI\'s own files are never changed.');
	top.settingEl.addClass('ccs-primary-row');
	if (anyOn) {
		lastRunLine(top.infoEl, plugin.settings.lastRuns[MEMORY]);
		top.addButton((b) =>
			bindSyncButton(ctx, b.setButtonText('Sync now').setCta().buttonEl, () => plugin.isSyncingMemory(), () => void plugin.syncMemory('manual').then(ctx.refresh)),
		);
	}

	folderSetting(ctx, el, 'Memory folder', 'Where the snapshots are saved: <folder>/<AI>/<account>/YYYY-MM-DD.md, plus _latest.md with the current state. Only the plugin writes here.', () => m.folder, (p) => (m.folder = p));

	const account = computerName();
	new Setting(el).setName('On this computer').setDesc(`Saved under the account "${account}", this computer's name.`).setHeading();

	const source = (name: string, key: 'codexLocal' | 'claudeCodeLocal', provider: string, reads: string) => {
		const state = m.states[`${provider}/${account}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}: ${count(state.files, 'file')}.` : '';
		new Setting(el)
			.setName(name)
			.setDesc(`${reads}${last}`)
			.addToggle((t) =>
				t.setValue(m[key]).onChange(async (v) => {
					m[key] = v;
					await save();
					ctx.refresh(); // shows or hides Sync now
				}),
			);
	};
	source('Codex', 'codexLocal', 'Codex', `Reads ${codexHome(fs)}: AGENTS.md, the memories and memories_v2 folders, and the per-thread notes in its memory database.`);
	source('Claude Code', 'claudeCodeLocal', 'Claude Code', `Reads ${claudeHome(fs)}: CLAUDE.md and every project's memory folder.`);

	new Setting(el).setName('Schedule').setHeading();
	new Setting(el)
		.setName('Automatic memory sync (minutes)')
		.setDesc(`Checks the sources that are on. 0 is off, minimum ${MIN_INTERVAL_MINUTES}. "Sync all" does not include AI memory; use Sync now above or the command "Sync AI memory".`)
		.addText((t) =>
			t.setValue(String(m.intervalMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || (n !== 0 && n < MIN_INTERVAL_MINUTES)) return;
				m.intervalMinutes = n;
				await save();
				plugin.restartMemoryTimer();
			}),
		);

	new Setting(el)
		.setName('What is saved')
		.setDesc('Each memory file becomes a heading with its text in a code block below, so nothing in it is reformatted. Nothing is filtered, translated or corrected: if a memory holds something sensitive, the snapshot holds it too. Folders named Private are never read. Codex\'s use counters are left out, because they change every time a memory is used.');
}
