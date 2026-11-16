// General tab, "Sync from another device": this device's role and name, where the request
// files live, and what the other device last said.

import { Setting } from 'obsidian';
import { when } from '../last-run';
import { controlFolder, MIN_GAP_MS, REQUEST_FILE, STATUS_FILE, statusText, type Role } from '../remote/protocol';
import { DEFAULT_REMOTE } from '../settings';
import { folderSetting, type PanelContext } from './fields';

/** "Last synced by Tower at …" with a coloured dot; also says when a request is still on its way. */
export function remoteStatusLine(ctx: PanelContext, parent: HTMLElement): HTMLElement {
	const { remote } = ctx.plugin;
	const line = parent.createDiv({ cls: 'ccs-last-run ccs-remote-status' });
	const draw = () => {
		line.empty();
		line.removeClass('is-ok', 'is-warn', 'is-bad');
		const pending = remote.role === 'requester' ? remote.pending : null;
		const s = remote.status;
		if (!s && !pending) {
			line.hide();
			return;
		}
		line.show();
		line.createSpan({ cls: 'ccs-dot' });
		// An answer to an older request says nothing about the one still on its way.
		if (pending && s?.requestId !== pending.id) {
			line.addClass('is-warn');
			line.createSpan({ cls: 'ccs-last-run-text', text: `Asked ${when(pending.at)}. Waiting for the computer to pick the request up.` });
			return;
		}
		const { text, tone } = statusText(s!, (ms) => when(ms));
		line.addClass(`is-${tone}`);
		line.createSpan({ cls: 'ccs-last-run-text', text: remote.role === 'writer' && s!.state !== 'running' ? `${text} (asked by ${s!.requestedBy})` : text });
	};
	const off = remote.onChange(() => {
		if (!line.isConnected) {
			off();
			return;
		}
		draw();
	});
	draw();
	return line;
}

export function remoteSection(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	const { remote } = plugin;
	const r = plugin.settings.remote;
	const writer = remote.role === 'writer';

	new Setting(el).setName('Sync from another device').setHeading();

	const role = new Setting(el)
		.setName('This device')
		.setDesc(remote.roleFixed
			? 'A phone or tablet cannot sync by itself yet. Its sync button writes a request into the vault, and the computer that syncs runs it once the request has reached it.'
			: writer
				? 'Syncs itself. It also runs "Sync all" when another device of yours asks through the vault. Saved on this device only.'
				: 'Does not sync itself: its sync button asks the device that does. Saved on this device only.')
		.addDropdown((dd) => {
			dd.addOption('writer', 'Syncs (writer)').addOption('requester', 'Asks another device (requester)').setValue(remote.role).onChange((v) => {
				remote.setRole(v as Role);
				ctx.refresh();
			});
			dd.setDisabled(remote.roleFixed);
		});
	remoteStatusLine(ctx, role.infoEl);
	if (!writer) {
		role.addButton((b) => b.setButtonText('Ask now').setCta().onClick(() => void remote.ask()));
	}

	new Setting(el)
		.setName('Name of this device')
		.setDesc('Shown on the other device ("last synced by …"). Saved on this device only.')
		.addText((t) => {
			t.setPlaceholder(remote.deviceName).setValue(remote.deviceName);
			// Saved when you leave the field, so a half-typed name is never used.
			t.inputEl.addEventListener('change', () => {
				remote.setDeviceName(t.getValue());
				t.setValue(remote.deviceName);
			});
		});

	folderSetting(
		ctx, el, 'Folder for sync requests',
		`Holds ${REQUEST_FILE} and ${STATUS_FILE}. Set the same folder on every device, and make sure your vault sync carries it both ways. Default: ${DEFAULT_REMOTE.folder}.`,
		() => r.folder,
		(p) => {
			const clean = controlFolder(p);
			if (clean) r.folder = clean;
		},
	);

	if (writer) {
		new Setting(el)
			.setName('Ignore requests older than (hours)')
			.setDesc(`A request that took longer than this to arrive is not run, so an old one does not start a sync days later. 1 to 168. A requested sync runs at most once every ${MIN_GAP_MS / 60_000} minutes and never interrupts a running one.`)
			.addText((t) =>
				t.setValue(String(r.maxAgeHours)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isInteger(n) || n < 1 || n > 168) return;
					r.maxAgeHours = n;
					await plugin.saveSettings();
				}),
			);
	}
}
