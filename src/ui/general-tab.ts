// Settings that apply to every account.

import { Setting } from 'obsidian';
import { folderExists, layoutMoves, layoutRoot } from '../desktop/layout';
import { formatClock, reindexText } from '../main';
import { ConfirmModal } from './modals';
import { DEFAULT_SETTINGS, MIN_DELAY_SECONDS, MIN_INTERVAL_MINUTES } from '../settings';
import { allRawMoves } from '../raw-move';
import { rawFolderSetting, rawMoveRow, type PanelContext } from './fields';

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

	new Setting(el).setName('Raw files').setHeading();
	const raw = el.createDiv();
	rawFolderSetting(ctx, raw, {
		name: 'Raw files folder',
		what: 'raw files',
		partner: 'transcript folders',
		placeholder: 'Next to the transcripts',
		resetTo: DEFAULT_SETTINGS.rawRoot,
		standalone: true,
		toggle: { get: () => s.rawRootOn, set: (on) => (s.rawRootOn = on) },
		get: () => s.rawRoot || undefined,
		set: (p) => (s.rawRoot = p ?? ''),
		describe: (where, on) => !on
			? 'Off: each account chooses its own JSON folders in its folder settings, or keeps the raw files next to the transcripts.'
			: where
				? `Every raw .json (and kept .jsonl) goes here, at the same path as its transcript, e.g. ${where}/${s.claude[0]!.web.chatFolder}/Recent. Transcripts stay where they are. While this is on, the accounts' JSON folder fields are hidden and not used.`
				: "Empty: raw files stay next to their transcripts. While this is on, the accounts' JSON folder fields are hidden and not used.",
	});
	rawMoveRow(ctx, raw, () => allRawMoves(ctx.app, s), 'raw file');

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
		.setDesc('Also copy the app’s .jsonl, into the raw files folder above (with that off: next to each transcript, or into each account’s raw session folder). These can be several MB and contain tool output in full.')
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
	new Setting(el)
		.setName('Save Claude Code files')
		.setDesc('Pasted images go to Attachments/, documents and images Claude wrote or sent you to Artifacts/, next to the transcript. Published artifacts and docs are linked. Sessions synced earlier get their files on the next sync; their transcripts stay as they are.')
		.addToggle((t) =>
			t.setValue(d.saveFiles).onChange(async (v) => {
				d.saveFiles = v;
				await save();
			}),
		);

	new Setting(el).setName('Index').setHeading();
	const last = plugin.lastReindex;
	const reindex = new Setting(el)
		.setName('Refresh index')
		.setDesc(last
			? `${reindexText(last)} (${formatClock(last.at)})`
			: 'Moved or renamed synced notes outside Obsidian, e.g. in the file manager or while the plugin was off? This finds them again by their chat ID, so the next sync does not save them twice. Moves inside Obsidian are followed anyway.')
		.addButton((b) =>
			b.setButtonText('Refresh').onClick(async () => {
				b.setDisabled(true).setButtonText('Refreshing…');
				await plugin.refreshIndexNow();
				ctx.refresh();
			}),
		);
	reindex.descEl.toggleClass('ccs-result', !!last);

	const moves = layoutMoves(s, folderExists(ctx.app));
	if (!moves.length) return;
	const root = layoutRoot(s.claude[0]!.web.chatFolder);
	const short = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
	// A folder two settings shared (older versions' "Code") moves once; the second only switches its setting.
	const shown = moves.filter((m, i) => moves.findIndex((x) => x.from === m.from) === i);
	new Setting(el).setName('Folder layout').setHeading();
	const layout = new Setting(el)
		.setName('Move into the new layout')
		.setDesc(createFragment((f) => {
			f.appendText(`One folder per provider, shared by all its accounts, inside ${root || 'the vault'}. Each note says which account it came from.`);
			const list = f.createEl('ul', { cls: 'ccs-move-list' });
			for (const m of shown) {
				const li = list.createEl('li');
				li.createSpan({ cls: 'ccs-move-label', text: `${m.label}: ` });
				li.createEl('code', { text: short(m.from) });
				li.appendText(' → ');
				li.createEl('code', { text: short(m.to) });
			}
			f.appendText('Uses Obsidian\'s own move, so links and the sync history follow. The raw files folder moves with them.');
		}))
		.addButton((b) =>
			b.setButtonText('Move now…').setWarning().onClick(() => {
				new ConfirmModal(
					ctx.app,
					'Move synced chats into the new layout?',
					`${shown.length} ${shown.length === 1 ? 'folder moves' : 'folders move'}, with their raw files. Accounts that had folders of their own now share one per provider. Nothing is deleted: if a file with the same name is already there, both stay and you are told which.`,
					'Move now',
					async () => {
						await plugin.moveToAppLayout();
						ctx.refresh();
					},
				).open();
			}),
		);
	layout.settingEl.addClass('ccs-layout-move');
}
