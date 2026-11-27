// Live check of the Browser link with your own, signed-in browser (not part of any test run).
// Starts the plugin's real link server, writes a pairing code to <out>/pairing-code.txt, waits
// until the extension pairs, then reads Gemini and AI Studio through the plugin's real code:
// the chat list, one chat and one prompt, rendered as the sync renders them.
// Prints counts and yes/no only; the rendered notes go to <out> for comparison.
//
//   npm run live:browser-link -- <out folder>

// As in Obsidian on a computer: a window with Node's require.
Object.assign(globalThis, { window: globalThis, require });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkServer } from '../src/link/server';
import { setBrowserLink } from '../src/transport';
import { GeminiApi } from '../src/gemini/api';
import { StudioApi } from '../src/studio/api';
import { buildChat } from '../src/gemini/wire';
import { renderGeminiTranscript, renderStudioTranscript } from '../src/gemini/transcript';
import { ClaudeApi } from '../src/api';
import { BROWSER_LINK_KEY } from '../src/claude-auth';
import { GptApi } from '../src/chatgpt/api';
import { transportFor } from '../src/transport';

const out = process.argv[2];
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=gemini,claude,chatgpt').slice(7).split(',');
if (!out) throw new Error('Give an output folder.');
mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (): Promise<void> => { await sleep(1500); }; // the plugin's minimum delay between requests
const line = (s: string) => console.log(s);

async function main(): Promise<void> {
	// The pairing is kept in <out> (token and port), so a later run links again without a new code.
	const tokenFile = join(out, 'token.txt');
	const portFile = join(out, 'port.txt');
	let token: string | null = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() || null : null;
	const server = new LinkServer({
		store: { get: () => token, set: (t) => { token = t; writeFileSync(tokenFile, t ?? ''); } },
		port: existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : undefined,
		codeLifetimeMs: 20 * 60_000,
	});
	const port = await server.start();
	writeFileSync(portFile, String(port));
	writeFileSync(join(out, 'pairing-code.txt'), server.newPairingCode());
	line(`link server on 127.0.0.1:${port}; ${token ? 'paired before, waiting for the browser to reconnect' : 'pairing code written'}; waiting up to 20 minutes`);
	const until = Date.now() + 20 * 60_000;
	while (!server.linked && Date.now() < until) await sleep(500);
	if (!server.linked) {
		line('RESULT  not paired in time');
		await server.stop();
		return;
	}
	line('PAIRED  the browser is linked');
	setBrowserLink((l) => l.provider !== 'lumo', () => server);
	const login = { provider: 'gemini' as const, id: 'live' };

	if (only.includes('gemini')) try {
		const t0 = Date.now();
		const g = await GeminiApi.connect(login);
		line(`GEMINI  opened signed in (${Math.round((Date.now() - t0) / 1000)} s)`);
		const id = await g.accountId();
		line(`GEMINI  Google account number read: ${id ? 'yes' : 'no'}`);
		const items = await g.listChats(wait, (p) => line(`GEMINI  list page ${p}`));
		line(`GEMINI  chats listed: ${items.length}`);
		const first = items[0];
		if (first) {
			const chat = buildChat(first, (await g.chatTurns(first.uuid, wait)) as Parameters<typeof buildChat>[1]);
			const json = JSON.stringify(chat, null, '\t');
			writeFileSync(join(out, 'gemini-chat.json'), json);
			writeFileSync(join(out, 'gemini-chat.md'), renderGeminiTranscript(chat, 'gemini-chat.json'));
			line(`GEMINI  newest chat read: ${chat.turns.length} turns, ${json.length} bytes of JSON; note written`);
		}
		g.close();
	} catch (e) {
		line(`GEMINI  FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
	}

	if (only.includes('gemini')) try {
		const s = await StudioApi.connect(login);
		line('STUDIO  opened signed in');
		const items = await s.listPrompts(wait, (p) => line(`STUDIO  list page ${p}`));
		line(`STUDIO  prompts listed: ${items.length}`);
		const first = items[0];
		if (first) {
			const p = await s.prompt(first.uuid, wait);
			if (p) {
				writeFileSync(join(out, 'studio-prompt.json'), JSON.stringify(p, null, '\t'));
				writeFileSync(join(out, 'studio-prompt.md'), renderStudioTranscript(p, 'studio-prompt.json'));
				line(`STUDIO  newest prompt read: ${p.messages.length} messages; note written`);
			} else line('STUDIO  newest prompt: gone');
		}
		s.close();
	} catch (e) {
		line(`STUDIO  FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
	}
	if (only.includes('claude')) try {
		const t = transportFor({ provider: 'claude', id: 'live' });
		const org = await t.siteValue('claude-org');
		line(`CLAUDE  organization read from the browser: ${org ? 'yes' : 'no (not logged in?)'}`);
		if (org) {
			const api = new ClaudeApi(org, () => BROWSER_LINK_KEY, { provider: 'claude', accountId: 'live' }, t);
			const first = (await api.get(api.listPath(0))).json as { data?: { uuid?: string }[]; has_more?: boolean };
			line(`CLAUDE  first page of the chat list: ${first.data?.length ?? 0} chats${first.has_more ? ', more pages' : ''}`);
			const top = first.data?.[0];
			if (top?.uuid) {
				await wait();
				const chat = (await api.get(api.chatPath(top.uuid))).json;
				writeFileSync(join(out, 'claude-chat.json'), JSON.stringify(chat, null, '	'));
				line(`CLAUDE  newest chat read: ${JSON.stringify(chat).length} bytes of JSON`);
			}
		}
	} catch (e) {
		line(`CLAUDE  FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
	}

	if (only.includes('chatgpt')) try {
		const g = await GptApi.connect({ provider: 'chatgpt', id: 'live' });
		line(`CHATGPT login key found in the page: yes; workspace known: ${g.workspaceId ? 'yes' : 'no'}`);
		const first = (await g.get(g.listPath(0, false))).json as { items?: { id?: string }[]; total?: number };
		line(`CHATGPT first page of the chat list: ${first.items?.length ?? 0} chats (total ${first.total ?? '?'})`);
		const top = first.items?.[0]?.id;
		if (top) {
			await wait();
			const chat = (await g.get(g.chatPath(top))).json;
			writeFileSync(join(out, 'chatgpt-chat.json'), JSON.stringify(chat, null, '	'));
			line(`CHATGPT newest chat read: ${JSON.stringify(chat).length} bytes of JSON`);
		}
	} catch (e) {
		line(`CHATGPT FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
	}

	await sleep(1000);
	await server.stop();
	line('DONE');
}

void main().then(() => process.exit(0));
