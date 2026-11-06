// Appends one line per run to the log note, grouped by "## YYYY-MM".

import { App, normalizePath, TFile } from 'obsidian';
import { ensureFolder } from './vaultio';

export async function appendLog(app: App, logPath: string, line: string, when: Date): Promise<void> {
	const path = normalizePath(logPath);
	const month = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
	const existing = app.vault.getAbstractFileByPath(path);

	if (!(existing instanceof TFile)) {
		await ensureFolder(app, path.split('/').slice(0, -1).join('/'));
		await app.vault.create(path, `---\nunread: true\n---\n\n## ${month}\n${line}\n`);
		return;
	}
	await app.vault.process(existing, (data) => {
		let d = data.replace(/\s*$/, '\n');
		if (!d.includes(`## ${month}`)) d += `\n## ${month}\n`;
		return `${d}${line}\n`;
	});
	await app.fileManager.processFrontMatter(existing, (fm: Record<string, unknown>) => {
		fm.unread = true;
	});
}
