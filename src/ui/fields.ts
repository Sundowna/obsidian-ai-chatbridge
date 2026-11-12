// Small pieces shared by the settings panels.

import { Notice, setIcon, Setting, type App, type TextComponent } from 'obsidian';
import type AIChatBridge from '../main';
import type { Provider } from '../login';
import type { AnyAccount } from '../accounts';
import { BROWSE_MESSAGES, browseForVaultFolder } from '../folder-dialog';
import { FolderSuggest } from '../folder-suggest';
import type { ProjectCatalog } from '../project-catalog';
import { cleanFolder } from '../settings';
import { defaultProjectFolder, NO_PROJECT, plainFolder } from '../select';
import { projectPicker } from './project-picker';
import { masterRaw, projectRawDefault, type RawMove } from '../raw-folders';
import { moveRawFiles } from '../raw-move';
import { ConfirmModal } from './modals';

export interface PanelContext {
	app: App;
	plugin: AIChatBridge;
	/** Draws the settings again, staying where you are. */
	refresh: () => void;
	openAccount: (provider: Provider, account: AnyAccount) => void;
	/** Switches to the Hermes tab. */
	openHermes: () => void;
	/** Collapsible sections that are open, so a redraw leaves them open. */
	openSections: Set<string>;
}

/**
 * Makes a Sync button follow the running sync: "Stop" while `mine` is the one syncing,
 * greyed out while another sync runs, and back to `idle` when nothing runs.
 */
export function bindSyncButton(ctx: PanelContext, button: HTMLButtonElement, mine: () => boolean, start: () => void, idle = button.getText()): void {
	const { plugin } = ctx;
	const cta = button.hasClass('mod-cta');
	const draw = () => {
		const running = plugin.syncing;
		const stoppable = running && mine();
		button.setText(stoppable ? (plugin.stopping ? 'Stopping…' : 'Stop') : idle);
		button.toggleClass('mod-warning', stoppable);
		button.toggleClass('mod-cta', cta && !stoppable);
		button.disabled = (running && !stoppable) || (stoppable && plugin.stopping);
		if (running && !stoppable) button.setAttr('title', 'Another sync is running');
		else if (stoppable) button.setAttr('title', 'Stops after the current chat. Everything saved so far stays.');
		else button.removeAttribute('title');
	};
	const off = plugin.onBusyChange(() => {
		if (!button.isConnected) {
			off();
			return;
		}
		draw();
	});
	button.addEventListener('click', () => {
		if (plugin.syncing && mine()) plugin.requestStop();
		else if (!plugin.syncing) start();
	});
	draw();
}

export const count =(n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

/** Fired (bubbling) when a folder setting was committed, so the "move saved files" row recounts. */
export const FOLDERS_CHANGED = 'ccs-folders-changed';
export const foldersChanged = (from: HTMLElement): boolean => from.dispatchEvent(new CustomEvent(FOLDERS_CHANGED, { bubbles: true }));

export function folderSetting(ctx: PanelContext, el: HTMLElement, name: string, desc: string, get: () => string, set: (p: string) => void): void {
	const save = async (v: string) => {
		const p = cleanFolder(v);
		if (!p) return; // ignore empty / hidden folders
		set(p);
		await ctx.plugin.saveSettings();
	};
	let text: TextComponent | null = null;
	new Setting(el)
		.setName(name)
		.setDesc(desc)
		.addText((t) => {
			text = t;
			t.setPlaceholder('AI Chats/…').setValue(get()).onChange(save);
			t.inputEl.addEventListener('change', () => foldersChanged(t.inputEl));
			new FolderSuggest(ctx.app, t.inputEl, (path) => void save(path).then(() => foldersChanged(t.inputEl)));
		})
		.addButton((b) =>
			b
				.setButtonText('Browse…')
				.setTooltip('Pick a folder in the vault with the system folder dialog')
				.onClick(async () => {
					const r = browseForVaultFolder(ctx.app, get(), `Choose the ${name.toLowerCase()}`);
					if (!r.ok) {
						const msg = BROWSE_MESSAGES[r.reason];
						if (msg) new Notice(msg, 8000);
						return;
					}
					text?.setValue(r.path);
					await save(r.path);
					foldersChanged(el);
				}),
		);
}

export interface RawFolderOptions {
	/** E.g. "JSON folder". */
	name: string;
	/** What lands there, for the description, e.g. "the raw .json of each chat". */
	what: string;
	/** The transcript folder above, for the description, e.g. "chat folder". */
	partner: string;
	get: () => string | undefined;
	set: (path: string | undefined) => void;
	/** Mirrors project or app subfolders (all but Gemini and AI Studio). */
	mirrors?: boolean;
	/** Replaces the description (the master raw folder under General). */
	describe?: (where: string | undefined, on: boolean) => string;
	/** Greyed text while empty; default: where the raw files go then. */
	placeholder?: string;
	/** The value the reset button restores; default empty. */
	resetTo?: string;
	/** A setting of its own, not drawn indented under a transcript folder. */
	standalone?: boolean;
	/** An on/off switch at the end of the row; while off, the field and its buttons are hidden. */
	toggle?: { get: () => boolean; set: (on: boolean) => void };
}

/**
 * The JSON folder that goes with a transcript folder, drawn right under it. Empty = next to the
 * transcripts (the greyed placeholder says so), so nothing changes until you choose one.
 */
export function rawFolderSetting(ctx: PanelContext, el: HTMLElement, o: RawFolderOptions): void {
	// One raw files folder (General) is on: it decides alone, so the per-account fields go away.
	if (!o.standalone && masterRaw(ctx.plugin.settings) !== undefined) return;
	let text: TextComponent | null = null;
	let reset: HTMLElement | null = null;
	const row = new Setting(el).setName(o.name);
	row.settingEl.addClass('ccs-raw-folder');
	if (!o.standalone) row.settingEl.addClass('ccs-sub-setting');
	else {
		// Long text: under the name, field and buttons, full width.
		row.settingEl.addClass('ccs-desc-below');
		row.settingEl.appendChild(row.descEl);
	}
	const describe = (problem?: string) => {
		row.descEl.empty();
		if (problem) {
			row.descEl.createSpan({ cls: 'ccs-raw-folder-error', text: problem });
			return;
		}
		const where = o.get();
		const on = o.toggle ? o.toggle.get() : true;
		row.descEl.setText(o.describe ? o.describe(where, on) : where
			? `Where ${o.what} goes${o.mirrors ? ', in the same subfolders as the transcripts' : ''}. Transcripts stay in the ${o.partner}.`
			: `Where ${o.what} goes. Empty keeps it next to the transcripts; choose a folder to keep the ${o.partner} free of raw files.`);
		if (on && where && !ctx.app.vault.getFolderByPath(where)) row.descEl.createDiv({ cls: 'ccs-raw-folder-new', text: 'New folder: created on the next sync.' });
	};
	const commit = async (value: string) => {
		const typed = value.trim();
		const path = cleanFolder(typed);
		if (typed && !path) {
			text?.inputEl.addClass('is-invalid');
			text?.inputEl.setAttr('aria-invalid', 'true');
			describe(`Choose a folder inside the vault, not the vault itself or a hidden one such as ${ctx.app.vault.configDir}.`);
			return; // keep the last good folder
		}
		text?.inputEl.removeClass('is-invalid');
		text?.inputEl.setAttr('aria-invalid', 'false');
		o.set(path ?? undefined);
		if (text && text.getValue() !== (path ?? '')) text.setValue(path ?? '');
		reset?.toggleClass('ccs-invisible', (path ?? '') === (o.resetTo ?? ''));
		describe();
		await ctx.plugin.saveSettings();
		foldersChanged(row.settingEl);
	};
	row.addText((t) => {
		text = t;
		t.setPlaceholder(o.placeholder ?? 'Next to the transcripts').setValue(o.get() ?? '');
		t.inputEl.setAttr('aria-label', o.name);
		t.inputEl.setAttr('spellcheck', 'false');
		// Saved when you leave the field or press Enter, so half-typed paths never become folders.
		t.inputEl.addEventListener('change', () => void commit(t.getValue()));
		t.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') t.inputEl.blur();
		});
		t.inputEl.addEventListener('input', () => {
			if (t.inputEl.hasClass('is-invalid') && (!t.getValue().trim() || cleanFolder(t.getValue()))) {
				t.inputEl.removeClass('is-invalid');
				describe();
			}
		});
		new FolderSuggest(ctx.app, t.inputEl, (path) => void commit(path));
	});
	row.addExtraButton((b) => {
		reset = b.extraSettingsEl;
		b.setIcon('rotate-ccw')
			.setTooltip(o.resetTo ? `Back to ${o.resetTo}` : 'Keep the raw files next to the transcripts')
			.onClick(() => void commit(o.resetTo ?? ''));
		reset.toggleClass('ccs-invisible', (o.get() ?? '') === (o.resetTo ?? ''));
	});
	let browse: HTMLElement | null = null;
	row.addButton((b) => {
		browse = b.buttonEl;
		b.setButtonText('Browse…')
			.setTooltip('Pick a folder in the vault with the system folder dialog')
			.onClick(async () => {
				const r = browseForVaultFolder(ctx.app, o.get() ?? '', `Choose the ${o.name.toLowerCase()}`);
				if (!r.ok) {
					const msg = BROWSE_MESSAGES[r.reason];
					if (msg) new Notice(msg, 8000);
					return;
				}
				await commit(r.path);
			});
	});
	if (o.toggle) {
		const t = o.toggle;
		const show = () => {
			const on = t.get();
			for (const e of [text?.inputEl, browse, reset]) e?.toggleClass('ccs-hidden', !on);
		};
		row.addToggle((tg) =>
			tg.setValue(t.get()).onChange(async (v) => {
				t.set(v);
				show();
				describe();
				await ctx.plugin.saveSettings();
				foldersChanged(row.settingEl);
			}),
		);
		show();
	}
	describe();
	el.addEventListener(FOLDERS_CHANGED, () => {
		if (!row.settingEl.isConnected || text?.inputEl.hasClass('is-invalid')) return;
		describe();
	});
}

/**
 * Shown only while raw files saved earlier are not where the JSON folders above say: one
 * button moves them there. Recounts whenever a folder setting in this panel is committed.
 */
export function rawMoveRow(ctx: PanelContext, el: HTMLElement, plan: () => RawMove[], noun = 'JSON file'): void {
	const holder = el.createDiv({ cls: 'ccs-raw-move' });
	let running = false;
	const draw = () => {
		holder.empty();
		const moves = plan();
		if (!moves.length) return;
		const n = moves.length;
		const row = new Setting(holder)
			.setName(`${count(n, noun)} in the old place`)
			.setDesc(`Saved before the current folder choice. Moving keeps the file names, and links and the sync history follow. Transcripts and downloaded files stay where they are.`);
		row.settingEl.addClass('ccs-sub-setting', 'ccs-raw-move-row');
		const icon = createSpan({ cls: 'ccs-glyph ccs-raw-move-icon', attr: { 'aria-hidden': 'true' } });
		setIcon(icon, 'folder-input');
		row.nameEl.prepend(icon);
		row.addButton((b) =>
			b.setButtonText(`Move ${count(n, 'file')}`).onClick(() => {
				if (ctx.plugin.busy) {
					new Notice('A sync is running. Move the files once it has finished.');
					return;
				}
				const first = moves[0]!;
				const example = `For example ${first.from.split('/').pop()} goes to ${first.to.split('/').slice(0, -1).join('/')}.`;
				new ConfirmModal(
					ctx.app,
					`Move ${count(n, noun)}?`,
					`${n === 1 ? 'It goes' : 'They go'} where the folder settings say today. ${example}`,
					`Move ${count(n, 'file')}`,
					async () => {
						if (running) return;
						running = true;
						b.setDisabled(true).setButtonText('Moving…');
						try {
							const r = await moveRawFiles(ctx.app, ctx.plugin.settings, plan(), () => ctx.plugin.saveSettings());
							new Notice(`Moved ${count(r.moved, 'file')}.${r.skipped.length ? ` ${count(r.skipped.length, 'file')} stayed: the new place was taken or the file was gone.` : ''}`);
						} catch (e) {
							new Notice(`Could not move every file: ${e instanceof Error ? e.message : String(e)}`, 10_000);
						} finally {
							running = false;
							foldersChanged(holder); // redraws this row and the folder notes above
						}
					},
					'cta',
				).open();
			}),
		);
	};
	el.addEventListener(FOLDERS_CHANGED, () => {
		if (!running) draw();
	});
	draw();
}

/** A collapsed section for settings most people never touch. */
export function advanced(ctx: PanelContext, el: HTMLElement, key: string, title = 'Advanced'): HTMLElement {
	const details = el.createEl('details', { cls: 'ccs-advanced' });
	details.open = ctx.openSections.has(key);
	details.createEl('summary', { text: title });
	details.addEventListener('toggle', () => {
		if (details.open) ctx.openSections.add(key);
		else ctx.openSections.delete(key);
	});
	return details.createDiv();
}

export interface ProjectOptions {
	projectSubfolders: boolean;
	recentFolderName: string;
	downloadFiles: boolean;
	onlyProjects: boolean;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	customProjectFolders?: boolean;
	projectFolders?: Record<string, string>;
	projectRawFolders?: Record<string, string>;
}

/** How chats are filed. */
export function filingOptions(ctx: PanelContext, el: HTMLElement, site: string, o: Pick<ProjectOptions, 'projectSubfolders' | 'recentFolderName'>): void {
	const save = () => ctx.plugin.saveSettings();
	new Setting(el)
		.setName('Use project subfolders')
		.setDesc(`One subfolder per ${site} project.`)
		.addToggle((t) =>
			t.setValue(o.projectSubfolders).onChange(async (v) => {
				o.projectSubfolders = v;
				await save();
			}),
		);
	new Setting(el)
		.setName('Folder for chats without a project')
		.setDesc('A plain folder name.')
		.addText((t) =>
			t.setPlaceholder('Recent').setValue(o.recentFolderName).onChange(async (v) => {
				const name = v.trim();
				if (!name || /[\\/]/.test(name) || name.startsWith('.')) return; // a plain folder name only
				o.recentFolderName = name;
				await save();
			}),
		);
}

/** What gets synced. */
export function contentOptions(ctx: PanelContext, el: HTMLElement, provider: Provider, account: AnyAccount, o: ProjectOptions): void {
	const save = () => ctx.plugin.saveSettings();
	new Setting(el)
		.setName('Download files and images')
		.setDesc('Files the AI created go to Artifacts/, files you uploaded to Attachments/, next to the chat.')
		.addToggle((t) =>
			t.setValue(o.downloadFiles).onChange(async (v) => {
				o.downloadFiles = v;
				await save();
			}),
		);
	projectFilterOptions(ctx, el, provider, account, o);
}

/** Which projects get synced. */
export function projectFilterOptions(
	ctx: PanelContext,
	el: HTMLElement,
	provider: Provider,
	account: AnyAccount,
	o: Pick<ProjectOptions, 'projectSubfolders' | 'recentFolderName' | 'onlyProjects' | 'projects' | 'projectCatalog' | 'customProjectFolders' | 'projectFolders' | 'projectRawFolders'>,
): void {
	const save = () => ctx.plugin.saveSettings();
	new Setting(el)
		.setName('Only sync selected projects')
		.setDesc('Off syncs every chat. On syncs only what you select below, and new projects stay unselected until you select them.')
		.addToggle((t) =>
			t.setValue(o.onlyProjects).onChange(async (v) => {
				o.onlyProjects = v;
				await save();
				ctx.refresh(); // shows or hides the list
			}),
		);
	if (!o.onlyProjects) return;

	const base = () => ('chatFolder' in account.web ? account.web.chatFolder : account.web.folder);
	const fallback = provider === 'claude'
		? `the chat folder above${o.projectSubfolders ? ', in a subfolder per project' : ''} (Claude Code sessions: the code folder)`
		: `the chat folder above${o.projectSubfolders ? ', in a subfolder per project' : ''}`;
	const perProject = new Setting(el)
		.setName('Choose a folder per project')
		.setDesc(`Give any selected project its own transcript folder and JSON folder in the list below. Projects you leave empty use ${fallback}.`)
		.addToggle((t) =>
			t.setValue(o.customProjectFolders === true).onChange(async (v) => {
				o.customProjectFolders = v;
				await save();
				ctx.refresh(); // shows or hides the folder fields
			}),
		);
	perProject.settingEl.addClass('ccs-sub-setting');

	const rawSetting = () => ('chatFolder' in account.web ? account.web.chatRawFolder : 'rawFolder' in account.web ? account.web.rawFolder : undefined);
	const projectName = (row: { id: string; name: string }) => (row.id === NO_PROJECT ? null : row.name);
	const mdFor = (row: { id: string; name: string }) =>
		plainFolder(o.projectFolders?.[row.id] ?? '') ?? defaultProjectFolder(base(), o.projectSubfolders, projectName(row), o.recentFolderName);
	projectPicker(ctx, el, provider, account, o, o.customProjectFolders
		? {
			defaultFor: (row) => defaultProjectFolder(base(), o.projectSubfolders, projectName(row), o.recentFolderName),
			rawDefaultFor: (row) => {
				const md = mdFor(row);
				const raw = projectRawDefault(md, rawSetting(), o.projectSubfolders, projectName(row), o.recentFolderName, masterRaw(ctx.plugin.settings));
				return raw === md ? null : raw;
			},
		}
		: undefined);
}
