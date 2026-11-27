// One sync of one Google account's Gemini chats: list, read each new or changed chat,
// save it as JSON (readable turns plus Google's rows) and a Markdown transcript.

import { StopError } from '../api';
import { loginRef } from '../accounts';
import { tagAccount } from '../naming';
import type AIChatBridge from '../main';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { OddChats } from '../odd-chats';
import { endCooldown, heldByCooldown, pausedBy } from '../cooldown-run';
import { cleanFolder, MIN_DELAY_SECONDS, type GeminiAccount } from '../settings';
import { masterRaw, mirrorRaw, rawBase } from '../raw-folders';
import { pastedSession } from '../cookies';
import { MassMissingError } from '../missing-guard';
import { GeminiApi } from './api';
import { emptyResult, failureText, fileGone, geminiFromRaw, SAME_GOOGLE_LOGIN, sameGoogleLogin, saveChats, writeLog, type GoogleSyncResult } from './save';
import { chatPictures, renderGeminiTranscript } from './transcript';
import type { GeminiListItem } from './types';
import { buildChat, GeminiError } from './wire';
import { BrowserLinkUnavailable } from '../link/errors';
import { listFailed, readList } from '../quick-list';
import { checkLogin } from '../login-check';
import { usesBrowserLink } from '../link/account';

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
/** How many Google accounts of one browser are looked through for the right one. */
const MAX_GOOGLE_ACCOUNTS = 6;

export async function runGeminiSync(plugin: AIChatBridge, account: GeminiAccount, progress: ProgressFn = () => undefined): Promise<GoogleSyncResult> {
	const g = account.web;
	const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result = emptyResult();
	let api: GeminiApi | null = null;
	try {
		if (heldByCooldown(g, 'Gemini', result)) {
			await plugin.saveSettings();
			return result;
		}
		const folder = cleanFolder(g.folder);
		if (!folder) throw new StopError('The Gemini folder setting is empty or invalid.');
		progress('opening Gemini…');
		const viaBrowser = usesBrowserLink('gemini', account);
		const connect = (n?: number) => GeminiApi.connect(loginRef('gemini', account), pastedSession(plugin.app, g.secretId), viaBrowser ? n : undefined);
		let a = await connect(g.googleUser);
		api = a;
		let who = await a.accountId();
		// Several Google accounts in the browser (Google's switcher): the one this account belongs to
		// may not be the first. Look through the others once and remember its place.
		if (viaBrowser && g.userId && who && who !== g.userId) {
			const seen = new Set([who]);
			for (let n = 0; n < MAX_GOOGLE_ACCOUNTS; n++) {
				if (n === (g.googleUser ?? 0)) continue;
				progress(`looking for this Google account in your browser… ${n + 1}`);
				let other: GeminiApi;
				try {
					other = await connect(n);
				} catch {
					break; // no Nth account
				}
				const id = await other.accountId();
				if (id === g.userId) {
					a.close();
					a = other;
					api = a;
					who = id;
					g.googleUser = n;
					await plugin.saveSettings();
					break;
				}
				other.close();
				// Google sends a number past the last account back to the first one: stop there.
				if (!id || seen.has(id)) break;
				seen.add(id);
			}
		}
		// The same Google account under two of the plugin's accounts would save every chat twice.
		const twin = sameGoogleLogin(plugin.settings.gemini, account, who);
		if (twin) throw new StopError(SAME_GOOGLE_LOGIN(twin.label));
		// The Google account this account was first synced with; another one in the browser is skipped, not saved here.
		if (who) {
			const bound = { loginUser: g.userId, loginEmail: g.loginEmail };
			const changed = checkLogin('Gemini', bound, { id: who }, [], viaBrowser);
			if (changed || g.userId !== who) {
				g.userId = who;
				await plugin.saveSettings();
			}
		}
		// The chat list: all of it, or only its recent part when the rest is known (quick-list.ts).
		// The pinned chats are a short list of their own, always read whole, so an unpin shows at once.
		const list = await readList(g, { scope: 'chats', fileGone: fileGone(plugin.app, g.index), now: Date.now(), wholeSecond: true },
			(settled) => a.listChats(wait, (page) => progress(`reading Gemini chat list… page ${page}`), settled));
		if (list.changed) await plugin.saveSettings();
		result.quickList = list.quick;
		const items: GeminiListItem[] = list.rows.map((row) => ({ ...row.item, pinned: row.archived !== false }));
		const byId = new Map<string, GeminiListItem>(items.map((it) => [it.uuid, it]));
		const odd = new OddChats();
		await saveChats(plugin, items, g.index, folder, masterRaw(plugin.settings) !== undefined ? mirrorRaw(folder, masterRaw(plugin.settings)) : rawBase(g.rawFolder) ?? folder, async (item) => {
			let chat;
			try {
				chat = buildChat(byId.get(item.uuid)!, await a.chatTurns(item.uuid, wait));
			} catch (e) {
				// A chat Google will not open (e.g. deleted meanwhile) is skipped; anything else stops.
				if (e instanceof GeminiError) return null;
				// One chat Google sends in an odd shape is skipped (and tried again next run); several
				// in one run look like a format change, so the sync stops rather than guess.
				if (odd.skip(e, item.name)) return null;
				throw e;
			}
			return { createdAt: chat.createdAt, json: JSON.stringify(chat, null, '\t'), md: (name, pictures) => tagAccount(renderGeminiTranscript(chat, name, g.showReasoning !== false, pictures), account.label), pictures: chatPictures(chat) };
		}, progress, result, { label: 'Gemini chats', fromRaw: geminiFromRaw(account.label, g.showReasoning !== false), flag: { key: 'pinned', of: (item) => byId.get(item.uuid)?.pinned === true }, ...(g.downloadFiles !== false ? { pictures: (url: string) => a.picture(url) } : {}) });
	} catch (e) {
		const paused = pausedBy(e, g, result);
		// Browser link: the browser is closed, not paired or not logged in. Skipped, not an error.
		const skipped = !paused && e instanceof BrowserLinkUnavailable;
		// After a run that failed, the next one reads the whole chat list again (quick-list.ts).
		if (paused || (!skipped && listFailed(g))) await plugin.saveSettings();
		if (paused) { /* waiting for the pause to end, not an error */ }
		else if (skipped) result.linkSkipped = (e as Error).message;
		else if (e instanceof StopError || e instanceof MassMissingError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Gemini's answer could not be verified (${e.message}). Google may have changed it, so nothing more was saved.`;
		else if (e instanceof GeminiError) result.stopped = `Gemini refused the request (${e.message}).`;
		else result.stopped = `Something went wrong while reading Gemini (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	if (endCooldown(g, result)) await plugin.saveSettings();
	await writeLog(plugin, 'Gemini', account, result);
	return result;
}
