// The preview of "Merge chat copies into one note". It only reads; nothing in the vault changes
// until "Merge" is pressed.

import { Modal, Notice, Setting, type App } from 'obsidian';
import type AIChatBridge from '../main';
import { dirOf, nameOf, stemOf, type CopyKind } from '../merge';
import { linkCount, mergeReportText, previewMerge, writeMergeReport, type MergePreview, type PreviewGroup } from '../merge-run';

const SHOWN = 300;

const KINDS: { kind: CopyKind; name: string; desc: string }[] = [
	{ kind: 'updated', name: 'Chats with "(updated …)" notes', desc: 'A chat that continued got a second note. They merge into the chat\'s first note; each earlier version stays as a raw file.' },
	{ kind: 'transcript', name: 'ChatGPT chats with "(transcript …)" copies only', desc: 'The same chat rendered again, e.g. after its files were downloaded. The newest copy becomes the note.' },
	{ kind: 'recovered', name: 'Chats with "(recovered)" notes only', desc: 'A chat saved again after its files were deleted from the vault.' },
];

export class MergeModal extends Modal {
	private preview: MergePreview = { groups: [], skipped: [] };
	private readonly on: Record<CopyKind, boolean> = { updated: true, transcript: false, recovered: false };

	constructor(app: App, private readonly plugin: AIChatBridge) {
		super(app);
	}

	private selected(): PreviewGroup[] {
		return this.preview.groups.filter((g) => this.on[g.kind]);
	}

	onOpen(): void {
		this.modalEl.addClass('ccs-merge-modal');
		this.titleEl.setText('Merge chat copies into one note');
		// Canvases are read from disk for their links, so the preview takes a moment.
		this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'Reading the vault…' });
		void previewMerge(this.app, this.plugin.settings).then(
			(p) => {
				this.preview = p;
				this.render();
			},
			(e: unknown) => {
				this.contentEl.empty();
				this.contentEl.createEl('p', { text: `Could not read the vault: ${e instanceof Error ? e.message : String(e)}` });
			},
		);
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const all = this.preview.groups;
		if (!all.length) {
			el.createEl('p', { text: 'Nothing to merge: every synced chat has one note.' });
			new Setting(el).addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
			return;
		}
		el.createEl('p', {
			cls: 'setting-item-description',
			text: 'This is a preview. Nothing changes until you confirm below. Per chat: the first note keeps its name and gets the newest text, links to the other notes are rewritten to it, earlier versions stay as "(version …)" raw files, and the other notes go to Obsidian\'s trash.',
		});
		for (const k of KINDS) {
			const n = all.filter((g) => g.kind === k.kind).length;
			if (!n) continue;
			new Setting(el)
				.setName(`${k.name}: ${n}`)
				.setDesc(k.desc)
				.addToggle((t) =>
					t.setValue(this.on[k.kind]).onChange((v) => {
						this.on[k.kind] = v;
						this.render();
					}),
				);
		}
		const chosen = this.selected();
		const notes = chosen.reduce((n, g) => n + g.remove.length, 0);
		const versions = chosen.reduce((n, g) => n + g.olderRaws.length + g.olderNotes.length, 0);
		const links = chosen.reduce((n, g) => n + linkCount(g), 0);
		const sources = new Set(chosen.flatMap((g) => [...g.links.keys()])).size;
		el.createEl('p', { cls: 'ccs-merge-total', text: `Selected: ${chosen.length} chats. ${notes} notes merge away, up to ${versions} earlier versions are kept as raw files, ${links} links in ${sources} notes or canvases are rewritten.` });

		const list = el.createDiv({ cls: 'ccs-merge-list' });
		for (const g of chosen.slice(0, SHOWN)) {
			const item = list.createEl('details');
			const head = item.createEl('summary');
			head.createSpan({ cls: 'ccs-merge-name', text: stemOf(g.target) });
			head.createSpan({ cls: 'ccs-merge-count', text: ` ← ${g.remove.length} ${g.remove.length === 1 ? 'note' : 'notes'}${linkCount(g) ? `, ${linkCount(g)} links` : ''}${g.notes.length ? ' ⚠' : ''}` });
			const ul = item.createEl('ul');
			ul.createEl('li', { text: `Folder: ${dirOf(g.target)}` });
			ul.createEl('li', { text: `Text from: ${nameOf(g.newest)}` });
			for (const p of g.remove) ul.createEl('li', { text: `Merged, then to the trash: ${nameOf(p)}` });
			for (const o of [...g.olderRaws, ...g.olderNotes]) ul.createEl('li', { text: `Earlier version kept: ${nameOf(o.path)}` });
			if (g.fileMoves.length) ul.createEl('li', { text: `${g.fileMoves.length} saved files move to this note's folder` });
			for (const [source, refs] of g.links) ul.createEl('li', refs.length ? { text: `${refs.length} link(s) rewritten in: ${source}` } : { cls: 'ccs-merge-warn', text: `Links to check by hand in: ${source} (not a note or canvas it can read)` });
			for (const n of g.notes) ul.createEl('li', { cls: 'ccs-merge-warn', text: n });
		}
		if (chosen.length > SHOWN) list.createEl('p', { cls: 'setting-item-description', text: `…and ${chosen.length - SHOWN} more. Save the preview as a note to see all of them.` });
		if (this.preview.skipped.length) {
			el.createEl('p', { cls: 'setting-item-description', text: `${this.preview.skipped.length} chats are left alone because something about them is unclear. The saved preview lists them with the reason.` });
		}

		new Setting(el)
			.addButton((b) =>
				b.setButtonText('Save preview as a note').onClick(async () => {
					const path = await writeMergeReport(this.app, this.plugin.settings, 'merge preview', mergeReportText(chosen, this.preview.skipped));
					new Notice(`Preview saved: ${path}`, 10_000);
					await this.app.workspace.openLinkText(path, '', true);
				}),
			)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText(`Merge ${chosen.length} ${chosen.length === 1 ? 'chat' : 'chats'}`).setWarning().setDisabled(!chosen.length).onClick(async () => {
					this.close();
					await this.plugin.mergeCopies(chosen, this.preview.skipped);
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
