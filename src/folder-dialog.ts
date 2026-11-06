// Native Windows "Select folder" dialog, the same one Obsidian itself uses
// (electron.remote.dialog). Only folders INSIDE the vault are accepted, because
// the plugin only writes through Obsidian's vault API.

import { App, FileSystemAdapter } from 'obsidian';

interface ElectronDialog {
	showOpenDialogSync(options: {
		title?: string;
		defaultPath?: string;
		properties?: string[];
	}): string[] | undefined;
}

function nativeDialog(): ElectronDialog | null {
	const w = window as unknown as { electron?: { remote?: { dialog?: ElectronDialog } } };
	const d = w.electron?.remote?.dialog;
	return d && typeof d.showOpenDialogSync === 'function' ? d : null;
}

export type BrowseResult =
	| { ok: true; path: string }
	| { ok: false; reason: 'cancelled' | 'unavailable' | 'outside' | 'root' | 'hidden' };

function slashes(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Opens the Windows folder dialog and returns a vault-relative folder path. */
export function browseForVaultFolder(app: App, current: string, title: string): BrowseResult {
	const dialog = nativeDialog();
	const adapter = app.vault.adapter;
	if (!dialog || !(adapter instanceof FileSystemAdapter)) return { ok: false, reason: 'unavailable' };

	const base = slashes(adapter.getBasePath());
	const start = current ? `${base}/${current}` : base;
	const picked = dialog.showOpenDialogSync({
		title,
		defaultPath: start.replace(/\//g, '\\'),
		properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
	});
	const chosen = picked?.[0];
	if (!chosen) return { ok: false, reason: 'cancelled' };

	const abs = slashes(chosen);
	// Windows paths are case-insensitive.
	if (abs.toLowerCase() === base.toLowerCase()) return { ok: false, reason: 'root' };
	if (!abs.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return { ok: false, reason: 'outside' };
	const rel = abs.slice(base.length + 1);
	if (rel.split('/').some((part) => part.startsWith('.'))) return { ok: false, reason: 'hidden' };
	return { ok: true, path: rel };
}

export const BROWSE_MESSAGES: Record<Exclude<BrowseResult, { ok: true }>['reason'], string | null> = {
	cancelled: null,
	unavailable: 'The Windows folder dialog is not available here. Type the folder path instead.',
	outside: 'Please pick a folder inside your vault. Files outside it would not be searchable or synced.',
	root: 'Please pick a folder, not the vault itself.',
	hidden: 'Hidden folders (names starting with a dot) cannot be used.',
};
