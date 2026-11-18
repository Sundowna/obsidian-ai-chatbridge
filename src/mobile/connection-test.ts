// "Test mobile connection": can this device reach claude.ai and chatgpt.com with the pasted
// logins? One GET each per account, nothing saved, nothing written to the vault.
// Only the pasted logins (secret storage) are used, also on a computer, because a phone has
// nothing else. No secret, and no answer text, is shown or logged.

import { apiVersion, Modal, Notice, Platform, Setting, type App } from 'obsidian';
import type AIChatBridge from '../main';
import { probeOrganizations } from '../api';
import { probeAuthSession } from '../chatgpt/api';
import { fallbackCookie } from '../chatgpt/token';
import { pastedSession } from '../cookies';
import { deviceUserAgent, hasLoginWindows, loginUserAgent } from '../login';
import { noAnswer, passed, readClaude, readGpt, resultText, type ProbeResult } from './probe';

const CLAUDE_URL = 'https://claude.ai/api/organizations';
const GPT_URL = 'https://chatgpt.com/api/auth/session';
const NOTHING_PASTED = 'Nothing pasted on this device. Paste it under Settings → AI ChatBridge → %TAB% → Advanced, then run the test again.';

async function testClaude(plugin: AIChatBridge): Promise<ProbeResult[]> {
	const out: ProbeResult[] = [];
	for (const account of plugin.settings.claude) {
		const key = pastedSession(plugin.app, account.web.secretId)?.trim() ?? '';
		if (!key) out.push(noAnswer('claude.ai', CLAUDE_URL, account.label, NOTHING_PASTED.replace('%TAB%', 'Claude'), false));
		else if (/[\s;]/.test(key)) out.push(noAnswer('claude.ai', CLAUDE_URL, account.label, 'The pasted session key does not look right: paste only the value of the "sessionKey" cookie.', false));
		else {
			try {
				out.push(readClaude(account.label, await probeOrganizations(key)));
			} catch (e) {
				out.push(noAnswer('claude.ai', CLAUDE_URL, account.label, e instanceof Error ? e.message : 'The request failed.', true));
			}
		}
	}
	return out;
}

async function testGpt(plugin: AIChatBridge, ua: string): Promise<ProbeResult[]> {
	const out: ProbeResult[] = [];
	for (const account of plugin.settings.chatgpt) {
		const pasted = pastedSession(plugin.app, account.web.secretId);
		const cookie = pasted ? fallbackCookie(pasted) : null;
		if (!pasted) out.push(noAnswer('chatgpt.com', GPT_URL, account.label, NOTHING_PASTED.replace('%TAB%', 'ChatGPT'), false));
		else if (!cookie) out.push(noAnswer('chatgpt.com', GPT_URL, account.label, 'The pasted session cookie does not look right: paste the value of "__Secure-next-auth.session-token", or the whole Cookie header.', false));
		else {
			try {
				out.push(readGpt(account.label, await probeAuthSession(cookie, ua)));
			} catch (e) {
				out.push(noAnswer('chatgpt.com', GPT_URL, account.label, e instanceof Error ? e.message : 'The request failed.', true));
			}
		}
	}
	return out;
}

function deviceLine(): string {
	const kind = Platform.isAndroidApp ? 'Android app' : Platform.isIosApp ? 'iOS app' : Platform.isMobile ? 'computer, shown as mobile' : 'computer';
	return `Device: ${kind}, Obsidian API ${apiVersion}`;
}

/** Runs the test and returns the whole report as text. */
export async function connectionReport(plugin: AIChatBridge): Promise<{ text: string; results: ProbeResult[] }> {
	// The name ChatGPT requests carry: the login window's on a computer, the app's own elsewhere.
	const first = plugin.settings.chatgpt[0];
	const ua = hasLoginWindows() && first ? loginUserAgent({ provider: 'chatgpt', id: first.id }) : deviceUserAgent();
	const results = [...(await testClaude(plugin)), ...(await testGpt(plugin, ua))];
	const text = [
		`AI ChatBridge ${plugin.manifest.version}: mobile connection test, ${new Date().toISOString()}`,
		deviceLine(),
		`Browser name sent to chatgpt.com: ${ua}`,
		'',
		...results.map(resultText),
		'',
		results.some((r) => r.login !== 'not tested') ? `Result: ${results.filter(passed).length} of ${results.filter((r) => r.login !== 'not tested').length} tested logins passed.` : 'Result: nothing was tested.',
	].join('\n');
	return { text, results };
}

class ReportModal extends Modal {
	constructor(app: App, private readonly text: string) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Mobile connection test');
		this.contentEl.createEl('pre', { text: this.text, cls: 'ccs-report' });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText('Copy').setCta().onClick(async () => {
					try {
						await navigator.clipboard.writeText(this.text);
						new Notice('Copied.');
					} catch {
						new Notice('Could not copy. Select the text instead.');
					}
				}),
			)
			.addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

let testing = false;

export async function testMobileConnection(plugin: AIChatBridge): Promise<void> {
	if (testing) return;
	testing = true;
	const notice = new Notice('AI ChatBridge: testing the connection…', 0);
	try {
		const { text } = await connectionReport(plugin);
		// For chrome://inspect on a phone. The report holds no secret and no answer text.
		console.debug(text);
		new ReportModal(plugin.app, text).open();
	} catch (e) {
		new Notice(`The connection test could not run: ${e instanceof Error ? e.message : 'unknown error'}`, 10_000);
	} finally {
		notice.hide();
		testing = false;
	}
}
