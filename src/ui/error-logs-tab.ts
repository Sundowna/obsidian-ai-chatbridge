// Error logs: the failed answers each account received, whole, to copy into a GitHub issue.

import { Notice, setIcon } from 'obsidian';
import { clearErrors, entryMarkdown, errorEntries, errorLogAccounts, type ErrorEntry } from '../error-log';
import { ConfirmModal } from './modals';
import type { PanelContext } from './fields';

export const ERROR_LOG_WARNING = 'Remove all personal data (email addresses, names, chat titles and chat text) before you paste this into a GitHub issue. Cookies and login keys are removed automatically.';
export const ERROR_LOG_EMPTY = 'No errors saved for this account.';

/** Which account is shown; kept while the settings window is open. */
export interface ErrorLogsState {
	key: string;
}

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice('Copied – remove personal data before pasting.');
	} catch {
		new Notice('Could not copy to the clipboard.');
	}
}

function when(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function entryBlock(el: HTMLElement, e: ErrorEntry, title: string): void {
	const box = el.createDiv({ cls: 'ccs-errorlog-entry' });
	const head = box.createDiv({ cls: 'ccs-errorlog-head' });
	const status = e.status === null ? 'no answer' : String(e.status);
	head.createSpan({ cls: 'ccs-errorlog-status', text: status });
	head.createSpan({ cls: 'ccs-errorlog-line', text: `${e.service} · ${e.method} ${e.url}` });
	const b = head.createEl('button', { cls: 'ccs-errorlog-copy', attr: { 'aria-label': 'Copy this error' } });
	setIcon(b.createSpan(), 'copy');
	b.createSpan({ text: 'Copy' });
	b.addEventListener('click', () => void copy(entryMarkdown(e, title)));
	box.createDiv({ cls: 'ccs-errorlog-meta', text: `${when(e.at)} · ${e.env}` });
	if (e.message) box.createDiv({ cls: 'ccs-errorlog-meta', text: `Plugin said: ${e.message}` });
	const headers = Object.entries(e.headers);
	if (!headers.length && !e.body) return;
	const details = box.createEl('details');
	details.createEl('summary', { text: `Response${e.body ? ` (${(e.bodyBytes / 1024).toFixed(1)} KB)` : ''}` });
	if (headers.length) details.createEl('pre', { cls: 'ccs-errorlog-pre', text: headers.map(([k, v]) => `${k}: ${v}`).join('\n') });
	if (e.body) details.createEl('pre', { cls: 'ccs-errorlog-pre', text: e.body });
}

export function errorLogsTab(ctx: PanelContext, el: HTMLElement, state: ErrorLogsState): void {
	const warn = el.createDiv({ cls: 'ccs-errorlog-warning', attr: { role: 'note' } });
	setIcon(warn.createSpan({ cls: 'ccs-errorlog-warning-icon' }), 'shield-alert');
	warn.createSpan({ text: ERROR_LOG_WARNING });

	const accounts = errorLogAccounts(ctx.plugin.settings);
	if (!accounts.length) return;
	const keyOf = (a: (typeof accounts)[number]) => `${a.source.provider}:${a.source.accountId}`;
	const current = accounts.find((a) => keyOf(a) === state.key) ?? accounts.find((a) => a.count > 0) ?? accounts[0]!;
	state.key = keyOf(current);

	const pills = el.createDiv({ cls: 'ccs-account-pills', attr: { role: 'tablist', 'aria-label': 'Accounts' } });
	for (const a of accounts) {
		const active = a === current;
		const pill = pills.createEl('button', { cls: 'ccs-account-pill', attr: { role: 'tab', 'aria-selected': String(active) } });
		pill.toggleClass('is-active', active);
		pill.createSpan({ text: a.title });
		if (a.count) pill.createSpan({ cls: 'ccs-errorlog-count', text: String(a.count) });
		pill.addEventListener('click', () => {
			state.key = keyOf(a);
			ctx.refresh();
		});
	}

	const entries = errorEntries(current.source);
	const bar = el.createDiv({ cls: 'ccs-errorlog-bar' });
	bar.createSpan({ cls: 'ccs-errorlog-meta', text: entries.length ? `${entries.length} saved (the last 20 are kept)` : ERROR_LOG_EMPTY });
	if (!entries.length) return;
	const all = bar.createEl('button', { text: 'Copy all' });
	all.addEventListener('click', () => void copy(entries.map((e) => entryMarkdown(e, current.title)).join('\n\n')));
	const clear = bar.createEl('button', { text: 'Clear', cls: 'mod-warning' });
	clear.addEventListener('click', () => {
		new ConfirmModal(ctx.app, `Clear the error log of ${current.title}?`, `The ${entries.length} saved errors are deleted. This cannot be undone.`, 'Clear', async () => {
			await clearErrors(current.source);
			ctx.refresh();
		}).open();
	});
	for (const e of entries) entryBlock(el, e, current.title);
}
