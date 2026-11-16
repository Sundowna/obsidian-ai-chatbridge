// The system's "Select folder" dialog (Windows Explorer, macOS Finder, the Linux desktop's
// own), the same one Obsidian itself uses (electron.remote.dialog). Only folders INSIDE the
// vault are accepted, because the plugin only writes through Obsidian's vault API.

import { App, FileSystemAdapter } from 'obsidian';
import { hostPlatform, ignoresCase, isWindowsPath, type HostPlatform } from './platform';

interface ElectronDialog {
	showOpenDialogSync(options: {
		title?: string;
		message?: string;
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

/** Forward slashes, no trailing one. A backslash is only a separator in a Windows path. */
function slashes(p: string): string {
	return (isWindowsPath(p) ? p.replace(/\\/g, '/') : p).replace(/\/+$/, '');
}

/** Where the dialog opens: the vault's folder plus the current setting, with the system's own separators. */
export function dialogStartPath(basePath: string, current: string): string {
	const start = current ? `${slashes(basePath)}/${current}` : slashes(basePath);
	return isWindowsPath(basePath) ? start.replace(/\//g, '\\') : start;
}

/** The picked folder as a vault-relative path, or why it can't be used. */
export function vaultRelative(basePath: string, chosen: string, platform: HostPlatform = hostPlatform()): BrowseResult {
	const base = slashes(basePath);
	const abs = slashes(chosen);
	// Windows and macOS treat "Notes" and "notes" as one folder; Linux does not.
	const fold = (p: string) => (ignoresCase(platform) ? p.toLowerCase() : p);
	if (fold(abs) === fold(base)) return { ok: false, reason: 'root' };
	if (!fold(abs).startsWith(`${fold(base)}/`)) return { ok: false, reason: 'outside' };
	const rel = abs.slice(base.length + 1);
	if (rel.split('/').some((part) => part.startsWith('.'))) return { ok: false, reason: 'hidden' };
	return { ok: true, path: rel };
}

/** Opens the system's folder dialog and returns a vault-relative folder path. */
export function browseForVaultFolder(app: App, current: string, title: string): BrowseResult {
	const dialog = nativeDialog();
	const adapter = app.vault.adapter;
	if (!dialog || !(adapter instanceof FileSystemAdapter)) return { ok: false, reason: 'unavailable' };

	const basePath = adapter.getBasePath();
	const picked = dialog.showOpenDialogSync({
		title,
		// macOS shows no title on this dialog, only the message.
		message: title,
		defaultPath: dialogStartPath(basePath, current),
		properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
	});
	const chosen = picked?.[0];
	if (!chosen) return { ok: false, reason: 'cancelled' };
	return vaultRelative(basePath, chosen);
}

export const BROWSE_MESSAGES: Record<Exclude<BrowseResult, { ok: true }>['reason'], string | null> = {
	cancelled: null,
	unavailable: 'The folder dialog is not available here. Type the folder path instead.',
	outside: 'Please pick a folder inside your vault. Files outside it would not be searchable or synced.',
	root: 'Please pick a folder, not the vault itself.',
	hidden: 'Hidden folders (names starting with a dot) cannot be used.',
};
