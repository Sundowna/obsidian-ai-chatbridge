// This computer's name, for the folders that hold sessions stored on it ("Code-Local/Tower").

import { safeTitle } from './naming';

export const UNNAMED_COMPUTER = 'This computer';

/** The computer's network name as a folder name, e.g. "Tower". Never empty. */
export function computerName(): string {
	try {
		const req = typeof window === 'undefined' ? undefined : (window as unknown as { require?: (m: string) => unknown }).require;
		const os = typeof req === 'function' ? (req('os') as { hostname(): string }) : null;
		const name = os?.hostname().trim().replace(/\.local$/i, '') ?? '';
		return name ? safeTitle(name) : UNNAMED_COMPUTER;
	} catch {
		return UNNAMED_COMPUTER;
	}
}
