// Which login an account reads, checked on every sync. An account remembers the login it was
// first synced with (an account number from the site, not secret, and its email where the site
// gives one). Then:
//  - another plugin account already holds that login: stop (the same login twice would save
//    every chat twice);
//  - the site now shows a different login (the Browser link's browser was switched to another
//    account, or someone else logged in to the login window): skip, saying who is logged in and
//    who this account expects, so nothing of the other login is saved here.
// Pure: no Obsidian, no requests.

import { StopError } from './api';
import { BrowserLinkUnavailable } from './link/errors';

export interface SeenLogin {
	/** The site's own number for the logged-in user (claude.ai user ID, ChatGPT user, Google account number). */
	id: string;
	email?: string;
}

export interface BoundLogin {
	loginUser?: string;
	loginEmail?: string;
}

const who = (email: string | undefined, fallback: string): string => (email ? email : fallback);

/**
 * Checks `seen` against what `bound` remembers and what the `others` hold. Binds it the first
 * time (returns true: save settings). Throws StopError for the same login twice, and for another
 * login: BrowserLinkUnavailable ("skipped") through the Browser link, StopError in the login window.
 */
export function checkLogin(site: string, bound: BoundLogin, seen: SeenLogin, others: readonly { label: string; web: BoundLogin }[], viaBrowser: boolean): boolean {
	const twin = others.find((o) => o.web.loginUser === seen.id);
	if (twin) throw new StopError(`This login (${who(seen.email, 'the same user')}) is already used by the account "${twin.label}". Nothing was saved. Log this account in to the ${site} account it is meant for${viaBrowser ? ' (with the Browser link: choose another browser or browser profile for it)' : ''}, or remove it.`);
	if (bound.loginUser && bound.loginUser !== seen.id) {
		const message = `${viaBrowser ? 'Your browser is' : 'The login window is'} logged in to ${site} as ${who(seen.email, 'another user')}, but this account belongs to ${who(bound.loginEmail, 'another user')}. Nothing was saved. ${viaBrowser ? 'Switch the browser to that account (or choose its own browser for this account) and sync again.' : 'Log in again with that account.'} If the new login is right, select "Accept this login" in the account's settings.`;
		if (viaBrowser) throw new BrowserLinkUnavailable('other-login', site, message);
		throw new StopError(message);
	}
	let changed = false;
	if (bound.loginUser !== seen.id) {
		bound.loginUser = seen.id;
		changed = true;
	}
	if (seen.email && bound.loginEmail !== seen.email) {
		bound.loginEmail = seen.email;
		changed = true;
	}
	return changed;
}

/** "Accept this login": forgets the remembered login; the next sync takes the one there. */
export function forgetLogin(bound: BoundLogin): void {
	delete bound.loginUser;
	delete bound.loginEmail;
}
