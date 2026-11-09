// The ONLY place that talks to lumo.proton.me.
// Rules: GET only, only the addresses below, no retries, stop on anything odd.
// Requests run inside a hidden window of the account's own login, so Proton's site handles
// its own cookies and session refresh. Lumo's chats are end-to-end encrypted: opening them
// takes the account's keys, which are unlocked here for one sync and kept in memory only.

import { StopError } from '../api';
import { isLoggedIn, openHiddenPage, type HiddenPage, type LoginRef } from '../login';
import { sessionKeyPassword, openMasterKeys, unlockUserKeys } from './keys';
import { checkClientKey, checkConversation, checkFullMessage, checkMasterKeys, checkSpaces, checkUser, parseStoredSession } from './schema';
import type { LumoWireConversation, LumoWireMessage, LumoWireSpace } from './types';

const ORIGIN = 'https://lumo.proton.me';
const API_URLS = `${ORIGIN}/api/*`;
/** A 200 from one of these means the page has a working session. */
const SESSION_READY = /^\/api\/(auth\/v4\/sessions\/local\/key|core\/v4\/users|lumo\/v1\/)/;
const OPEN_TIMEOUT_MS = 45_000;

const LOCAL_KEY = '/api/auth/v4/sessions/local/key';
const USER = '/api/core/v4/users';
const MASTER_KEYS = '/api/lumo/v1/masterkeys';
const SPACES = '/api/lumo/v1/spaces';

const ALLOWED = [
	/^\/api\/auth\/v4\/sessions\/local\/key$/,
	/^\/api\/core\/v4\/users$/,
	/^\/api\/lumo\/v1\/masterkeys$/,
	/^\/api\/lumo\/v1\/spaces$/,
	/^\/api\/lumo\/v1\/conversations\/[\w=-]{1,200}$/,
	/^\/api\/lumo\/v1\/messages\/[\w=-]{1,200}$/,
];

const READ_SESSIONS = `JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('ps-')).map((k) => localStorage.getItem(k)))`;

function checkId(id: string): string {
	if (!/^[\w=-]{1,200}$/.test(id)) throw new StopError('Refusing to fetch: Lumo ID has an odd format.');
	return id;
}

export class LumoApi {
	userId = '';
	masterKeys: CryptoKey[] = [];

	private constructor(private readonly page: HiddenPage) {}

	/** Opens Lumo with this account's login and unlocks its chats. Close it when done. */
	static async connect(login: LoginRef): Promise<LumoApi> {
		if (!(await isLoggedIn(login))) throw new StopError('Not logged in to Lumo. Select "Log in" for this account in the plugin settings.');
		const page = await openHiddenPage(login, `${ORIGIN}/`, API_URLS, SESSION_READY, OPEN_TIMEOUT_MS);
		if (!page) throw new StopError('Lumo did not finish opening. Log in again in the plugin settings, with "Keep me signed in" on.');
		const api = new LumoApi(page);
		try {
			await api.unlock();
			return api;
		} catch (e) {
			api.close();
			throw e;
		}
	}

	private async unlock(): Promise<void> {
		const rows = JSON.parse(await this.page.run(READ_SESSIONS)) as (string | null)[];
		const session = rows.flatMap((row) => (row ? parseStoredSession(row) ?? [] : [])).find((s) => s.UID === this.page.uid);
		if (!session) throw new StopError('Lumo opened without an account. Log in again in the plugin settings.');
		const keyPassword = await sessionKeyPassword(session, checkClientKey(await this.get(LOCAL_KEY)));
		const user = checkUser(await this.get(USER));
		this.userId = user.id;
		const userKeys = await unlockUserKeys(user.keys, keyPassword);
		if (!userKeys.length) throw new StopError('Could not unlock this Proton account\'s keys. Log in to Lumo again.');
		const rowsOfKeys = checkMasterKeys(await this.get(MASTER_KEYS));
		this.masterKeys = await openMasterKeys(rowsOfKeys, userKeys);
		if (rowsOfKeys.length && !this.masterKeys.length) throw new StopError('Could not open this account\'s Lumo key. Lumo may have changed how it stores keys.');
	}

	close(): void {
		this.masterKeys = [];
		this.page.close();
	}

	/** One page of spaces, each with its conversations, newest first. */
	async spaces(createdBeforeSeconds?: number): Promise<LumoWireSpace[]> {
		return checkSpaces(await this.get(createdBeforeSeconds === undefined ? SPACES : `${SPACES}?CreateTimeUntil=${createdBeforeSeconds}`));
	}

	async conversation(id: string): Promise<LumoWireConversation> {
		return checkConversation(await this.get(`/api/lumo/v1/conversations/${checkId(id)}`));
	}

	async message(id: string): Promise<LumoWireMessage> {
		return checkFullMessage(await this.get(`/api/lumo/v1/messages/${checkId(id)}`));
	}

	/** The single GET used by everything above. */
	private async get(path: string): Promise<unknown> {
		const url = new URL(path, ORIGIN);
		if (url.origin !== ORIGIN || !ALLOWED.some((re) => re.test(url.pathname))) {
			throw new StopError('Blocked a request to a Lumo address the plugin does not use.');
		}
		const headers = { Accept: 'application/vnd.protonmail.v1+json', 'x-pm-uid': this.page.uid, 'x-pm-appversion': this.page.appVersion };
		const code = `(async () => { const r = await fetch(${JSON.stringify(url.pathname + url.search)}, { credentials: 'same-origin', headers: ${JSON.stringify(headers)} }); return JSON.stringify({ status: r.status, text: await r.text() }); })()`;
		let res: { status: number; text: string };
		try {
			res = JSON.parse(await this.page.run(code)) as { status: number; text: string };
		} catch {
			throw new StopError('Network error while talking to Lumo.');
		}
		if (res.status === 401) throw new StopError('Lumo answered 401 (not logged in). Log in to Lumo again in the plugin settings.');
		if (res.status === 403) throw new StopError('Lumo answered 403 (forbidden). Log in to Lumo again in the plugin settings.');
		if (res.status === 429) throw new StopError('Lumo is rate limiting this account. Try again later.');
		let body: unknown;
		try {
			body = JSON.parse(res.text);
		} catch {
			throw new StopError(`Lumo answered ${res.status} without valid JSON, so the sync stopped.`);
		}
		if (res.status !== 200) {
			const why = (body as { Error?: unknown } | null)?.Error;
			throw new StopError(`Lumo answered ${res.status}, so the sync stopped.${typeof why === 'string' ? ` Its explanation: ${why.slice(0, 200)}` : ''}`);
		}
		return body;
	}
}
