// One sync of one Google account's Gemini chats: list, read each new or changed chat,
// save it as JSON (readable turns plus Google's rows) and a Markdown transcript.

import { StopError } from '../api';
import { loginRef } from '../accounts';
import type AIChatBridge from '../main';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { cleanFolder, MIN_DELAY_SECONDS, type GeminiAccount } from '../settings';
import { rawBase } from '../raw-folders';
import { pastedSession } from '../cookies';
import { GeminiApi } from './api';
import { emptyResult, failureText, saveChats, writeLog, type GoogleSyncResult } from './save';
import { renderGeminiTranscript } from './transcript';
import type { GeminiListItem } from './types';
import { buildChat, GeminiError } from './wire';

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function runGeminiSync(plugin: AIChatBridge, account: GeminiAccount, progress: ProgressFn = () => undefined): Promise<GoogleSyncResult> {
	const g = account.web;
	const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result = emptyResult();
	let api: GeminiApi | null = null;
	try {
		const folder = cleanFolder(g.folder);
		if (!folder) throw new StopError('The Gemini folder setting is empty or invalid.');
		progress('opening Gemini…');
		const a = await GeminiApi.connect(loginRef('gemini', account), pastedSession(plugin.app, g.secretId));
		api = a;
		const items = await a.listChats(wait, (page) => progress(`reading Gemini chat list… page ${page}`));
		const byId = new Map<string, GeminiListItem>(items.map((it) => [it.uuid, it]));
		await saveChats(plugin, items, g.index, folder, rawBase(g.rawFolder) ?? folder, async (item) => {
			let chat;
			try {
				chat = buildChat(byId.get(item.uuid)!, await a.chatTurns(item.uuid, wait));
			} catch (e) {
				// A chat Google will not open (e.g. deleted meanwhile) is skipped; anything else stops.
				if (e instanceof GeminiError) return null;
				throw e;
			}
			return { createdAt: chat.createdAt, json: JSON.stringify(chat, null, '\t'), md: (name) => renderGeminiTranscript(chat, name) };
		}, progress, result);
	} catch (e) {
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `Gemini's answer could not be verified (${e.message}). Google may have changed it, so nothing more was saved.`;
		else if (e instanceof GeminiError) result.stopped = `Gemini refused the request (${e.message}).`;
		else result.stopped = `Something went wrong while reading Gemini (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	await writeLog(plugin, 'Gemini', account, result);
	return result;
}
