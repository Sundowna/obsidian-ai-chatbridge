// The checkbox list behind "Only sync selected projects". Each tick saves at once. Only this
// block redraws, so the filter and the scroll position stay where they are.

import { setIcon } from 'obsidian';
import { SITE_LABEL, type AnyAccount } from '../accounts';
import { FolderSuggest } from '../folder-suggest';
import type { Provider } from '../login';
import { isSelected, onlySelected, pickerRows, setRows, type PickerRow, type ProjectCatalog } from '../project-catalog';
import { fetchFailure, fetchProjectCatalog } from '../project-list';
import { DEFAULT_RECENT, plainFolder } from '../select';
import { masterRaw } from '../raw-folders';
import { count, foldersChanged, type PanelContext } from './fields';

export interface PickerOptions {
	recentFolderName: string;
	projects: string[];
	projectCatalog?: ProjectCatalog;
	projectFolders?: Record<string, string>;
	projectRawFolders?: Record<string, string>;
}

/** "Choose a folder per project" is on: each selected row gets a transcript and a JSON folder field. */
export interface FolderChoice {
	/** Where the row's chats go when its field is empty, shown greyed in the field. */
	defaultFor(row: PickerRow): string;
	/** Where the row's raw .json files go when that field is empty; null = next to the transcripts. */
	rawDefaultFor(row: PickerRow): string | null;
}

type FolderKey = 'projectFolders' | 'projectRawFolders';

interface Run {
	status: string;
	listeners: Set<() => void>;
}

// Kept outside the picker, so redrawing the settings during a fetch finds it still running.
const runs = new WeakMap<PickerOptions, Run>();
const failures = new WeakMap<PickerOptions, string>();

// Lumo's project names are end-to-end encrypted there, so data.json gets only the selected
// ones. The full list lives here until the settings close.
const inMemoryOnly = (provider: Provider): boolean => provider === 'lumo';
let lists = new WeakMap<PickerOptions, ProjectCatalog>();
let opened = new WeakSet<PickerOptions>();

/** The settings closed: drop the in-memory lists, and fetch again on the next opening. */
export function forgetProjectLists(): void {
	lists = new WeakMap();
	opened = new WeakSet();
}

const recentOf = (o: PickerOptions): string => o.recentFolderName || DEFAULT_RECENT;
const catalogOf = (provider: Provider, o: PickerOptions): ProjectCatalog | undefined => (inMemoryOnly(provider) ? lists.get(o) : o.projectCatalog);

/** What may be written to data.json, given the current selection. */
function keepSelectedNames(provider: Provider, o: PickerOptions): void {
	if (inMemoryOnly(provider)) o.projectCatalog = onlySelected(lists.get(o), o.projects, recentOf(o));
}

/** Long enough that a short list is not cluttered by a filter box. */
const FILTER_FROM = 8;

function startFetch(ctx: PanelContext, provider: Provider, account: AnyAccount, o: PickerOptions): Run {
	const run: Run = { status: 'Connecting…', listeners: new Set() };
	const notify = () => run.listeners.forEach((l) => l());
	runs.set(o, run);
	failures.delete(o);
	fetchProjectCatalog(ctx.plugin, provider, account, (text) => {
		run.status = text.charAt(0).toUpperCase() + text.slice(1);
		notify();
	})
		.then(async (catalog) => {
			if (inMemoryOnly(provider)) {
				lists.set(o, catalog);
				keepSelectedNames(provider, o);
			} else o.projectCatalog = catalog;
			await ctx.plugin.saveSettings();
		})
		.catch((e: unknown) => failures.set(o, fetchFailure(e, provider)))
		.finally(() => {
			runs.delete(o);
			notify();
		});
	return run;
}

function fetchedAgo(iso: string): string {
	const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
	return `on ${new Date(iso).toLocaleDateString()}`;
}

export function projectPicker(ctx: PanelContext, parent: HTMLElement, provider: Provider, account: AnyAccount, o: PickerOptions, folders?: FolderChoice): void {
	const site = SITE_LABEL[provider];
	const recent = () => recentOf(o);
	const catalogNow = () => catalogOf(provider, o);
	// Until the fetch answers, show what was saved.
	if (inMemoryOnly(provider) && o.projectCatalog && !lists.has(o)) lists.set(o, o.projectCatalog);

	const root = parent.createDiv({ cls: 'ccs-picker' });
	const head = root.createDiv({ cls: 'ccs-picker-head' });
	const summary = head.createDiv({ cls: 'ccs-picker-summary' });
	const countEl = summary.createDiv({ cls: 'ccs-picker-count' });
	const metaEl = summary.createDiv({ cls: 'ccs-picker-meta' });
	const fetchButton = head.createEl('button');
	const statusEl = root.createDiv({ cls: 'ccs-picker-status', attr: { role: 'status', 'aria-live': 'polite' } });
	const tools = root.createDiv({ cls: 'ccs-picker-tools' });
	const filter = tools.createEl('input', { type: 'search', cls: 'ccs-picker-filter', attr: { placeholder: 'Filter projects', 'aria-label': 'Filter projects' } });
	const allButton = tools.createEl('button', { cls: 'ccs-picker-link' });
	const noneButton = tools.createEl('button', { cls: 'ccs-picker-link' });
	const listEl = root.createDiv({ cls: 'ccs-picker-list', attr: { role: 'group', 'aria-label': `${site} projects` } });
	const noMatch = root.createDiv({ cls: 'ccs-picker-empty', text: 'No project matches the filter.' });
	const footEl = root.createDiv({ cls: 'ccs-picker-foot' });

	let rows: PickerRow[] = [];
	const inputs = new Map<string, { row: PickerRow; label: HTMLElement; input: HTMLInputElement; folderEl?: HTMLElement }>();
	const ownFolders = () => rows.filter((r) => isSelected(r, o.projects, recent())
		&& (plainFolder(o.projectFolders?.[r.id] ?? '') || plainFolder(o.projectRawFolders?.[r.id] ?? ''))).length;

	const save = () => {
		keepSelectedNames(provider, o);
		void ctx.plugin.saveSettings();
	};

	const drawCount = () => {
		const chosen = rows.filter((r) => isSelected(r, o.projects, recent())).length;
		const catalog = catalogNow();
		const own = folders ? ownFolders() : 0;
		const ownText = own ? ` · ${own} with ${own === 1 ? 'its' : 'their'} own folder` : '';
		countEl.setText((catalog ? `${chosen} of ${rows.length} selected` : chosen ? `${chosen} selected` : 'No projects loaded yet') + ownText);
		metaEl.setText(catalog ? `Fetched ${fetchedAgo(catalog.fetchedAt)}` : runs.has(o) ? '' : `Select "Fetch projects" to load them from ${site}.`);
		footEl.empty();
		if (!o.projects.some((p) => p.trim())) footEl.createDiv({ cls: 'ccs-picker-warning', text: 'Nothing is selected, so this account will not sync.' });
		if (catalog?.note) footEl.createDiv({ cls: 'ccs-picker-warning', text: catalog.note });
		if (catalog && provider === 'claude') footEl.createDiv({ cls: 'ccs-picker-hint', text: 'Projects without chats are not listed.' });
		if (folders) footEl.createDiv({ cls: 'ccs-picker-hint', text: 'A new folder applies to chats synced from then on. Chats already saved stay where they are; move them in Obsidian and the plugin keeps track. Saved JSON files can be moved with one click under Folders above.' });
	};

	const shown = () => [...inputs.values()].filter(({ label }) => !label.hasClass('ccs-picker-hidden'));

	const drawFilter = () => {
		const q = filter.value.trim().toLowerCase();
		for (const { row, label } of inputs.values()) label.toggleClass('ccs-picker-hidden', !!q && !row.name.toLowerCase().includes(q));
		noMatch.toggleClass('ccs-picker-hidden', !q || shown().length > 0);
		allButton.setText(q ? 'Select shown' : 'Select all');
		noneButton.setText(q ? 'Clear shown' : 'Clear');
	};

	const drawStatus = () => {
		const run = runs.get(o);
		const failure = failures.get(o);
		statusEl.empty();
		if (run) {
			statusEl.createDiv({ text: run.status });
			statusEl.createDiv({ cls: 'ccs-progress is-indeterminate' }).createDiv({ cls: 'ccs-progress-fill' });
		} else if (failure) statusEl.createDiv({ cls: 'ccs-picker-error', text: failure });
		statusEl.toggleClass('ccs-picker-hidden', !run && !failure);
		fetchButton.disabled = !!run;
		fetchButton.setText(run ? 'Fetching…' : catalogNow() ? 'Refresh list' : 'Fetch projects');
		fetchButton.toggleClass('mod-cta', !run && !catalogNow());
	};

	/**
	 * One folder line under a selected row: empty = the default (greyed), saved when you leave
	 * the field. Returns a function that redraws the greyed default.
	 */
	const folderLine = (wrap: HTMLElement, row: PickerRow, key: FolderKey, icon: string, label: string, fallback: () => string, onCommit: () => void): (() => void) => {
		const line = wrap.createDiv({ cls: 'ccs-picker-folder-line' });
		setIcon(line.createSpan({ cls: 'ccs-glyph', attr: { 'aria-hidden': 'true', title: label } }), icon);
		const field = line.createEl('input', {
			type: 'text',
			cls: 'ccs-picker-folder-input',
			attr: { spellcheck: 'false', 'aria-label': `${label} for "${row.name}"` },
		});
		field.value = o[key]?.[row.id] ?? '';
		const reset = line.createEl('button', { cls: 'clickable-icon ccs-picker-folder-reset', attr: { 'aria-label': 'Use the default folder', title: 'Use the default folder' } });
		setIcon(reset, 'rotate-ccw');
		const note = wrap.createDiv({ cls: 'ccs-picker-folder-note', attr: { 'aria-live': 'polite' } });
		const placeholder = () => field.setAttr('placeholder', `${label}: ${fallback()}`);

		const show = () => {
			const typed = field.value.trim();
			const path = plainFolder(typed);
			const bad = typed !== '' && path === null;
			field.toggleClass('is-invalid', bad);
			field.setAttr('aria-invalid', String(bad));
			reset.toggleClass('ccs-picker-hidden', typed === '');
			note.toggleClass('ccs-picker-error', bad);
			note.setText(bad ? `Choose a folder inside the vault, not a hidden one such as ${ctx.app.vault.configDir}.`
				: path && !ctx.app.vault.getFolderByPath(path) ? `New ${key === 'projectRawFolders' ? 'JSON ' : ''}folder: created on the next sync.` : '');
		};
		const commit = (value: string) => {
			const path = plainFolder(value);
			if (value.trim() !== '' && path === null) return show(); // keep the last good folder
			const next = { ...(o[key] ?? {}) };
			if (path) next[row.id] = path;
			else delete next[row.id];
			o[key] = next;
			field.value = path ?? '';
			show();
			save();
			drawCount();
			onCommit();
			foldersChanged(wrap);
		};
		field.addEventListener('input', show);
		field.addEventListener('change', () => commit(field.value)); // leaving the field, or Enter
		field.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') field.blur();
		});
		const suggest = new FolderSuggest(ctx.app, field, (path) => commit(path));
		reset.addEventListener('click', () => {
			commit('');
			// Keep the keyboard here, without opening the folder list.
			field.focus();
			suggest.close();
		});
		placeholder();
		show();
		return placeholder;
	};

	/** The transcript folder and the JSON folder under a selected row. */
	const folderField = (item: HTMLElement, row: PickerRow, choice: FolderChoice): HTMLElement => {
		const wrap = item.createDiv({ cls: 'ccs-picker-folder' });
		let redrawRaw = () => {};
		folderLine(wrap, row, 'projectFolders', 'folder', 'Transcripts', () => choice.defaultFor(row), () => redrawRaw());
		// The JSON default follows the transcript folder when there is no JSON folder above.
		if (masterRaw(ctx.plugin.settings) === undefined) redrawRaw = folderLine(wrap, row, 'projectRawFolders', 'braces', 'JSON', () => choice.rawDefaultFor(row) ?? 'next to the transcripts', () => {});
		return wrap;
	};

	const draw = () => {
		rows = pickerRows(catalogNow(), o.projects, recent());
		inputs.clear();
		listEl.empty();
		for (const row of rows) {
			const item = listEl.createDiv({ cls: 'ccs-picker-item' });
			const label = item.createEl('label', { cls: 'ccs-picker-row' });
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = isSelected(row, o.projects, recent());
			const folderEl = folders ? folderField(item, row, folders) : undefined;
			folderEl?.toggleClass('ccs-picker-hidden', !input.checked);
			input.addEventListener('change', () => {
				o.projects = setRows(o.projects, rows, recent(), [row.id], input.checked);
				folderEl?.toggleClass('ccs-picker-hidden', !input.checked);
				save();
				drawCount();
			});
			label.createSpan({ cls: 'ccs-picker-name', text: row.name, attr: { title: row.name } });
			if (row.isNew) label.createSpan({ cls: 'ccs-picker-tag is-new', text: 'New' });
			if (row.orphan) label.createSpan({ cls: 'ccs-picker-tag', text: 'Not found', attr: { title: `The last fetch did not list this on ${site}. Clear it if it is gone.` } });
			if (row.chats !== undefined) label.createSpan({ cls: 'ccs-picker-chats', text: count(row.chats, 'chat') });
			inputs.set(row.id, { row, label: item, input, folderEl });
		}
		listEl.toggleClass('ccs-picker-hidden', rows.length === 0);
		filter.toggleClass('ccs-picker-hidden', rows.length <= FILTER_FROM);
		if (rows.length <= FILTER_FROM) filter.value = '';
		tools.toggleClass('ccs-picker-hidden', rows.length < 2);
		drawFilter();
		drawCount();
		drawStatus();
	};

	const follow = (run: Run) => {
		const listener = () => {
			if (!root.isConnected) {
				run.listeners.delete(listener);
				return;
			}
			if (runs.get(o) === run) {
				drawStatus();
				return;
			}
			run.listeners.delete(listener);
			draw();
		};
		run.listeners.add(listener);
	};

	const setShown = (on: boolean) => {
		const targets = shown();
		o.projects = setRows(o.projects, rows, recent(), targets.map(({ row }) => row.id), on);
		for (const { input, folderEl } of targets) {
			input.checked = on;
			folderEl?.toggleClass('ccs-picker-hidden', !on);
		}
		save();
		drawCount();
	};

	fetchButton.addEventListener('click', () => {
		follow(startFetch(ctx, provider, account, o));
		drawStatus();
	});
	filter.addEventListener('input', drawFilter);
	allButton.addEventListener('click', () => setShown(true));
	noneButton.addEventListener('click', () => setShown(false));

	// Lumo saves no full list, so it fetches once per opening of the settings. The others
	// only on the button: Claude's list costs a read of every chat. While a sync runs, the
	// next redraw tries instead.
	const refreshNow = inMemoryOnly(provider) && !opened.has(o) && !runs.has(o) && !ctx.plugin.busy;
	if (refreshNow || runs.has(o)) opened.add(o);
	const active = runs.get(o) ?? (refreshNow ? startFetch(ctx, provider, account, o) : undefined);
	if (active) follow(active);
	draw();
}
