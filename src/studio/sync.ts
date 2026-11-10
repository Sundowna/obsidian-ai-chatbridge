// One sync of one Google account's AI Studio prompts (chats and prompts AI Studio keeps in Drive).

import { StopError } from '../api';
import { loginRef } from '../accounts';
import type AIChatBridge from '../main';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { cleanFolder, MIN_DELAY_SECONDS, type GeminiAccount } from '../settings';
import { emptyResult, failureText, saveChats, writeLog, type GoogleSyncResult } from '../gemini/save';
import { renderStudioTranscript } from '../gemini/transcript';
import { StudioApi } from './api';

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function runStudioSync(plugin: AIChatBridge, account: GeminiAccount, progress: ProgressFn = () => undefined): Promise<GoogleSyncResult> {
	const st = account.studio;
	const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result = emptyResult();
	let api: StudioApi | null = null;
	try {
		const folder = cleanFolder(st.folder);
		if (!folder) throw new StopError('The AI Studio folder setting is empty or invalid.');
		progress('opening AI Studio…');
		const a = await StudioApi.connect(loginRef('gemini', account));
		api = a;
		const items = await a.listPrompts(wait, (page) => progress(`reading AI Studio library… page ${page}`));
		await saveChats(plugin, items, st.index, folder, async (item) => {
			const p = await a.prompt(item.uuid, wait);
			if (!p) return null;
			const created = p.messages.find((m) => m.createdAt)?.createdAt ?? p.updatedAt;
			return { createdAt: created, json: JSON.stringify(p, null, '\t'), md: (name) => renderStudioTranscript(p, name) };
		}, progress, result);
	} catch (e) {
		if (e instanceof StopError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `AI Studio's answer could not be verified (${e.message}). Google may have changed it, so nothing more was saved.`;
		else result.stopped = `Something went wrong while reading AI Studio (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	await writeLog(plugin, 'AI Studio', account, result);
	return result;
}
