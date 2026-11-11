// The two small dialogs the account settings need.

import { Modal, Setting, TextComponent, type App } from 'obsidian';

interface NameOptions {
	title: string;
	hint: string;
	action: string;
	initial?: string;
	problem: (name: string) => string | null;
	submit: (name: string) => void | Promise<void>;
}

export class NameModal extends Modal {
	constructor(app: App, private readonly options: NameOptions) {
		super(app);
	}

	onOpen(): void {
		const o = this.options;
		this.titleEl.setText(o.title);
		this.contentEl.createEl('p', { text: o.hint, cls: 'setting-item-description' });
		const input = new TextComponent(this.contentEl).setValue(o.initial ?? '').setPlaceholder('Work');
		input.inputEl.addClass('ccs-name-input');
		const error = this.contentEl.createDiv({ cls: 'ccs-name-error' });
		const submit = async () => {
			const problem = o.problem(input.getValue());
			error.setText(problem ?? '');
			if (problem) return;
			await o.submit(input.getValue().trim());
			this.close();
		};
		input.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void submit();
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText(o.action).setCta().onClick(() => void submit()));
		input.inputEl.focus();
		input.inputEl.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	/** `tone`: "warning" (red) for something you can't easily undo, "cta" for a harmless step. */
	constructor(app: App, private readonly title: string, private readonly body: string, private readonly action: string, private readonly confirm: () => void | Promise<void>, private readonly tone: 'warning' | 'cta' = 'warning') {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl('p', { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				(this.tone === 'cta' ? b.setButtonText(this.action).setCta() : b.setButtonText(this.action).setWarning()).onClick(async () => {
					await this.confirm();
					this.close();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
