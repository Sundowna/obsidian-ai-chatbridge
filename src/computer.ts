// This computer's name, for the folders that hold sessions stored on it ("Code-Local/Tower").

import { safeTitle } from './naming';

export const UNNAMED_COMPUTER = 'This computer';

/**
 * The computer's own name out of its network name. macOS and Linux report the name with the
 * network's ending ("My-MacBook.local", "tower.fritz.box"), which changes with the
 * network; only the first part is the computer. An IP address is no name at all.
 */
export function hostLabel(hostname: string): string {
	const name = hostname.trim();
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return '';
	return name.split('.')[0] ?? '';
}

/** The computer's network name as a folder name, e.g. "Tower". Never empty. */
export function computerName(): string {
	try {
		const req = typeof window === 'undefined' ? undefined : (window as unknown as { require?: (m: string) => unknown }).require;
		const os = typeof req === 'function' ? (req('os') as { hostname(): string }) : null;
		const name = hostLabel(os?.hostname() ?? '');
		return name ? safeTitle(name) : UNNAMED_COMPUTER;
	} catch {
		return UNNAMED_COMPUTER;
	}
}
