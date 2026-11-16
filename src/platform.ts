// Which system Obsidian runs on, and the path habits that differ between them.
// Pure code: the platform can be passed in, so tests cover all three on any computer.

export type HostPlatform = 'win32' | 'darwin' | 'linux';

/** Windows, macOS or Linux (anything else counts as Linux). Null-safe on mobile, where there is no `process`. */
export function hostPlatform(): HostPlatform {
	const p = typeof process === 'undefined' ? '' : process.platform;
	return p === 'win32' || p === 'darwin' ? p : 'linux';
}

/** "C:\…", "C:/…" or a network share "\\server\…". */
export const isWindowsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);

/**
 * "~" and "~/…" as the home folder, the way a shell reads them on macOS and Linux.
 * Everything else comes back unchanged ("~name" is another user's home; we don't guess it).
 */
export function expandHome(p: string, home: string): string {
	const t = p.trim();
	if (!home || !/^~(?=$|[\\/])/.test(t)) return t;
	return `${home.replace(/[\\/]+$/, '')}${t.slice(1)}`;
}

/** Whether file names differing only in case are the same file: yes on Windows and macOS, no on Linux. */
export const ignoresCase = (platform: HostPlatform = hostPlatform()): boolean => platform !== 'linux';
