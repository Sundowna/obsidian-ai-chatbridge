// Why a Browser link account could not be reached. A sync treats this as "skipped" (with the
// message), not as an error: one closed browser must not stop the other accounts or pause
// automatic sync. Messages never hold tokens, codes, addresses with queries or answer text.

export type LinkUnavailableReason = 'not-paired' | 'browser-closed' | 'not-logged-in' | 'tab-failed' | 'other-login';

const MESSAGES: Record<LinkUnavailableReason, string> = {
	'not-paired': 'The Browser link is not paired yet. Pair your browser in the plugin settings.',
	'browser-closed': 'Your browser is closed, or the ChatBridge extension is off. Open the browser and sync again.',
	'not-logged-in': 'Not logged in to this site in your browser. Log in there and sync again.',
	'tab-failed': 'The browser could not open the site. Check that it loads in your browser and sync again.',
	'other-login': 'Your browser is logged in to another account of this site. Switch it to this account and sync again.',
};

export class BrowserLinkUnavailable extends Error {
	/** `detail`: a fuller message for the reason (who is logged in, who was expected). */
	constructor(readonly reason: LinkUnavailableReason, site?: string, detail?: string) {
		super(detail ?? (reason === 'not-logged-in' && site ? `Not logged in to ${site} in your browser. Log in there and sync again.` : MESSAGES[reason]));
		this.name = 'BrowserLinkUnavailable';
	}
}

/** The browser refused or failed a request for another reason (shown, then the sync stops as usual). */
export class BrowserLinkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserLinkError';
	}
}
