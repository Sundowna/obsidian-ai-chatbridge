// Small pieces shared by the settings panels.

import { Notice, Setting, type App, type TextComponent } from 'obsidian';
import type AIChatBridge from '../main';
import type { Provider } from '../login';
import type { AnyAccount } from '../accounts';
import { BROWSE_MESSAGES, browseForVaultFolder } from '../folder-dialog';
import { FolderSuggest } from '../folder-suggest';
import type { ProjectCatalog } from '../project-catalog';
import { cleanFolder } from '../settings';
import { defaultProjectFolder, NO_PROJECT } from '../select';
import { projectPicker } from './project-picker';

export interface PanelContext {
	app: App;
	plugin: AIChatBridge;
	/** Draws the settings again, staying where you are. */
	refresh: () => void;
	openAccount: (provider: Provider, account: AnyAccount) => void;
	/** Collapsible sections that are open, so a redraw leaves them open. */
	openSections: Set<string>;
}

export const count = (n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

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
			new FolderSuggest(ctx.app, t.inputEl, (path) => void save(path));
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
				}),
		);
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
	o: Pick<ProjectOptions, 'projectSubfolders' | 'recentFolderName' | 'onlyProjects' | 'projects' | 'projectCatalog' | 'customProjectFolders' | 'projectFolders'>,
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
		.setDesc(`Give any selected project a folder of its own in the list below. Projects you leave empty use ${fallback}.`)
		.addToggle((t) =>
			t.setValue(o.customProjectFolders === true).onChange(async (v) => {
				o.customProjectFolders = v;
				await save();
				ctx.refresh(); // shows or hides the folder fields
			}),
		);
	perProject.settingEl.addClass('ccs-sub-setting');

	projectPicker(ctx, el, provider, account, o, o.customProjectFolders
		? { defaultFor: (row) => defaultProjectFolder(base(), o.projectSubfolders, row.id === NO_PROJECT ? null : row.name, o.recentFolderName) }
		: undefined);
}
