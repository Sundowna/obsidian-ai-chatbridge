// One-off diagnostic: asks claude.ai for ONE chat in several GET variants and
// saves the raw answers, so we can see which variant contains the IDs of the
// downloads shown in the chat view. GET only, claude.ai only (same guard).

import { Notice, TFile } from 'obsidian';
import type AIChatBridge from './main';
import { ClaudeApi, ReadRpc, redact, StopError } from './api';
import { decodeMessage, encodeStrings } from './proto';
import { isUuid } from './schema';
import { claudeAuth } from './claude-auth';
import { createNew, ensureFolder } from './vaultio';

const OUT = 'AI Chats/AI ChatBridge diagnostics';

export async function diagnoseActiveChat(plugin: AIChatBridge): Promise<void> {
	const app = plugin.app;
	const s = plugin.settings;
	const file = app.workspace.getActiveFile();
	const uuid = file instanceof TFile ? (app.metadataCache.getFileCache(file)?.frontmatter?.uuid as unknown) : undefined;
	if (!isUuid(uuid)) {
		new Notice('Open a synced chat transcript first (its frontmatter has the chat uuid).');
		return;
	}
	const account = s.claude.find((a) => a.web.index[uuid]) ?? s.claude[0]!;
	const { getKey, orgId: org } = await claudeAuth(plugin, account);
	// Read-only RPCs from claude.ai's own ConversationService definition.
	const variants: { name: string; method: ReadRpc; body: string | Uint8Array }[] = [
		{ name: '6 ReadConversation json', method: 'ReadConversation', body: JSON.stringify({ conversationId: uuid, displayLanguage: 'en' }) },
		{ name: '7 ReadConversation proto', method: 'ReadConversation', body: encodeStrings({ 1: uuid, 5: 'en' }) },
		{ name: '8 ReadConversationHistory json', method: 'ReadConversationHistory', body: JSON.stringify({ conversationId: uuid, cursor: '' }) },
	];

	const lines: string[] = [];
	try {
		const api = new ClaudeApi(org, getKey);
		await ensureFolder(app, OUT);
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		for (const v of variants) {
			await new Promise((r) => window.setTimeout(r, Math.max(1, s.delaySeconds) * 1000));
			const r = await api.rpc(v.method, v.body);
			let out = r.text;
			let note = '';
			if (r.status === 200 && r.contentType.includes('proto')) {
				try {
					out = JSON.stringify(decodeMessage(new Uint8Array(r.bytes)), null, 1);
					note = ' (binary, decoded by field number)';
				} catch (e) {
					note = ` (binary, could not decode: ${e instanceof Error ? e.message : String(e)})`;
					out = '';
				}
			}
			const ids = new Set(out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
			const outPath = `${OUT}/${stamp} ${uuid.slice(0, 8)} ${v.name}.json`;
			await createNew(app, outPath, out);
			lines.push(`- ${v.name}: status ${r.status}, ${r.contentType || 'no type'}, ${r.bytes.byteLength} bytes${note}, ${ids.size} distinct IDs → [[${outPath.split('/').pop()}]]`);
		}
		await createNew(app, `${OUT}/${stamp} ${uuid.slice(0, 8)} summary.md`, `---\nunread: true\n---\n\n${lines.join('\n')}\n`);
		new Notice(`AI ChatBridge diagnostic done: ${variants.length} answers saved in ${OUT}.`, 10_000);
	} catch (e) {
		const msg = e instanceof StopError ? e.message : redact(e instanceof Error ? e.message : String(e), getKey());
		new Notice(`Diagnostic stopped: ${msg}`, 15_000);
	}
}
