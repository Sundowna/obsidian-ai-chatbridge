// Dropdown of existing vault folders under a settings text field.

import { AbstractInputSuggest, App, TFolder } from 'obsidian';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly inputEl: HTMLInputElement,
		private readonly onPick: (path: string) => void,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((f) => !f.path.startsWith('.') && f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.onPick(folder.path);
		this.close();
	}
}
