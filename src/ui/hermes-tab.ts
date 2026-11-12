// The Hermes tab: where the chats go, and one row per Hermes profile with its own switch.

import { Notice, Setting } from 'obsidian';
import { addFoundProfiles, discoverProfiles, newProfile, profileId } from '../hermes/profiles';
import { isPrivatePath, nodeRequire } from '../hermes/reader';
import { advanced, bindSyncButton, count, folderSetting, type PanelContext } from './fields';
import { NameModal } from './modals';

export function hermesTab(ctx: PanelContext, el: HTMLElement): void {
	const h = ctx.plugin.settings.hermes;
	const save = () => ctx.plugin.saveSettings();

	if (!nodeRequire()) {
		new Setting(el).setName('Hermes Agent').setDesc('Hermes chats are read from the Hermes database on a computer, so they can only be synced in Obsidian on desktop.');
		return;
	}

	const top = new Setting(el)
		.setName('Hermes Agent')
		.setDesc(`Chats from Hermes Agent (Nous Research), read from each profile's state.db. Read-only: Hermes' files are never changed. ${count(h.profiles.reduce((n, p) => n + Object.keys(p.index).length, 0), 'session')} saved.`);
	top.settingEl.addClass('ccs-primary-row');
	if (h.profiles.some((p) => p.enabled)) {
		top.addButton((b) =>
			bindSyncButton(ctx, b.setButtonText('Sync now').setCta().buttonEl, () => ctx.plugin.isSyncingHermes(), () => void ctx.plugin.syncHermes('manual').then(ctx.refresh)),
		);
	}

	folderSetting(ctx, el, 'Hermes folder', 'Where Hermes chats are saved. Each profile gets a subfolder named after it.', () => h.folder, (p) => (h.folder = p));

	new Setting(el).setName('Profiles').setHeading();
	if (!h.profiles.length) {
		const found = addFoundProfiles(h.profiles, discoverProfiles());
		if (found) void save();
	}
	for (const profile of h.profiles) {
		const row = new Setting(el)
			.setName(profile.label)
			.setDesc(`${profile.path} · ${count(Object.keys(profile.index).length, 'session')} saved`)
			.addToggle((t) =>
				t.setValue(profile.enabled).onChange(async (v) => {
					profile.enabled = v;
					await save();
					ctx.refresh();
				}),
			);
		if (profile.enabled) {
			row.addButton((b) =>
				bindSyncButton(ctx, b.setButtonText('Sync').buttonEl, () => ctx.plugin.isSyncingHermes(profile.id), () => void ctx.plugin.syncHermes('manual', profile.id).then(ctx.refresh)),
			);
		}
		if (!Object.keys(profile.index).length) {
			row.addExtraButton((b) =>
				b.setIcon('trash-2').setTooltip('Remove from this list (nothing is deleted)').onClick(async () => {
					h.profiles.splice(h.profiles.indexOf(profile), 1);
					await save();
					ctx.refresh();
				}),
			);
		}
	}

	new Setting(el)
		.setName('Find profiles')
		.setDesc('Looks in the Hermes home folder (HERMES_HOME, else the default) and its profiles folder. New ones are added turned off.')
		.addButton((b) =>
			b.setButtonText('Find').onClick(async () => {
				const added = addFoundProfiles(h.profiles, discoverProfiles());
				await save();
				new Notice(added ? `Hermes: ${count(added, 'profile')} added.` : 'Hermes: no new profiles found.');
				ctx.refresh();
			}),
		)
		.addButton((b) =>
			b.setButtonText('Add by path').onClick(() => {
				new NameModal(ctx.app, {
					title: 'Add a Hermes profile',
					hint: 'The profile folder that holds state.db, for example D:/AI/Hermes/profiles/coder.',
					action: 'Add profile',
					problem: (p) => {
						const path = p.trim();
						if (!path) return 'Enter a folder.';
						if (isPrivatePath(path)) return 'Folders named Private are never read.';
						if (h.profiles.some((x) => x.id === profileId(path))) return 'This profile is already in the list.';
						return null;
					},
					submit: async (p) => {
						const path = p.trim().replace(/[\\/]state\.db$/i, '');
						const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'Hermes';
						h.profiles.push(newProfile(name, path));
						await save();
						ctx.refresh();
					},
				}).open();
			}),
		);

	const more = advanced(ctx, el, 'hermes');
	new Setting(more)
		.setName('Python')
		.setDesc("Only used when Obsidian has no built-in SQLite. Empty = Hermes' own Python (in its tools folder), else the first Python found on this computer.")
		.addText((t) =>
			t.setPlaceholder('D:/AI/Hermes/tools/python-…/python.exe').setValue(h.pythonPath).onChange(async (v) => {
				h.pythonPath = v.trim();
				await save();
			}),
		);
	new Setting(more)
		.setName('How it reads')
		.setDesc('Each sync opens state.db read-only and copies a consistent snapshot (including the -wal file) to a temporary file with SQLite\'s backup function, reads that copy and deletes it. Sessions active in the last few minutes wait for the next sync (General → "Wait until a session is quiet"). Helper runs (subagents) follow General → "Include helper sessions".');
}
