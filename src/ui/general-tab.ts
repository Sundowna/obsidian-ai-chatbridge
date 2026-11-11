// Settings that apply to every account.

import { Setting } from 'obsidian';
import { folderExists, layoutMoves } from '../desktop/layout';
import { MIN_DELAY_SECONDS, MIN_INTERVAL_MINUTES } from '../settings';
import type { PanelContext } from './fields';

export function generalTab(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	const s = plugin.settings;
	const d = s.desktop;
	const save = () => plugin.saveSettings();

	new Setting(el).setName('Sync').setHeading();
	new Setting(el)
		.setName('Max chats per run')
		.setDesc('Per account (0 = no limit). Keep it small while testing.')
		.addText((t) =>
			t.setValue(String(s.maxChatsPerRun)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || n < 0) return;
				s.maxChatsPerRun = n;
				await save();
			}),
		);
	new Setting(el)
		.setName('Delay between requests (seconds)')
		.setDesc(`Minimum ${MIN_DELAY_SECONDS}.`)
		.addText((t) =>
			t.setValue(String(s.delaySeconds)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isFinite(n) || n < MIN_DELAY_SECONDS) return;
				s.delaySeconds = n;
				await save();
			}),
		);
	new Setting(el)
		.setName('Sync all on startup')
		.setDesc('Runs "Sync all" once, 10 seconds after the vault opens. Only accounts you are logged in to; it tells you when new chats are saved or something goes wrong.')
		.addToggle((t) =>
			t.setValue(s.syncOnStartup).onChange(async (v) => {
				s.syncOnStartup = v;
				await save();
			}),
		);
	new Setting(el)
		.setName('Automatic sync (minutes)')
		.setDesc(`Runs "Sync all". 0 is off, minimum ${MIN_INTERVAL_MINUTES}. Pauses after an error until you sync by hand.`)
		.addText((t) =>
			t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || (n !== 0 && n < MIN_INTERVAL_MINUTES)) return;
				s.intervalMinutes = n;
				await save();
				plugin.restartTimer();
			}),
		);

	new Setting(el).setName('Desktop sessions').setHeading();
	new Setting(el)
		.setName('Mirror the apps’ sidebar as subfolders')
		.setDesc('Claude: one folder per sidebar group, otherwise by working folder. Codex: one folder per project, the rest in "Recent".')
		.addToggle((t) =>
			t.setValue(d.projectSubfolders).onChange(async (v) => {
				d.projectSubfolders = v;
				await save();
			}),
		);
	new Setting(el)
		.setName('Wait until a session is quiet (minutes)')
		.setDesc('Newer sessions may still be running and are saved on a later sync.')
		.addText((t) =>
			t.setValue(String(d.quietMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || n < 0 || n > 1440) return;
				d.quietMinutes = n;
				await save();
			}),
		);
	new Setting(el)
		.setName('Keep the raw session file')
		.setDesc('Also copy the app’s .jsonl, next to each transcript or into a raw session folder chosen in each account’s desktop settings. These can be several MB and contain tool output in full.')
		.addToggle((t) =>
			t.setValue(d.keepRaw).onChange(async (v) => {
				d.keepRaw = v;
				await save();
			}),
		);
	new Setting(el)
		.setName('Include helper sessions')
		.setDesc('Also save background helper runs, such as Codex approval reviews.')
		.addToggle((t) =>
			t.setValue(d.includeSubagents).onChange(async (v) => {
				d.includeSubagents = v;
				// Look at skipped helper sessions again.
				for (const a of [...s.claude, ...s.chatgpt]) a.desktop.ignored = {};
				await save();
			}),
		);

	const moves = layoutMoves(s, folderExists(ctx.app));
	if (!moves.length) return;
	new Setting(el).setName('Folder layout').setHeading();
	new Setting(el)
		.setName('Move into the app layout')
		.setDesc(`${moves.map((m) => `${m.label}: ${m.from} → ${m.to}`).join('; ')}. Uses Obsidian's own move, so links and the sync index follow.`)
		.addButton((b) =>
			b.setButtonText('Move now').setWarning().onClick(() => {
				void plugin.moveToAppLayout().then(ctx.refresh);
			}),
		);
}
