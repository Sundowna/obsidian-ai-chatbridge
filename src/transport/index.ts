// Picks how an account reaches its site. Today always the login window; the Browser link
// (per account setting) is added in a later step. Lumo stays on the login window for good.

import type { LoginRef } from '../login';
import { LoginWindowTransport } from './login-window';
import type { Transport } from './types';

export type { PageAnswer, PageCall, PageSigning, ReadyCheck, SitePage, SiteRequest, Transport, TransportKind } from './types';

export function transportFor(login: LoginRef): Transport {
	return new LoginWindowTransport(login);
}
