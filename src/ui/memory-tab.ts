// The Memory tab: which AI's memories are saved, where, and how often. Every source is off
// until you turn it on.

import { Setting } from 'obsidian';
import { computerName } from '../computer';
import { claudeHome, codexHome, nodeDesktopFs } from '../desktop/scan';
import { MEMORY, lastRunLine, when } from '../last-run';
import { anyMemoryEnabled } from '../memory/sync';
import { MIN_INTERVAL_MINUTES } from '../settings';
import { bindSyncButton, count, folderSetting, type PanelContext } from './fields';

export function memoryTab(ctx: PanelContext, el: HTMLElement): void {
	const { plugin } = ctx;
	const m = plugin.settings.memory;
	const save = () => plugin.saveSettings();
	const fs = nodeDesktopFs();

	if (!fs) {
		new Setting(el).setName('AI memory').setDesc('Codex and Claude Code keep their memories on a computer, so they can only be saved in Obsidian on desktop.');
		return;
	}

	const anyOn = anyMemoryEnabled(plugin);
	const top = new Setting(el)
		.setName('AI memory')
		.setDesc('What each AI keeps about you between chats: its memory files and your global instructions. Saved as dated snapshots in the AI\'s own words, never translated or corrected; the privacy filter below replaces passwords and similar values. A new snapshot is written only when something changed. Read-only: the AI\'s own files are never changed.');
	top.settingEl.addClass('ccs-primary-row');
	if (anyOn) {
		lastRunLine(top.infoEl, plugin.settings.lastRuns[MEMORY]);
		top.addButton((b) =>
			bindSyncButton(ctx, b.setButtonText('Sync now').setCta().buttonEl, () => plugin.isSyncingMemory(), () => void plugin.syncMemory('manual').then(ctx.refresh)),
		);
	}

	folderSetting(ctx, el, 'Memory folder', 'Where the snapshots are saved: <folder>/<AI>/<account>/YYYY-MM-DD.md, plus _latest.md with the current state. Only the plugin writes here.', () => m.folder, (p) => (m.folder = p));

	const account = computerName();
	new Setting(el).setName('On this computer').setDesc(`Saved under the account "${account}", this computer's name.`).setHeading();

	const source = (name: string, key: 'codexLocal' | 'claudeCodeLocal', provider: string, reads: string) => {
		const state = m.states[`${provider}/${account}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}: ${count(state.files, 'file')}.` : '';
		new Setting(el)
			.setName(name)
			.setDesc(`${reads}${last}`)
			.addToggle((t) =>
				t.setValue(m[key]).onChange(async (v) => {
					m[key] = v;
					await save();
					ctx.refresh(); // shows or hides Sync now
				}),
			);
	};
	source('Codex', 'codexLocal', 'Codex', `Reads ${codexHome(fs)}: AGENTS.md, the memories and memories_v2 folders, and the per-thread notes in its memory database.`);
	source('Claude Code', 'claudeCodeLocal', 'Claude Code', `Reads ${claudeHome(fs)}: CLAUDE.md and every project's memory folder.`);

	new Setting(el).setName('On the web').setDesc('Read with the login of each account, the same one its chats are synced with.').setHeading();
	for (const acc of plugin.settings.claude) {
		const state = m.states[`Claude/${acc.label}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}: ${count(state.files, 'file')}.` : '';
		new Setting(el)
			.setName(plugin.settings.claude.length > 1 ? `Claude (${acc.label})` : 'Claude')
			.setDesc(`Reads claude.ai: every memory file (profile, topics, areas, people and each project's own memory) and your instructions for Claude. Nothing there is changed. Saved under the account "${acc.label}".${last}`)
			.addToggle((t) =>
				t.setValue(m.claudeWeb[acc.id] === true).onChange(async (v) => {
					m.claudeWeb[acc.id] = v;
					await save();
					ctx.refresh();
				}),
			);
	}
	for (const acc of plugin.settings.chatgpt) {
		const state = m.states[`ChatGPT/${acc.label}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}.` : '';
		new Setting(el)
			.setName(plugin.settings.chatgpt.length > 1 ? `ChatGPT (${acc.label})` : 'ChatGPT')
			.setDesc(`Reads chatgpt.com: the memory summary, the saved memories and your custom instructions. Nothing there is changed. The summary is asked for the way the settings page asks for it, so ChatGPT may write a fresh one first if its stored summary is out of date. Saved under the account "${acc.label}".${last}`)
			.addToggle((t) =>
				t.setValue(m.chatgptWeb[acc.id] === true).onChange(async (v) => {
					m.chatgptWeb[acc.id] = v;
					await save();
					ctx.refresh();
				}),
			);
	}

	for (const acc of plugin.settings.lumo) {
		const state = m.states[`Lumo/${acc.label}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}.` : '';
		new Setting(el)
			.setName(plugin.settings.lumo.length > 1 ? `Lumo (${acc.label})` : 'Lumo')
			.setDesc(`Reads Lumo: your saved memories (yours and the ones Lumo saved from chats), your personalization, your own custom agents and each project's instructions, unlocked like your chats. Nothing there is changed. Projects marked private are left out. Saved under the account "${acc.label}".${last}`)
			.addToggle((t) =>
				t.setValue(m.lumoWeb?.[acc.id] === true).onChange(async (v) => {
					m.lumoWeb = { ...(m.lumoWeb ?? {}), [acc.id]: v };
					await save();
					ctx.refresh();
				}),
			);
	}

	for (const acc of plugin.settings.gemini) {
		const state = m.states[`Gemini/${acc.label}`];
		const last = state ? ` Last snapshot ${when(Date.parse(state.synced))}.` : '';
		new Setting(el)
			.setName(plugin.settings.gemini.length > 1 ? `Gemini (${acc.label})` : 'Gemini')
			.setDesc(`Reads gemini.google.com: your own Gems with their description and instructions. "Instructions for Gemini" cannot be read yet. Nothing there is changed. Gems named Private are left out. Saved under the account "${acc.label}".${last}`)
			.addToggle((t) =>
				t.setValue(m.geminiWeb?.[acc.id] === true).onChange(async (v) => {
					m.geminiWeb = { ...(m.geminiWeb ?? {}), [acc.id]: v };
					await save();
					ctx.refresh();
				}),
			);
	}

	new Setting(el).setName('Schedule').setHeading();
	new Setting(el)
		.setName('Automatic memory sync (minutes)')
		.setDesc(`Checks the sources that are on. 0 is off, minimum ${MIN_INTERVAL_MINUTES}. "Sync all" does not include AI memory; use Sync now above or the command "Sync AI memory".`)
		.addText((t) =>
			t.setValue(String(m.intervalMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (!Number.isInteger(n) || (n !== 0 && n < MIN_INTERVAL_MINUTES)) return;
				m.intervalMinutes = n;
				await save();
				plugin.restartMemoryTimer();
			}),
		);

	new Setting(el).setName('Privacy').setHeading();
	new Setting(el)
		.setName('Privacy filter')
		.setDesc('Replaces passwords, recovery codes, two-factor seeds, ID numbers, card numbers and bank account numbers with a redaction mark before a snapshot is written. Only the value is replaced; the rest of the line stays. The sync log names the kind and the memory file, never the value. It works from labels and checksums, so it can miss something: do not rely on it alone. Off saves everything exactly as the AI keeps it.')
		.addToggle((t) =>
			t.setValue(m.redact).onChange(async (v) => {
				m.redact = v;
				await save();
			}),
		);

	new Setting(el)
		.setName('What is saved')
		.setDesc('Each memory file becomes a heading with its text in a code block below, so nothing in it is reformatted. Nothing is translated or corrected. Folders named Private are never read. Codex\'s use counters are left out, because they change every time a memory is used.');
}
