// Fetches an account's projects for the picker in the settings. Reads the same lists a sync
// reads, through the same API classes, and saves only names, IDs and chat counts.

import type AIChatBridge from './main';
import { loginRef, SITE_LABEL, type AnyAccount } from './accounts';
import { ClaudeApi, StopError } from './api';
import { GptApi, pastedSession } from './chatgpt/api';
import { GptRateLimitError } from './chatgpt/recovery';
import { listAllGptProjects } from './chatgpt/sync';
import { claudeAuth } from './claude-auth';
import type { Provider } from './login';
import { LumoApi } from './lumo/api';
import { decryptListing } from './lumo/chat';
import { allSpaces } from './lumo/sync';
import { markNew, rowsFromChats, rowsFromProjects, type CatalogRow, type ProjectCatalog } from './project-catalog';
import { ShapeError } from './schema';
import { MIN_DELAY_SECONDS, type ChatgptAccount, type ClaudeAccount, type LumoAccount } from './settings';
import { listAllChats } from './sync';

type Status = (text: string) => void;

interface Found {
	rows: CatalogRow[];
	note?: string;
}

async function claudeRows(plugin: AIChatBridge, account: ClaudeAccount, delayMs: number, status: Status): Promise<Found> {
	const auth = await claudeAuth(plugin, account);
	if (auth.source === 'none') throw new StopError('Not logged in to claude.ai. Select "Log in" above first.');
	return { rows: rowsFromChats(await listAllChats(new ClaudeApi(auth.orgId, auth.getKey), delayMs, status)) };
}

async function chatgptRows(plugin: AIChatBridge, account: ChatgptAccount, delayMs: number, status: Status): Promise<Found> {
	const g = account.web;
	const until = g.cooldownUntil ?? 0;
	if (until > Date.now()) throw new StopError(`ChatGPT is cooling down until ${new Date(until).toLocaleTimeString()}. Try again after that.`);
	status('connecting to ChatGPT…');
	try {
		const api = await GptApi.connect(loginRef('chatgpt', account), pastedSession(plugin.app, g.secretId));
		const wait = () => new Promise((r) => window.setTimeout(r, delayMs));
		const { projects, cut } = await listAllGptProjects(api, wait, (page) => status(`reading project list… page ${page}`));
		return { rows: rowsFromProjects(projects), ...(cut ? { note: 'ChatGPT did not finish listing, so some projects may be missing.' } : {}) };
	} catch (e) {
		if (e instanceof GptRateLimitError) {
			// The next sync has to respect this too.
			g.cooldownUntil = e.until;
			await plugin.saveSettings();
		}
		throw e;
	}
}

async function lumoRows(account: LumoAccount, delayMs: number, status: Status): Promise<Found> {
	status('unlocking Lumo…');
	const api = await LumoApi.connect(loginRef('lumo', account));
	try {
		const wait = async (): Promise<void> => {
			await new Promise((r) => window.setTimeout(r, delayMs));
		};
		const listing = await decryptListing(await allSpaces(api, wait, status), api.masterKeys);
		if (listing.failed && !listing.entries.length) throw new StopError(`Could not decrypt any of ${listing.failed} Lumo chats.`);
		return { rows: rowsFromChats(listing.entries.map((e) => e.item), listing.projects), ...(listing.failed ? { note: `${listing.failed} chats could not be decrypted, so their projects may be missing.` } : {}) };
	} finally {
		api.close();
	}
}

/** Fetches the account's project list; the caller decides what to keep. Never runs alongside a sync. */
export async function fetchProjectCatalog(plugin: AIChatBridge, provider: Provider, account: AnyAccount, status: Status): Promise<ProjectCatalog> {
	return plugin.exclusive(async () => {
		const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
		const found = provider === 'claude' ? await claudeRows(plugin, account as ClaudeAccount, delayMs, status)
			: provider === 'chatgpt' ? await chatgptRows(plugin, account as ChatgptAccount, delayMs, status)
			: await lumoRows(account as LumoAccount, delayMs, status);
		// Lumo keeps only selected names, so a saved list cannot tell what is new.
		const previous = provider === 'lumo' ? undefined : (account.web as { projectCatalog?: ProjectCatalog }).projectCatalog;
		return { fetchedAt: new Date().toISOString(), rows: markNew(found.rows, previous), ...(found.note ? { note: found.note } : {}) };
	});
}

/** What to show when a fetch fails. Only StopError texts, which are cleaned of secrets, are shown as they are. */
export function fetchFailure(e: unknown, provider: Provider): string {
	if (e instanceof StopError) return e.message;
	if (e instanceof ShapeError) return `${SITE_LABEL[provider]} answered in an unexpected format, so the list was not updated.`;
	return `Could not read the project list (${e instanceof Error ? e.name : 'unknown error'}).`;
}
