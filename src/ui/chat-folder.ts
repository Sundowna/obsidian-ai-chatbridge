import { Notice, Platform } from 'obsidian';
import { planChatFolderMove } from '../chat-folder-move';
import { chatFolderStorage, type ChatFolderTarget } from '../chat-folder-target';
import { count, folderSetting, type PanelContext } from './fields';
import { ConfirmModal } from './modals';

export function chatFolderSetting(ctx: PanelContext, el: HTMLElement, name: string, description: string, target: ChatFolderTarget): void {
	const storage = () => chatFolderStorage(ctx.plugin.settings, target);
	const get = () => storage()?.folder ?? '';
	if (Platform.isMobile) {
		folderSetting(ctx, el, name, description, get, (path) => storage()?.setFolder(path));
		return;
	}
	folderSetting(ctx, el, name, `${description} Changing this folder moves saved chats and sessions after confirmation.`, get, {
		commit: (path) => changeChatFolder(ctx, target, path),
	});
}

async function changeChatFolder(ctx: PanelContext, target: ChatFolderTarget, to: string): Promise<void> {
	const storage = chatFolderStorage(ctx.plugin.settings, target);
	if (!storage) return;
	const from = storage.folder;
	const move = async () => {
		const progress = new Notice('Moving saved notes…', 0);
		try {
			const result = await ctx.plugin.moveChatFolder(target, from, to);
			if (!result) return;
			const message = result.moved ? `Moved ${count(result.moved, 'note')} to ${to}.` : 'Folder saved.';
			const cleanup = result.foldersLeft.length ? ` Could not remove empty folders: ${result.foldersLeft.join(', ')}.` : '';
			new Notice(message + cleanup, cleanup ? 10_000 : undefined);
		} finally {
			progress.hide();
		}
	};
	try {
		const plan = planChatFolderMove(ctx.plugin.settings, storage, to);
		if (!plan.moves.length) {
			await move();
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let confirmed = false;
			const modal = new ConfirmModal(
				ctx.app,
				'Move saved notes?',
				`Move ${count(plan.chats.length, 'note')} and their related raw files from "${from}" to "${to}". Future syncs will use the new folder.`,
				'Move notes',
				async () => {
					if (confirmed) return;
					confirmed = true;
					await move().then(resolve, reject);
				},
			);
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				if (!confirmed) resolve();
			};
			modal.open();
		});
	} catch (error) {
		new Notice(error instanceof Error ? error.message : String(error), 10_000);
	}
}
