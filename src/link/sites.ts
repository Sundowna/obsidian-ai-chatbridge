// The only places the Browser link may reach. Shared by the plugin and the browser extension:
// both sides refuse anything else, so a stolen pairing cannot turn the link into a proxy.
// Plain data and pure functions only (the extension imports this file too).

/** Sites whose pages the extension may open, and that a request may come from. */
export const LINK_PAGE_ORIGINS = [
	'https://claude.ai',
	'https://chatgpt.com',
	'https://gemini.google.com',
	'https://aistudio.google.com',
] as const;

/** Where a request may go: the sites above, plus AI Studio's API (called from its page). */
export const LINK_TARGET_ORIGINS = [...LINK_PAGE_ORIGINS, 'https://alkalimakersuite-pa.clients6.google.com'] as const;

function originOf(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	// https on the default port only; no user name or password in the address.
	if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null;
	return u.origin;
}

/** A page of a supported site (what the extension may open). */
export function isLinkPage(url: string): boolean {
	const o = originOf(url);
	return o !== null && (LINK_PAGE_ORIGINS as readonly string[]).includes(o);
}

/** An address a request through the link may go to. */
export function isLinkTarget(url: string): boolean {
	const o = originOf(url);
	return o !== null && (LINK_TARGET_ORIGINS as readonly string[]).includes(o);
}

/** The address of a browser extension page (the only origin the plugin accepts a connection from). */
export function isExtensionOrigin(origin: string | undefined): boolean {
	// Chrome, Edge and Brave: 32 letters a–p. Firefox: a UUID per install.
	return !!origin && /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(origin);
}
