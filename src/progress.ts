// Progress while a sync runs: a notice with a text line and a bar (manual syncs),
// and a short text in Obsidian's status bar (all syncs).

import { Notice } from 'obsidian';

/** What a sync reports: a text, and optionally how far along the current step is. */
export type ProgressFn = (msg: string, done?: number, total?: number) => void;

export class SyncProgress {
	private notice: Notice | null = null;
	private textEl: HTMLElement | null = null;
	private fillEl: HTMLElement | null = null;

	constructor(
		private readonly label: string,
		private readonly statusEl: HTMLElement | null,
		showNotice: boolean,
	) {
		if (showNotice) {
			const frag = createFragment((f) => {
				this.textEl = f.createDiv({ text: `${label}: starting…` });
				const bar = f.createDiv({ cls: 'ccs-progress is-indeterminate' });
				this.fillEl = bar.createDiv({ cls: 'ccs-progress-fill' });
			});
			this.notice = new Notice(frag, 0);
		}
		this.statusEl?.setText(`${label} sync…`);
	}

	readonly update: ProgressFn = (msg, done, total) => {
		const known = typeof done === 'number' && typeof total === 'number' && total > 0;
		const pct = known ? Math.min(100, Math.round((done / total) * 100)) : null;
		this.textEl?.setText(`${this.label}: ${msg}`);
		if (this.fillEl) {
			this.fillEl.parentElement?.toggleClass('is-indeterminate', pct === null);
			this.fillEl.style.width = pct === null ? '' : `${pct}%`;
		}
		// Status bar: the same words, without the chat title (e.g. "ChatGPT: 45 of 900 chats").
		const short = msg.split(': ')[0] ?? msg;
		this.statusEl?.setText(`${this.label}: ${short}${pct === null ? '' : ` (${pct}%)`}`);
	};

	finish(): void {
		this.notice?.hide();
		this.statusEl?.setText('');
	}
}
