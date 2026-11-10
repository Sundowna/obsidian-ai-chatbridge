// Offline test of the Gemini and AI Studio readers. The samples are made up, but shaped like
// the live replies seen on 2026-11-10 (positions only, no real chat content).
// Run: npm run test:gemini

import { batchPayload, buildChat, GeminiError, readChatPage, readListPage, readTurn } from '../src/gemini/wire';
import { imagesAsLinks, renderGeminiTranscript, renderStudioTranscript } from '../src/gemini/transcript';
import { promptFileId, readPrompt, readPromptList } from '../src/studio/wire';
import { normalizeSettings } from '../src/migrate';
import { ShapeError } from '../src/schema';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}
function throws(label: string, fn: () => unknown, kind: new (...a: never[]) => Error) {
	try {
		fn();
		expect(label, false, 'did not throw');
	} catch (e) {
		expect(label, e instanceof kind, e instanceof Error ? e.message : String(e));
	}
}

/** A batchexecute reply around one payload, the way Google frames it. */
function reply(rpcId: string, payload: unknown): string {
	const row = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic'], ['di', 109], ['af.httprm', 109, '1', 4]]);
	return `)]}'\n\n${row.length}\n${row}\n25\n[["e",4,null,null,740]]\n`;
}

const at = (sec: number) => [sec, 153005000];

function turn(rid: string, sec: number, prompt: string, answer: string, extra: { reasoning?: string; drafts?: number } = {}): unknown[] {
	const cand = (id: string, text: string) => {
		const c: unknown[] = [id, [text], [null, null, null, null, [null, null, 7]]];
		if (extra.reasoning) c[37] = [[extra.reasoning]];
		return c;
	};
	const cands = [cand('rc_aaa', answer), ...Array.from({ length: extra.drafts ?? 0 }, (_, i) => cand(`rc_x${i}`, 'other'))];
	const answers: unknown[] = [cands, null, null, 'rc_aaa'];
	answers[21] = '3.6 Flash';
	return [['c_421ec87547ddea3f', rid], null, [[prompt], 1, null, 1, 'cf41b0e0dd7d53e5', 0], answers, at(sec)];
}

function main() {
	// --- batchexecute framing --------------------------------------------------
	const list = [null, 'next-token', [['c_238ce75d1feb162e', 'Website review', null, null, null, at(1788451602)], ['c_421ec87547ddea3f', '', null, null, null, at(1788426966)]]];
	const payload = batchPayload(reply('MaZiqc', list), 'MaZiqc');
	expect('payload found in reply', JSON.stringify(payload) === JSON.stringify(list));
	throws('other rpc missing', () => batchPayload(reply('MaZiqc', list), 'hNvQHb'), ShapeError);
	throws('odd start refused', () => batchPayload('<html>', 'MaZiqc'), ShapeError);
	const err = `)]}'\n\n1\n${JSON.stringify([['wrb.fr', 'hNvQHb', null, null, null, [5, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1167, null, "Couldn't load conversation. (1167)"]]]], 'generic']])}\n`;
	try {
		batchPayload(err, 'hNvQHb');
		expect('error reply throws', false);
	} catch (e) {
		expect('error reply is a GeminiError with its code', e instanceof GeminiError && e.code === 1167);
	}

	// --- chat list ---------------------------------------------------------------
	const page = readListPage(payload, false);
	expect('list items', page.items.length === 2 && page.next === 'next-token');
	expect('list time from seconds', page.items[0]!.updated_at === new Date(1788451602153).toISOString());
	expect('empty title becomes Untitled', page.items[1]!.name === 'Untitled');
	expect('last page has no cursor', readListPage([null, null, []], true).next === null);
	throws('odd chat ID refused', () => readListPage([null, null, [['../x', 't', null, null, null, at(1)]]], false), ShapeError);

	// --- a chat -------------------------------------------------------------------
	const newestFirst = [turn('r_3', 300, 'third', 'C', { reasoning: 'thinking it over', drafts: 2 }), turn('r_2', 200, 'second', 'B'), turn('r_1', 100, 'first', 'A')];
	const chatPage = readChatPage([newestFirst, 'older']);
	expect('chat page', chatPage.turns.length === 3 && chatPage.next === 'older');
	const t = readTurn(newestFirst[0]!, 0);
	expect('turn fields', t.id === 'r_3' && t.prompt === 'third' && t.answer === 'C' && t.model === '3.6 Flash');
	expect('turn reasoning and drafts', t.reasoning === 'thinking it over' && t.otherDrafts === 2);
	throws('turn without prompt refused', () => readTurn([['c_1', 'r_1'], null, [[null]], [[]], at(1)], 0), ShapeError);
	const item = { ...page.items[1]!, pinned: true };
	const chat = buildChat(item, newestFirst);
	expect('chat oldest first', chat.turns.map((x) => x.prompt).join(',') === 'first,second,third');
	expect('chat created from first turn', chat.createdAt === new Date(100153).toISOString());
	expect('raw rows kept', chat.raw.length === 3);
	const md = renderGeminiTranscript(chat, 'x.json');
	expect('transcript front matter', md.includes('pinned: true') && md.includes('raw: "[[x.json]]"'));
	expect('transcript order', md.indexOf('first') < md.indexOf('second') && md.indexOf('second') < md.indexOf('third'));
	expect('transcript reasoning callout', md.includes('> [!note]- Reasoning') && md.includes('2 other drafts'));

	// --- pictures in answers ------------------------------------------------------------
	const pic: unknown[] = ['rc_aaa', ['See <Image alt="Tabs" caption="Tabs at the bottom" src="image_agent_tag_123"/> and <Image src="image_agent_tag_999"/>.']];
	pic[12] = [null, [[[['https://example.com/a.png'], null, 979, 667], [['https://example.com/page'], 'Title', 7, null, null, 'MageComp'], null, [['https://thumb']], null, null, null, ['http://googleusercontent.com/image_agent_tag_123']]]];
	const withPic = turn('r_9', 900, 'q', 'x');
	(withPic[3] as unknown[][])[0] = [pic];
	const pt = readTurn(withPic, 0);
	expect('picture read', pt.images?.length === 1 && pt.images[0]!.url === 'https://example.com/a.png' && pt.images[0]!.site === 'MageComp');
	const shown = imagesAsLinks(pt.answer, pt.images);
	expect('picture becomes a link', shown.includes('*(Image: Tabs at the bottom, [view](<https://example.com/a.png>), from [MageComp](<https://example.com/page>))*'), shown);
	expect('unknown picture marked not saved', shown.includes('*(Image: picture, not saved)*') && !shown.includes('<Image'));

	// --- AI Studio ------------------------------------------------------------------
	const meta = ['AI Optimization for Agriland', null, ['Owner', 1, 'photo'], null, [['1788164186', 894000000], ['Owner', 1, 'photo']], [1, 1, 1]];
	const plist = readPromptList([[['prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK', null, null, null, meta]]]);
	expect('prompt list', plist.items.length === 1 && plist.next === null && plist.items[0]!.name === 'AI Optimization for Agriland');
	expect('prompt time', plist.items[0]!.updated_at === new Date(1788164186894).toISOString());
	expect('prompt file ID', promptFileId('prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK') === '18msBc92magVZWdNSZgB8qJA4JIS3ExgK');
	throws('odd prompt ID refused', () => promptFileId('prompts/../../x'), ShapeError);
	const chunk = (text: string, role: string, thought = false) => {
		const c: unknown[] = [text];
		c[8] = role;
		c[18] = 24;
		if (thought) c[19] = 1;
		c[32] = ['1788163821', 851000000];
		return c;
	};
	const p: unknown[] = ['prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK', null, null, [1, null, 'models/gemini-3-pro'], meta];
	p[12] = ['Be brief.'];
	p[13] = [[chunk('Question?', 'user'), chunk('Let me think', 'model', true), chunk('Answer.', 'model')]];
	const prompt = readPrompt([p], 'prompts/18msBc92magVZWdNSZgB8qJA4JIS3ExgK');
	expect('prompt messages', prompt.messages.length === 3 && prompt.messages[1]!.thought === true && prompt.messages[2]!.text === 'Answer.');
	expect('prompt model and system', prompt.model === 'models/gemini-3-pro' && prompt.systemInstruction === 'Be brief.');
	throws('different prompt refused', () => readPrompt([p], 'prompts/otherotherother'), ShapeError);
	const smd = renderStudioTranscript(prompt, 'p.json');
	expect('studio transcript', smd.includes('> [!note]- System instructions') && smd.includes('> [!note]- Thinking') && smd.includes('## Model'));

	// --- settings ---------------------------------------------------------------------
	const fresh = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: { chatFolder: '30 Sources/AI Chats/Claude Desktop/Chat' } }] }).settings;
	expect('vault without Gemini gets it beside the others', fresh.gemini[0]!.web.folder === '30 Sources/AI Chats/Gemini/Chat' && fresh.gemini[0]!.studio.folder === '30 Sources/AI Chats/Gemini/AI Studio');
	const kept = normalizeSettings({ claude: [{ id: 'default', label: 'Main', web: {} }], gemini: [{ id: 'default', label: 'Main', web: { folder: 'G', index: { c_1: { updated_at: 'x', json: 'a', md: 'b', synced: 'y' } } } }] }).settings;
	expect('saved Gemini settings kept, AI Studio filled in', kept.gemini[0]!.web.folder === 'G' && !!kept.gemini[0]!.web.index.c_1 && kept.gemini[0]!.studio.enabled);

	console.log(failures ? `\n${failures} FAILED` : '\nall passed');
	if (failures) process.exit(1);
}

main();
