// Picks how an account reaches its site: its login window, or the Browser link (per account
// setting, see link/account.ts). Lumo stays on the login window for good. The plugin tells
// this module once, on load, which accounts use the link and where the link server is.

import type { LinkServer } from '../link/server';
import type { LoginRef } from '../login';
import { BrowserLinkTransport } from './browser-link';
import { LoginWindowTransport } from './login-window';
import type { Transport } from './types';

export type { PageAnswer, PageCall, PageSigning, ReadyCheck, SitePage, SiteRequest, Transport, TransportKind } from './types';

let usesLink: (login: LoginRef) => boolean = () => false;
let linkServer: () => LinkServer | null = () => null;

/** Set by the plugin on load: which logins use the Browser link, and its running server. */
export function setBrowserLink(uses: (login: LoginRef) => boolean, server: () => LinkServer | null): void {
	usesLink = uses;
	linkServer = server;
}

export function transportFor(login: LoginRef): Transport {
	if (login.provider !== 'lumo' && usesLink(login)) return new BrowserLinkTransport(() => linkServer());
	return new LoginWindowTransport(login);
}
