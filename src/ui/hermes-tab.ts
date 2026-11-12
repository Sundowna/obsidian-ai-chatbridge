// The Hermes tab: where the chats go, and one row per Hermes profile with its own switch.
// Profiles whose state.db is gone are listed apart at the bottom: still switchable, never removed
// without you, and removing one never touches its notes in the vault.

import { setIcon, Setting } from 'obsidian';
import type { HermesProfile } from '../hermes/types';
import {
	addFoundProfiles, discoverProfiles, newProfile, nodeFs, profileGone, profileId, refreshProfiles, refreshSummary, removeProfile, uniqueLabel, type ProfileGone,
} from '../hermes/profiles';
import { isPrivatePath, nodeRequire } from '../hermes/reader';
import { hermesIcon } from './icons';
import { advanced, bindSyncButton, count, folderSetting, type PanelContext } from './fields';
import { ConfirmModal, NameModal } from './modals';

// Kept between redraws (every switch redraws the tab), so the last Refresh result and the
// "New" tags stay until the next Refresh or until Obsidian restarts.
let lastRefresh: { text: string; time: string } | null = null;
const freshIds = new Set<string>();

/** Long enough to see "Refreshing…": the scan itself takes a few milliseconds. */
const MIN_REFRESH_MS = 400;

export function hermesTab(ctx: PanelContext, el: HTMLElement): void {
	const h = ctx.plugin.settings.hermes;
	const save = () => ctx.plugin.saveSettings();

	if (!nodeRequire()) {
		new Setting(el).setName('Hermes Agent').setDesc('Hermes chats are read from the Hermes database on a computer, so they can only be synced in Obsidian on desktop.');
		return;
	}

	const top = new Setting(el)
		.setName('')
		.setDesc(`Chats from Hermes Agent (Nous Research), read from each profile's state.db. Read-only: Hermes' files are never changed. ${count(h.profiles.reduce((n, p) => n + Object.keys(p.index).length, 0), 'session')} saved.`);
	top.settingEl.addClass('ccs-primary-row');
	top.nameEl.addClass('ccs-name-with-icon');
	hermesIcon(top.nameEl);
	top.nameEl.createSpan({ text: 'Hermes Agent' });
	if (h.profiles.some((p) => p.enabled)) {
		top.addButton((b) =>
			bindSyncButton(ctx, b.setButtonText('Sync now').setCta().buttonEl, () => ctx.plugin.isSyncingHermes(), () => void ctx.plugin.syncHermes('manual').then(ctx.refresh)),
		);
	}

	folderSetting(ctx, el, 'Hermes folder', 'Where Hermes chats are saved. Each profile gets a subfolder named after it.', () => h.folder, (p) => (h.folder = p));

	profileList(ctx, el);

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

const sessionsOf = (p: HermesProfile): number => Object.keys(p.index).length;

const GONE_TEXT: Record<ProfileGone, string> = {
	folder: 'Folder not found',
	database: 'No state.db in this folder',
};

const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The profiles: found ones first, then the ones whose state.db is gone. */
function profileList(ctx: PanelContext, el: HTMLElement): void {
	const h = ctx.plugin.settings.hermes;
	const save = () => ctx.plugin.saveSettings();
	const fs = nodeFs();

	// The first visit finds what is there, the same way Refresh does.
	if (!h.profiles.length && addFoundProfiles(h.profiles, discoverProfiles())) void save();

	const head = new Setting(el).setName('Profiles').setHeading();
	head.settingEl.addClass('ccs-hermes-profiles-head');
	const status = head.descEl.createSpan({ cls: 'ccs-hermes-refresh-status', attr: { 'aria-live': 'polite' } });
	if (lastRefresh) status.setText(`${lastRefresh.text}. Checked at ${lastRefresh.time}.`);
	head.addButton((b) => b.setButtonText('Add by path').setTooltip('Add a profile folder that is somewhere else').onClick(() => addByPath(ctx)));
	head.addButton((b) => {
		const button = b.buttonEl;
		button.addClass('ccs-hermes-refresh');
		b.setTooltip('Look for profiles again in HERMES_HOME and the Hermes profiles folder. New ones are added turned off.');
		const icon = button.createSpan({ cls: 'ccs-glyph', attr: { 'aria-hidden': 'true' } });
		setIcon(icon, 'refresh-cw');
		const text = button.createSpan({ text: 'Refresh' });
		b.onClick(async () => {
			if (button.disabled) return;
			button.disabled = true;
			button.addClass('is-busy');
			text.setText('Refreshing…');
			status.setText('Looking for Hermes profiles…');
			const started = Date.now();
			// Let "Refreshing…" paint before the folder scan, which blocks while it runs.
			await new Promise((r) => window.setTimeout(r, 0));
			const r = refreshProfiles(h.profiles, discoverProfiles(), fs);
			freshIds.clear();
			for (const p of r.added) freshIds.add(p.id);
			if (r.added.length) await save();
			lastRefresh = { text: refreshSummary(r), time: clock(new Date()) };
			await new Promise((res) => window.setTimeout(res, Math.max(0, MIN_REFRESH_MS - (Date.now() - started))));
			ctx.refresh();
		});
	});

	const gone = new Map<HermesProfile, ProfileGone>();
	for (const p of h.profiles) {
		const why = profileGone(p, fs);
		if (why) gone.set(p, why);
	}
	const found = h.profiles.filter((p) => !gone.has(p));

	if (!found.length) {
		new Setting(el).setDesc(gone.size
			? 'None of the saved profiles can be found right now. Select Refresh once Hermes is back, or add a profile by path.'
			: 'No Hermes profiles found yet. Hermes keeps them in its home folder (HERMES_HOME, else ~/.hermes). Select Refresh after setting it up, or add one by path.');
	}

	for (const profile of found) {
		const row = new Setting(el)
			.setName(profile.label)
			.setDesc(`${profile.path} · ${count(sessionsOf(profile), 'session')} saved`)
			.addToggle((t) =>
				t.setValue(profile.enabled).onChange(async (v) => {
					profile.enabled = v;
					await save();
					ctx.refresh();
				}),
			);
		if (freshIds.has(profile.id)) row.nameEl.createSpan({ cls: 'ccs-picker-tag is-new', text: 'New' });
		if (profile.enabled) {
			row.addButton((b) =>
				bindSyncButton(ctx, b.setButtonText('Sync').buttonEl, () => ctx.plugin.isSyncingHermes(profile.id), () => void ctx.plugin.syncHermes('manual', profile.id).then(ctx.refresh)),
			);
		}
		if (!sessionsOf(profile)) {
			row.addExtraButton((b) =>
				b.setIcon('trash-2').setTooltip('Remove from this list (nothing is deleted)').onClick(async () => {
					removeProfile(h.profiles, profile);
					freshIds.delete(profile.id);
					await save();
					ctx.refresh();
				}),
			);
		}
	}

	if (gone.size) missingProfiles(ctx, el, gone);
}

/**
 * Profiles whose state.db is gone, at the bottom. They keep their switch (on = synced again as
 * soon as they are back) and get a Remove button; nothing here deletes a file anywhere.
 */
function missingProfiles(ctx: PanelContext, el: HTMLElement, gone: Map<HermesProfile, ProfileGone>): void {
	const h = ctx.plugin.settings.hermes;
	const save = () => ctx.plugin.saveSettings();
	const head = new Setting(el)
		.setName('No longer found')
		.setDesc('Syncing skips these and carries on with the others. Their saved notes stay in the vault. Leave one on if it may come back, or remove it from the list.')
		.setHeading();
	head.settingEl.addClass('ccs-hermes-missing-head');

	for (const [profile, why] of gone) {
		const saved = sessionsOf(profile);
		const row = new Setting(el).setName(profile.label);
		row.settingEl.addClass('ccs-hermes-missing');
		row.descEl.appendText(`${profile.path} · `);
		row.descEl.createSpan({ cls: 'ccs-hermes-missing-why', text: GONE_TEXT[why] });
		row.descEl.appendText(` · ${count(saved, 'session')} saved`);
		row.addToggle((t) =>
			t
				.setTooltip(profile.enabled ? 'On: synced again as soon as it is back' : 'Off: not synced, even if it comes back')
				.setValue(profile.enabled)
				.onChange(async (v) => {
					profile.enabled = v;
					await save();
					ctx.refresh();
				}),
		);
		row.addButton((b) =>
			b.setButtonText('Remove').setTooltip('Remove from this list. Saved notes stay in the vault.').onClick(() => {
				const remove = async () => {
					removeProfile(h.profiles, profile);
					await save();
					ctx.refresh();
				};
				if (!saved) {
					void remove();
					return;
				}
				new ConfirmModal(
					ctx.app,
					`Remove "${profile.label}" from the list?`,
					`Its ${count(saved, 'saved session')} stay${saved === 1 ? 's' : ''} in the vault under ${h.folder}. The plugin forgets which chats it already saved from this profile, so if you add it again later, they are saved again as new notes.`,
					'Remove',
					remove,
				).open();
			}),
		);
	}
}

function addByPath(ctx: PanelContext): void {
	const h = ctx.plugin.settings.hermes;
	const folderOf = (typed: string) => typed.trim().replace(/[\\/]state\.db$/i, '');
	new NameModal(ctx.app, {
		title: 'Add a Hermes profile',
		hint: 'The profile folder that holds state.db, for example D:/AI/Hermes/profiles/coder.',
		action: 'Add profile',
		problem: (p) => {
			const path = folderOf(p);
			if (!path) return 'Enter a folder.';
			if (isPrivatePath(path)) return 'Folders named Private are never read.';
			if (h.profiles.some((x) => x.id === profileId(path))) return 'This profile is already in the list.';
			return null;
		},
		submit: async (p) => {
			const path = folderOf(p);
			const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'Hermes';
			h.profiles.push(newProfile(uniqueLabel(h.profiles, name), path));
			await ctx.plugin.saveSettings();
			ctx.refresh();
		},
	}).open();
}
