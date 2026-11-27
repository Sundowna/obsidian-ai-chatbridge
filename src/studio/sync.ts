// One sync of one Google account's AI Studio prompts (chats and prompts AI Studio keeps in Drive).

import { StopError } from '../api';
import { loginRef } from '../accounts';
import { tagAccount } from '../naming';
import type AIChatBridge from '../main';
import type { ProgressFn } from '../progress';
import { ShapeError } from '../schema';
import { OddChats, readOrSkip } from '../odd-chats';
import { endCooldown, heldByCooldown, pausedBy } from '../cooldown-run';
import { cleanFolder, MIN_DELAY_SECONDS, type GeminiAccount } from '../settings';
import { masterRaw, mirrorRaw, rawBase } from '../raw-folders';
import { emptyResult, failureText, fileGone, SAME_GOOGLE_LOGIN, sameGoogleLogin, saveChats, studioFromRaw, writeLog, type GoogleSyncResult } from '../gemini/save';
import { renderStudioTranscript } from '../gemini/transcript';
import { pastedSession } from '../cookies';
import { MassMissingError } from '../missing-guard';
import { StudioApi } from './api';
import { BrowserLinkUnavailable } from '../link/errors';
import { listFailed, readList } from '../quick-list';

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function runStudioSync(plugin: AIChatBridge, account: GeminiAccount, progress: ProgressFn = () => undefined): Promise<GoogleSyncResult> {
	const st = account.studio;
	const delayMs = Math.max(MIN_DELAY_SECONDS, plugin.settings.delaySeconds) * 1000;
	const wait = async (): Promise<void> => { await sleep(delayMs); };
	const result = emptyResult();
	let api: StudioApi | null = null;
	try {
		if (heldByCooldown(st, 'AI Studio', result)) {
			await plugin.saveSettings();
			return result;
		}
		const folder = cleanFolder(st.folder);
		if (!folder) throw new StopError('The AI Studio folder setting is empty or invalid.');
		progress('opening AI Studio…');
		const a = await StudioApi.connect(loginRef('gemini', account), pastedSession(plugin.app, account.web.secretId));
		api = a;
		// AI Studio shares the Gemini login: the Google account the Gemini sync found decides.
		const twin = sameGoogleLogin(plugin.settings.gemini, account, account.web.userId);
		if (twin) throw new StopError(SAME_GOOGLE_LOGIN(twin.label));
		const odd = new OddChats();
		// The library list: all of it, or only its recent part when the rest is known (quick-list.ts).
		const list = await readList(st, { scope: 'prompts', fileGone: fileGone(plugin.app, st.index), now: Date.now() },
			(settled) => a.listPrompts(wait, (page) => progress(`reading AI Studio library… page ${page}`), (page) => settled(page, false)));
		if (list.changed) await plugin.saveSettings();
		result.quickList = list.quick;
		const items = list.rows.map((row) => row.item);
		await saveChats(plugin, items, st.index, folder, masterRaw(plugin.settings) !== undefined ? mirrorRaw(folder, masterRaw(plugin.settings)) : rawBase(st.rawFolder) ?? folder, async (item) => {
			// One prompt in an odd shape is skipped and tried again next run; the third one stops the sync.
			const p = await readOrSkip(odd, item.name, () => a.prompt(item.uuid, wait));
			if (!p) return null;
			const created = p.messages.find((m) => m.createdAt)?.createdAt ?? p.updatedAt;
			return { createdAt: created, json: JSON.stringify(p, null, '\t'), md: (name) => tagAccount(renderStudioTranscript(p, name), account.label) };
		}, progress, result, { label: 'AI Studio prompts', fromRaw: studioFromRaw(account.label) });
	} catch (e) {
		const paused = pausedBy(e, st, result);
		// Browser link: the browser is closed, not paired or not logged in. Skipped, not an error.
		const skipped = !paused && e instanceof BrowserLinkUnavailable;
		// After a run that failed, the next one reads the whole library list again (quick-list.ts).
		if (paused || (!skipped && listFailed(st))) await plugin.saveSettings();
		if (paused) { /* waiting for the pause to end, not an error */ }
		else if (skipped) result.linkSkipped = (e as Error).message;
		else if (e instanceof StopError || e instanceof MassMissingError) result.stopped = e.message;
		else if (e instanceof ShapeError) result.stopped = `AI Studio's answer could not be verified (${e.message}). Google may have changed it, so nothing more was saved.`;
		else result.stopped = `Something went wrong while reading AI Studio (${failureText(e)}).`;
	} finally {
		api?.close();
	}
	if (endCooldown(st, result)) await plugin.saveSettings();
	await writeLog(plugin, 'AI Studio', account, result);
	return result;
}
