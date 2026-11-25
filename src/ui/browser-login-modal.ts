// The "Use browser login" window for a ChatGPT account: four short steps, one check, then saved.

import { Modal, Notice, Setting, type App } from 'obsidian';
import type AIChatBridge from '../main';
import type { ChatgptAccount } from '../settings';
import { probeAuthSession } from '../chatgpt/api';
import { browserLoginSecretId, browserLoginText, checkBrowserLogin, SESSION_COOKIE_NAME } from '../chatgpt/browser-login';
import { deviceUserAgent, hasLoginWindows, loginUserAgent } from '../login';
import { loginRef } from '../accounts';

export class BrowserLoginModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: AIChatBridge,
		private readonly account: ChatgptAccount,
		private readonly label: string,
		private readonly done: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Use your browser's login – ${this.label}`);
		contentEl.addClass('ccs-browser-login');
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'For accounts made with "Continue with Google": Google does not allow its sign-in inside apps, so sign in in your own browser and bring the login over. Do this on a computer.',
		});

		const steps = contentEl.createEl('ol', { cls: 'ccs-browser-login-steps' });
		const step1 = steps.createEl('li');
		step1.createSpan({ text: 'Open chatgpt.com in your browser and sign in, Google included. ' });
		const open = step1.createEl('button', { text: 'Open chatgpt.com' });
		open.addEventListener('click', () => window.open('https://chatgpt.com/', '_blank'));

		steps.createEl('li', { text: 'On chatgpt.com, press F12. Firefox: Storage → Cookies → https://chatgpt.com. Chrome or Edge: Application → Cookies → https://chatgpt.com.' });

		const step3 = steps.createEl('li');
		step3.createSpan({ text: 'Find the row ' });
		step3.createEl('code', { text: SESSION_COOKIE_NAME });
		step3.createSpan({ text: ' ' });
		const copyName = step3.createEl('button', { text: 'Copy name', attr: { 'aria-label': `Copy the name ${SESSION_COOKIE_NAME}` } });
		copyName.addEventListener('click', () => {
			void navigator.clipboard.writeText(SESSION_COOKIE_NAME).then(() => copyName.setText('Copied'));
		});
		step3.createSpan({ text: ' and paste it in the filter box. Most logins show two rows, ending in .0 and .1.' });

		steps.createEl('li', { text: 'Double-click the Value of each row, copy it, and paste it in the matching box below. Then select "Check and save".' });

		const secretBox = (name: string, desc: string, placeholder: string): HTMLInputElement => {
			let el!: HTMLInputElement;
			new Setting(contentEl).setName(name).setDesc(desc).addText((t) => {
				el = t.inputEl;
				el.type = 'password';
				el.autocomplete = 'off';
				el.spellcheck = false;
				t.setPlaceholder(placeholder);
			});
			return el;
		};
		const first = secretBox('Value of .0', 'Or of the only row, if there is just one. Starts with "eyJ".', 'eyJhbGciOi…');
		const second = secretBox('Value of .1', 'Only if there are two rows. Both are kept in Obsidian\'s secret storage on this computer, never in your vault.', 'Empty if one row…');
		const input = { get value() { return browserLoginText(first.value, second.value); } };
		contentEl.createEl('p', { cls: 'setting-item-description', text: 'If the login window is also signed in, the window wins.' });
		const status = contentEl.createDiv({ cls: 'ccs-browser-login-status', attr: { 'aria-live': 'polite' } });

		const ref = loginRef('chatgpt', this.account);
		const ua = hasLoginWindows() ? loginUserAgent(ref) : deviceUserAgent();
		let busy = false;
		const check = async (button: HTMLButtonElement) => {
			if (busy) return;
			busy = true;
			button.disabled = true;
			button.setText('Checking…');
			status.removeClass('mod-success', 'mod-warning');
			status.setText('Asking chatgpt.com…');
			try {
				const pasted = input.value;
				const r = await checkBrowserLogin(pasted, (cookie) => probeAuthSession(cookie, ua));
				status.setText(r.kind === 'works' ? `✓ ${r.message}` : r.message);
				status.addClass(r.kind === 'works' ? 'mod-success' : 'mod-warning');
				if (r.kind === 'works') {
					const g = this.account.web;
					g.secretId = browserLoginSecretId(g.secretId, this.account.id);
					this.app.secretStorage.setSecret(g.secretId, pasted.trim());
					await this.plugin.saveSettings();
					new Notice(`${this.label}: browser login saved. Sync now uses it.`);
					this.done();
					window.setTimeout(() => this.close(), 1200);
				}
			} finally {
				busy = false;
				button.disabled = false;
				button.setText('Check and save');
			}
		};
		const actions = new Setting(contentEl);
		actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
		actions.addButton((b) => {
			b.setButtonText('Check and save').setCta().onClick(() => void check(b.buttonEl));
			for (const box of [first, second]) {
				box.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void check(b.buttonEl);
				});
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
