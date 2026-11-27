// The only places the Browser link may reach. Shared by the plugin and the browser extension:
// both sides refuse anything else, so a stolen pairing cannot turn the link into a proxy.
// Plain data and pure functions only (the extension imports this file too).

/**
 * The local page Obsidian opens in your browser to bring up the extension's own page:
 * http://127.0.0.1:<port><LINK_OPEN_PATH>. The extension sees it load and switches the tab.
 */
export const LINK_OPEN_PATH = '/chatbridge-browser-link';

/** True for that local page (any port: before pairing the extension does not know the port yet). */
export function isLinkOpenPage(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const u = new URL(url);
		return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === LINK_OPEN_PATH;
	} catch {
		return false;
	}
}

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

/**
 * Pictures Gemini made (lh3.googleusercontent.com/gg/… and /rd-gg/…). They open only with the
 * Google login; the extension fetches them itself (host permission), since a page of the site
 * may not read them across sites. GET only; nothing else on that host.
 */
export const LINK_IMAGE_ORIGIN = 'https://lh3.googleusercontent.com';

export function isLinkImage(url: string): boolean {
	if (originOf(url) !== LINK_IMAGE_ORIGIN) return false;
	const path = new URL(url).pathname;
	return /^\/(?:gg|rd-gg)\/[\w-]+(?:=[\w-]*)?$/.test(path);
}
