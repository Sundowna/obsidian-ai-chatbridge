import { Notice } from 'obsidian';
import { planChatgptFolderMove } from '../chatgpt/folder-move';
import type { ChatgptAccount } from '../settings';
import { count, type PanelContext } from './fields';
import { ConfirmModal } from './modals';

export async function changeChatgptFolder(ctx: PanelContext, account: ChatgptAccount, to: string): Promise<void> {
	const from = account.web.folder;
	const move = async () => {
		const progress = new Notice('Moving saved ChatGPT chats…', 0);
		try {
			const moved = await ctx.plugin.moveChatgptFolder(account.id, from, to);
			if (moved !== undefined) new Notice(moved ? `Moved ${count(moved, 'chat')} to ${to}.` : 'Chat folder saved.');
		} finally {
			progress.hide();
		}
	};
	try {
		const plan = planChatgptFolderMove(ctx.plugin.settings, account, to);
		if (!plan.moves.length) {
			await move();
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let confirmed = false;
			const modal = new ConfirmModal(
				ctx.app,
				'Move saved ChatGPT chats?',
				`Move ${count(plan.chats.length, 'chat')} from "${from}" to "${to}". Future syncs will use the new folder.`,
				'Move chats',
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
