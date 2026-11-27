// Offline test of Lumo decryption. It encrypts its own sample data the way Proton's published
// client does, then runs the plugin's code on it. This proves the plugin matches that source
// as read, not that it matches Lumo's live server.
// Run: npm run test:lumo

import { createMessage, decryptKey, encrypt, generateKey, readPrivateKey } from 'openpgp';
import { checkConversation, checkMasterKeys, checkSpaces, checkUser, parseStoredSession } from '../src/lumo/schema';
import { attachmentAd, conversationAd, decryptBlob, importAesGcm, messageAd, SESSION_AD, spaceAd } from '../src/lumo/crypto';
import { openMasterKey, openMasterKeys, sessionKeyPassword, unlockUserKeys } from '../src/lumo/keys';
import { decryptChat, decryptListing, shallowMessages, type LumoEntry } from '../src/lumo/chat';
import { renderLumoTranscript, shownBranch } from '../src/lumo/transcript';
import { TFile } from 'obsidian';
import { saveLumoChats, type LumoFileSource, type LumoSyncResult } from '../src/lumo/sync';
import { artifactFileName, artifactKey, assetKey, collectFiles, decryptAsset, extraKey, type CollectedFiles } from '../src/lumo/assets';
import { unpack } from '../src/lumo/msgpack';
import { StopError } from '../src/api';
import { ShapeError } from '../src/schema';
import { followRename } from '../src/follow';
import type { LumoChat, LumoWireAsset } from '../src/lumo/types';
import { normalizeSettings } from '../src/migrate';
import { MassMissingError } from '../src/missing-guard';
import type { ListItem } from '../src/types';
import { readWrite } from './fake-vault';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const subtle = globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, ad?: string, ivLength = 12): Promise<string> {
	const iv = random(ivLength);
	const params: AesGcmParams = { name: 'AES-GCM', iv };
	if (ad !== undefined) params.additionalData = utf8(ad);
	const out = new Uint8Array(await subtle.encrypt(params, key, plain));
	return b64(new Uint8Array([...iv, ...out]));
}

const CONTEXT = 'context@proton.ch';

async function signedEnvelope(masterKey: Uint8Array<ArrayBuffer>, armoredPrivate: string, passphrase: string, context: string | null): Promise<string> {
	const priv = await decryptKey({ privateKey: await readPrivateKey({ armoredKey: armoredPrivate }), passphrase });
	const message = await encrypt({
		message: await createMessage({ binary: masterKey }),
		encryptionKeys: priv.toPublic(),
		signingKeys: priv,
		format: 'binary',
		signatureNotations: context === null ? [] : [{ name: CONTEXT, value: utf8(context), humanReadable: true, critical: true }],
	});
	return b64(message as Uint8Array);
}


/** The Lumo save loop on a fake vault: `read` stands in for fetching and decrypting. */
async function saveLoop() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const vault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? Object.assign(new TFile(p, { size: 0 }), { path: p }) : folders.has(p) ? {} : null),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => {
			if (files.has(p)) throw new Error('exists');
			files.set(p, d);
		},
		process: async (f: { path: string }, fn: (d: string) => string) => void files.set(f.path, fn(files.get(f.path) ?? '')),
		...readWrite(files),
	};
	const { settings } = normalizeSettings({});
	settings.maxChatsPerRun = 2;
	const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;
	const account = settings.lumo[0]!;
	account.label = 'Main';
	account.web.projectSubfolders = true;
	const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T10:00:00.000Z`;
	const garden = { uuid: 'S1', name: 'Garden' };
	const items: ListItem[] = [1, 2, 3].map((n) => ({ uuid: `C${n}`, name: `Chat ${n}`, created_at: day(n), updated_at: day(n), project: n === 3 ? garden : null }));
	let reads: string[] = [];
	let answer = 'First answer.';
	const refuse = new Set<string>();
	const read = async (item: ListItem): Promise<LumoChat | null> => {
		reads.push(item.uuid);
		if (refuse.has(item.uuid)) return null;
		return {
			id: item.uuid, spaceId: 'S1', title: item.name, project: item.project?.name, starred: false, createdAt: item.created_at, updatedAt: item.updated_at,
			messages: [
				{ id: 'm1', role: 'user', createdAt: item.created_at, private: { content: `Question of ${item.name}` } },
				{ id: 'm2', parentId: 'm1', role: 'assistant', createdAt: item.created_at, private: { content: answer } },
			],
		};
	};
	const empty = (): LumoSyncResult => ({ listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], filesSaved: 0, filesSkipped: [], backfilledChats: 0, flagChanges: 0, failed: [], edits: { copies: [], kept: [] } });
	const run = async (list = items, acc = account) => {
		reads = [];
		const r = empty();
		await saveLumoChats(plugin, acc, 'L/Chat', list, read, () => undefined, r);
		return r;
	};
	const index = account.web.index;
	const notes = () => [...files.keys()].filter((p) => p.endsWith('.md'));

	const r1 = await run();
	expect('loop: two newest saved, one left for next run', r1.newCount === 2 && r1.leftForLater === 1 && reads.join() === 'C3,C2' && notes().length === 2, JSON.stringify({ ...r1, reads }));
	const three = index.C3!;
	expect('loop: project chat in its project folder, the other under Recent', three.md.startsWith('L/Chat/Garden/2026-03-03 Chat 3') && index.C2!.md.startsWith('L/Chat/Recent/'), `${three.md} | ${index.C2!.md}`);
	expect('loop: note has the account, the raw link and the text', files.has(three.json) && files.get(three.md)!.includes('account: "Main"') && files.get(three.md)!.includes('.json]]"') && files.get(three.md)!.includes('First answer.'), files.get(three.md)!.slice(0, 300));
	const r2 = await run();
	expect('loop: the next run saves the one left over', r2.newCount === 1 && r2.unchanged === 2 && reads.join() === 'C1');
	const r3 = await run();
	expect('loop: unchanged chats are not read again', r3.unchanged === 3 && !reads.length);

	const rawBefore = files.get(three.json)!;
	answer = 'Second answer.';
	const later = items.map((it) => (it.uuid === 'C3' ? { ...it, updated_at: day(9) } : it));
	const r4 = await run(later);
	const kept = index.C3!.versions?.[0]?.files[0] ?? '';
	expect('loop: changed chat keeps its one note, earlier raw file kept', r4.changedCount === 1 && index.C3!.md === three.md && notes().length === 3 && files.get(three.md)!.includes('Second answer.') && files.get(kept) === rawBefore && files.get(three.md)!.includes('earlier_versions: 1'), kept);

	// A deleted note is written again from its raw file: no request, same name, same text.
	const noteBefore = files.get(three.md)!;
	files.delete(three.md);
	settings.maxChatsPerRun = 1;
	const r5 = await run(later);
	expect('restore: deleted note rebuilt from the raw file without a request', r5.restored.length === 1 && !reads.length && files.get(three.md) === noteBefore && r5.unchanged === 2 && r5.leftForLater === 0, JSON.stringify({ ...r5, reads }));
	files.delete(three.md);
	files.delete(three.json);
	const r6 = await run(later);
	expect('restore: note and raw file gone -> fetched again under the same names', r6.restored.length === 1 && reads.join() === 'C3' && files.has(three.md) && files.has(three.json));
	files.delete(three.md);
	files.set(three.json, 'not json');
	const r7 = await run(later);
	expect('restore: a damaged raw file is not used, the chat is fetched', r7.restored.length === 1 && reads.join() === 'C3' && files.get(three.json)!.includes('"messages"'));

	refuse.add('C4');
	const r8 = await run([...later, { uuid: 'C4', name: 'Chat 4', created_at: day(4), updated_at: day(4) }]);
	expect('loop: a chat that cannot be decrypted is named, nothing saved for it', r8.failed.join() === 'Chat 4' && !index.C4 && r8.newCount === 0);

	// Safety stop: many saved chats missing stops before anything is read or written.
	settings.maxChatsPerRun = 0;
	const other = structuredClone(account);
	other.web.index = {};
	const many: ListItem[] = Array.from({ length: 12 }, (_, i) => ({ uuid: `M${i}`, name: `Many ${i}`, created_at: day(i + 1), updated_at: day(i + 1) }));
	await run(many, other);
	for (const e of Object.values(other.web.index).slice(0, 10)) files.delete(e.md);
	const count = files.size;
	let stop = '';
	try {
		await run(many, other);
	} catch (e) {
		stop = e instanceof MassMissingError ? e.message : `other: ${String(e)}`;
	}
	expect('guard: ten of twelve missing stops the sync, nothing read or written', stop.startsWith('10 of 12 saved Lumo chats are not where the sync history says') && !reads.length && files.size === count, stop);
}

/** MessagePack writer for the test only: what Proton's client packs a file as. */
function pack(v: unknown): Uint8Array<ArrayBuffer> {
	const out: number[] = [];
	const u32 = (n: number) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
	const put = (x: unknown): void => {
		if (x === null || x === undefined) out.push(0xc0);
		else if (x === true) out.push(0xc3);
		else if (x === false) out.push(0xc2);
		else if (typeof x === 'number') {
			if (Number.isInteger(x) && x >= 0 && x < 128) out.push(x);
			else if (Number.isInteger(x) && x >= 0 && x <= 0xffffffff) { out.push(0xce); u32(x); }
			else { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); out.push(0xcb, ...new Uint8Array(b.buffer)); }
		} else if (typeof x === 'string') {
			const b = utf8(x);
			if (b.length < 32) out.push(0xa0 | b.length);
			else if (b.length < 65536) out.push(0xda, b.length >> 8, b.length & 255);
			else { out.push(0xdb); u32(b.length); }
			out.push(...b);
		} else if (x instanceof Uint8Array) {
			if (x.length < 256) out.push(0xc4, x.length);
			else { out.push(0xc6); u32(x.length); }
			out.push(...x);
		} else if (Array.isArray(x)) {
			out.push(0xdc, x.length >> 8, x.length & 255);
			x.forEach(put);
		} else {
			const entries = Object.entries(x as Record<string, unknown>);
			if (entries.length < 16) out.push(0x80 | entries.length);
			else out.push(0xde, entries.length >> 8, entries.length & 255);
			for (const [k, val] of entries) { put(k); put(val); }
		}
	};
	put(v);
	return new Uint8Array(out);
}

/**
 * Lumo files. `enc` encrypts like Lumo's space key, `entry` is the listed chat whose key the
 * plugin itself opened (so it decrypts with the plugin's own key, not the test's).
 */
async function fileTests(enc: CryptoKey, entry: LumoEntry) {
	// --- MessagePack reader ------------------------------------------------------------
	// The example on msgpack.org: {"compact": true, "schema": 0}
	const spec = new Uint8Array([0x82, 0xa7, 0x63, 0x6f, 0x6d, 0x70, 0x61, 0x63, 0x74, 0xc3, 0xa6, 0x73, 0x63, 0x68, 0x65, 0x6d, 0x61, 0x00]);
	expect('msgpack: the published example reads back', JSON.stringify(unpack(spec)) === '{"compact":true,"schema":0}');
	const long = 'ä'.repeat(40);
	const back = unpack(pack({ filename: 'a.png', data: new Uint8Array(300).fill(7), n: 70000, f: 1.5, list: [1, 'two', null, false], long, nested: { ok: true } })) as Record<string, unknown>;
	expect('msgpack: text, long text, bytes, numbers, lists and maps', back.filename === 'a.png' && back.long === long && back.data instanceof Uint8Array && (back.data as Uint8Array).length === 300 && (back.data as Uint8Array)[299] === 7 && back.n === 70000 && back.f === 1.5 && JSON.stringify(back.list) === '[1,"two",null,false]' && (back.nested as { ok: boolean }).ok);
	expect('msgpack: small and large negative numbers', unpack(new Uint8Array([0xff])) === -1 && unpack(new Uint8Array([0xd1, 0xff, 0x00])) === -256);
	let odd = 0;
	for (const bad of [[0x82, 0xa1, 0x61], [0xc1], [0x01, 0x02], [0xc6, 0xff, 0xff, 0xff, 0xff, 0x00], [0x81, 0x01, 0x02]]) {
		try {
			unpack(new Uint8Array(bad));
		} catch (e) {
			if (e instanceof ShapeError) odd++;
		}
	}
	expect('msgpack: cut-off, unknown, leftover and impossible data is refused', odd === 5, String(odd));

	// --- one file, encrypted the way Proton's client does it ----------------------------
	expect('file AD', attachmentAd('a1') === '{"app":"lumo","id":"a1","type":"attachment"}');
	const cat = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const sealAsset = (tag: string, priv: Record<string, unknown>, adTag = tag) => seal(enc, pack(priv), attachmentAd(adTag));
	const upload = await decryptAsset(entry.dek, { AssetTag: 'tag-cat', Encrypted: await sealAsset('tag-cat', { filename: 'angry cat.png', data: cat, mimeType: 'image/png', rawBytes: 8, markdown: null }) });
	expect('file: an upload is decrypted to its name and bytes', upload.filename === 'angry cat.png' && upload.mimeType === 'image/png' && !!upload.data && Buffer.from(upload.data).equals(Buffer.from(cat)) && !upload.artifact && !upload.autoRetrieved);
	let refused = false;
	try {
		await decryptAsset(entry.dek, { AssetTag: 'tag-cat', Encrypted: await sealAsset('tag-cat', { filename: 'x', data: cat }, 'another-tag') });
	} catch {
		refused = true;
	}
	expect('file: one encrypted for another tag is refused', refused);

	// --- which files belong to a chat ----------------------------------------------------
	const artifactStep = (id: string, content: string, language = 'csv', title = 'Sample data') => ({ type: 'tool_call', content: JSON.stringify({ id: 'call1', name: 'create_artifact', arguments: { id, title, type: 'code', language, content } }) });
	const chat: LumoChat = {
		id: entry.item.uuid, spaceId: entry.spaceTag, title: 'Cat chat', starred: false, createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z',
		messages: [
			{ id: 'm1', role: 'user', createdAt: '2026-03-01T10:00:00.000Z', private: { content: 'Look at my cat', attachments: [{ id: 'tag-cat', filename: 'angry cat.png' }, { id: 'tag-pdf' }] } },
			{ id: 'm2', parentId: 'm1', role: 'assistant', createdAt: '2026-03-01T10:00:05.000Z', private: { content: 'Here is a table.', blocks: [artifactStep('sample-csv', 'a,b\n1,2\n'), artifactStep('notes', '# Notes\n', 'markdown', 'notes')] } },
		],
	};
	const wire: Record<string, { AssetType: number; Encrypted: string | null; DeleteTime?: string }> = {
		A1: { AssetType: 0, Encrypted: await sealAsset('tag-cat', { filename: 'angry cat.png', data: cat, mimeType: 'image/png' }) },
		A2: { AssetType: 0, Encrypted: await sealAsset('tag-pdf', { filename: 'report.pdf', markdown: '# Report text', mimeType: 'application/pdf' }) },
		A3: { AssetType: 3, Encrypted: await sealAsset('tag-art', { filename: 'sample-csv', data: utf8('a,b\n1,2\n'), mimeType: 'text/plain', role: 'assistant', generatedArtifactAsset: { conversationId: entry.conversationTag, artifactId: 'sample-csv', artifactType: 'code', artifactTitle: 'Sample data' } }) },
		A4: { AssetType: 3, Encrypted: await sealAsset('tag-other', { filename: 'other.md', data: utf8('other chat'), generatedArtifactAsset: { conversationId: 'another-conversation', artifactId: 'x', artifactType: 'markdown', artifactTitle: 'Other' } }) },
		A5: { AssetType: 0, Encrypted: await sealAsset('tag-loose', { filename: 'project file.txt', data: utf8('nobody uses me') }) },
		A6: { AssetType: 1, Encrypted: await sealAsset('tag-img', { filename: 'drawing.png', data: cat, mimeType: 'image/png', role: 'assistant' }) },
		A7: { AssetType: 0, Encrypted: await sealAsset('tag-drive', { filename: 'from drive.txt', data: utf8('drive'), autoRetrieved: true }) },
		A8: { AssetType: 3, Encrypted: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
	};
	const tags: Record<string, string> = { A1: 'tag-cat', A2: 'tag-pdf', A3: 'tag-art', A4: 'tag-other', A5: 'tag-loose', A6: 'tag-img', A7: 'tag-drive', A8: 'tag-broken' };
	const assetsOf = (ids: string[]): LumoWireAsset[] => ids.map((ID, i) => ({ ID, AssetTag: tags[ID]!, AssetType: wire[ID]!.AssetType, CreateTime: `2026-03-01T10:00:0${i}Z`, Encrypted: null }));
	let fetched: string[] = [];
	const fetch = async (id: string): Promise<LumoWireAsset | null> => {
		fetched.push(id);
		return id === 'gone' ? null : { ID: id, AssetTag: tags[id]!, Encrypted: wire[id]!.Encrypted };
	};
	const withAssets = (ids: string[], spaceChats = 2): LumoEntry => ({ ...entry, assets: assetsOf(ids), spaceChats });
	const names = (c: CollectedFiles) => c.files.map((f) => `${f.kind}:${f.name}`).join(' | ');

	chat.messages[0]!.private.attachments = [{ id: 'tag-cat' }, { id: 'tag-pdf' }, { id: 'tag-drive' }];
	const all = await collectFiles(withAssets(['A1', 'A2', 'A3', 'A4', 'A5', 'A7']), chat, { fetch, have: () => false, cache: new Map() });
	expect('files: uploads to Attachments, what Lumo made to Artifacts; other chats\', unused and Drive files left out', names(all) === 'attachment:angry cat.png | attachment:report.pdf.md | artifact:sample-csv.csv | artifact:notes.md', names(all));
	expect('files: a project file no message uses is not even fetched', !fetched.includes('A5') && fetched.join() === 'A1,A2,A3,A4,A7', fetched.join());
	expect('files: an upload keeps its bytes; a file with only Lumo\'s text is saved as that text', Buffer.from(all.files[0]!.bytes).equals(Buffer.from(cat)) && Buffer.from(all.files[1]!.bytes).toString() === '# Report text');
	expect('files: an artifact Lumo has no file for comes from the chat text', Buffer.from(all.files[3]!.bytes).toString() === '# Notes\n' && all.files[3]!.keys.join() === artifactKey(chat.id, 'notes'));
	expect('files: index keys say what each file is', all.files[0]!.keys.join() === `${assetKey('A1')},tag-cat` && all.files[2]!.keys.join() === `${assetKey('A3')},${artifactKey(chat.id, 'sample-csv')}`, all.files.map((f) => f.keys.join()).join(' | '));

	// Saved files are not fetched again.
	fetched = [];
	const have = new Set(all.files.flatMap((f) => f.keys));
	const again = await collectFiles(withAssets(['A1', 'A2', 'A3']), chat, { fetch, have: (k) => have.has(k), cache: new Map() });
	expect('files: what is saved is neither fetched nor saved again', !again.files.length && !fetched.length && !again.skipped.length, `${names(again)} / ${fetched.join()}`);

	// A picture Lumo made that no message names: this chat's when the space has only this chat.
	fetched = [];
	const alone = await collectFiles(withAssets(['A6'], 1), { ...chat, messages: [] }, { fetch, have: () => false });
	const shared = await collectFiles(withAssets(['A6'], 2), { ...chat, messages: [] }, { fetch, have: () => false });
	expect('files: a picture Lumo made belongs to the only chat of its space, not to one of several', names(alone) === 'artifact:drawing.png' && alone.files[0]!.keys.join() === `${assetKey('A6')},${extraKey(chat.id, 'tag-img')}` && !shared.files.length, `${names(alone)} / ${names(shared)}`);

	// A file that cannot be decrypted is skipped and named; its artifact is not saved twice.
	const broken = await collectFiles(withAssets(['A1', 'A8']), chat, { fetch, have: () => false });
	expect('files: an unreadable file is skipped with "will retry", the others are saved', names(broken) === 'attachment:angry cat.png' && broken.skipped.length === 1 && broken.skipped[0]!.includes('will retry'), `${names(broken)} / ${broken.skipped.join()}`);
	const goneNow = await collectFiles({ ...entry, assets: [{ ID: 'gone', AssetTag: 'tag-cat', AssetType: 0 }], spaceChats: 1 }, chat, { fetch, have: () => false });
	expect('files: a file Lumo no longer has is left out, without an error', !goneNow.files.some((f) => f.kind === 'attachment') && !goneNow.skipped.length);
	let stopped = false;
	try {
		await collectFiles(withAssets(['A1']), chat, { fetch: async () => { throw new StopError('Lumo answered 401'); }, have: () => false });
	} catch (e) {
		stopped = e instanceof StopError;
	}
	expect('files: a login or rate-limit stop still stops the sync', stopped);
	// Seen live 2026-11-27: Lumo keeps an uploaded .jpg as a reduced WebP under its old name.
	const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4]);
	const reduced = await collectFiles({ ...entry, assets: [{ ID: 'W1', AssetTag: 'tag-cat', AssetType: 0 }], spaceChats: 1 }, { ...chat, messages: [chat.messages[0]!] }, {
		have: () => false,
		fetch: async () => ({ ID: 'W1', AssetTag: 'tag-cat', Encrypted: await sealAsset('tag-cat', { filename: 'photo.jpg', data: webp, mimeType: 'image/jpeg' }) }),
	});
	expect('files: a picture Lumo keeps in another format gets that format\'s ending', names(reduced) === 'attachment:photo.webp', names(reduced));
	// Seen live 2026-11-27: Lumo names a CSV artifact's file "<title>.txt".
	const txtNamed = await collectFiles({ ...entry, assets: [{ ID: 'T1', AssetTag: 'tag-art', AssetType: 3 }], spaceChats: 1 }, chat, {
		have: (k) => k !== assetKey('T1') && k !== artifactKey(chat.id, 'sample-csv'),
		fetch: async () => ({ ID: 'T1', AssetTag: 'tag-art', Encrypted: await sealAsset('tag-art', { filename: 'Sample data.txt', data: utf8('a,b\n1,2\n'), mimeType: 'text/plain', generatedArtifactAsset: { conversationId: entry.conversationTag, artifactId: 'sample-csv', artifactType: 'code', artifactTitle: 'Sample data' } }) }),
	});
	expect('files: an artifact Lumo names ".txt" gets the ending of its language', names(txtNamed) === 'artifact:Sample data.csv', names(txtNamed));
	expect('files: artifact names get an ending from the language or type', artifactFileName({ title: 'Plan', language: 'python' }) === 'Plan.py' && artifactFileName({ title: 'Doc', type: 'markdown' }) === 'Doc.md' && artifactFileName({ title: 'What', type: 'mystery' }) === 'What.txt' && artifactFileName({ title: 'data.json' }) === 'data.json');

	// --- the note ------------------------------------------------------------------------
	const links = { attachment: (t: string) => (t === 'tag-cat' ? 'L/Attachments/c/angry cat.png' : undefined), artifact: (id: string) => (id === 'sample-csv' ? 'L/Artifacts/c/sample-csv.csv' : undefined), extras: ['L/Artifacts/c/drawing.png'] };
	const md = renderLumoTranscript(chat, 'c.json', links);
	expect('note: saved picture shown, saved artifact linked by its title', md.includes('![[L/Attachments/c/angry cat.png]]') && md.includes('📎 [[L/Artifacts/c/sample-csv.csv|Sample data]]'), md);
	expect('note: files not saved are still counted as such', md.includes('*(2 attachments, not saved)*'));
	expect('note: files no message names are listed at the end', md.trimEnd().endsWith('## Files\n\n![[L/Artifacts/c/drawing.png]]'));
	const oneModel: LumoChat = { ...chat, messages: chat.messages.map((m) => (m.role === 'assistant' ? { ...m, private: { ...m.private, modelID: 'lumo-large' } } : m)) };
	expect('note: the model that answered is a property', renderLumoTranscript(oneModel, 'c.json').split('---')[1]!.includes('\nmodel: "lumo-large"\n') && !renderLumoTranscript(chat, 'c.json').split('---')[1]!.includes('model:'));
	const twoModels: LumoChat = { ...oneModel, messages: [...oneModel.messages,
		{ id: 'm3', parentId: 'm2', role: 'user', createdAt: '2026-03-01T10:01:00.000Z', private: { content: 'More' } },
		{ id: 'm4', parentId: 'm3', role: 'assistant', createdAt: '2026-03-01T10:01:05.000Z', private: { content: 'Sure', modelID: 'lumo-fast' } },
		{ id: 'm5', parentId: 'm4', role: 'user', createdAt: '2026-03-01T10:02:00.000Z', private: { content: 'Again' } },
		{ id: 'm6', parentId: 'm5', role: 'assistant', createdAt: '2026-03-01T10:02:05.000Z', private: { content: 'Yes', modelID: 'lumo-large' } }] };
	expect('note: several models are listed once each, in the order used', renderLumoTranscript(twoModels, 'c.json').includes('\nmodel:\n  - "lumo-large"\n  - "lumo-fast"\nraw:'), renderLumoTranscript(twoModels, 'c.json').split('---')[1]);
	expect('note: without saved files it reads as before', renderLumoTranscript(chat, 'c.json').includes('*(3 attachments, not saved)*') && !renderLumoTranscript(chat, 'c.json').includes('## Files'));

	// --- the whole sync loop, files included ---------------------------------------------
	const files = new Map<string, string | ArrayBuffer>();
	const folders = new Set<string>();
	const vault = {
		getAbstractFileByPath: (p: string) => (files.has(p) ? Object.assign(new TFile(p, { size: 0 }), { path: p }) : folders.has(p) ? {} : null),
		createFolder: async (p: string) => void folders.add(p),
		create: async (p: string, d: string) => {
			if (files.has(p)) throw new Error('exists');
			files.set(p, d);
		},
		process: async (f: { path: string }, fn: (d: string) => string) => void files.set(f.path, fn(String(files.get(f.path) ?? ''))),
		...readWrite(files, false),
	};
	const { settings } = normalizeSettings({});
	settings.maxChatsPerRun = 0;
	const plugin = { app: { vault, fileManager: { processFrontMatter: async () => undefined } }, settings, saveSettings: async () => undefined } as never;
	const account = settings.lumo[0]!;
	const g = account.web;
	const item: ListItem = { ...entry.item, name: 'Cat chat', created_at: chat.createdAt, updated_at: chat.updatedAt };
	const fresh = (): LumoSyncResult => ({ listed: 0, filteredOut: 0, unchanged: 0, newCount: 0, changedCount: 0, leftForLater: 0, written: [], restored: [], filesSaved: 0, filesSkipped: [], backfilledChats: 0, flagChanges: 0, failed: [], edits: { copies: [], kept: [] } });
	let reads = 0;
	const source = (ids: string[], spaceChats = 1): LumoFileSource => ({
		generated: () => ids.some((id) => wire[id]!.AssetType !== 0),
		collect: (_it, c, haveKey) => collectFiles(withAssets(ids, spaceChats), c, { fetch, have: haveKey }),
	});
	const run = async (src?: LumoFileSource, list = [item], c = chat) => {
		reads = 0;
		fetched = [];
		const r = fresh();
		await saveLumoChats(plugin, account, 'L/Chat', list, async () => { reads++; return c; }, () => undefined, r, src);
		return r;
	};
	chat.messages[0]!.private.attachments = [{ id: 'tag-cat' }];

	// Setting off: nothing fetched, the note says "not saved".
	g.downloadFiles = false;
	const off = await run(source(['A1', 'A3']));
	const note = () => String(files.get(g.index[item.uuid]!.md));
	expect('setting off: no file request, no file, note says "not saved"', off.newCount === 1 && !fetched.length && off.filesSaved === 0 && note().includes('*(1 attachment, not saved)*') && ![...files.keys()].some((p) => p.includes('/Attachments/')), `${fetched.join()} | ${[...files.keys()].join(' | ')}`);

	// Setting on: the chat saved earlier gets its files, its note is rewritten in place.
	g.downloadFiles = true;
	const on = await run(source(['A1', 'A3']));
	const stem = g.index[item.uuid]!.md.replace(/^.*\//, '').replace(/\.md$/, '');
	const dir = g.index[item.uuid]!.md.replace(/\/[^/]*$/, '');
	const catPath = `${dir}/Attachments/${stem}/angry cat.png`;
	expect('older chat: files fetched and saved beside it, counted, not as a changed chat', on.filesSaved === 3 && on.backfilledChats === 1 && on.changedCount === 0 && on.newCount === 0 && reads === 1 && files.has(catPath) && files.has(`${dir}/Artifacts/${stem}/sample-csv.csv`) && files.has(`${dir}/Artifacts/${stem}/notes.md`), `${JSON.stringify(on)} | ${[...files.keys()].join(' | ')}`);
	expect('older chat: the picture is saved byte for byte', Buffer.from(files.get(catPath) as ArrayBuffer).equals(Buffer.from(cat)));
	expect('older chat: one note, now showing the picture and linking the artifacts', [...files.keys()].filter((p) => p.endsWith('.md') && !p.includes('/Artifacts/')).length === 1 && note().includes(`![[${catPath}]]`) && note().includes(`📎 [[${dir}/Artifacts/${stem}/sample-csv.csv|Sample data]]`) && !note().includes('not saved'), note());
	const settled = await run(source(['A1', 'A3']));
	expect('next run: nothing read, nothing fetched', settled.unchanged === 1 && reads === 0 && !fetched.length && settled.filesSaved === 0);

	// A chat that goes on with a new upload: only the new file is fetched.
	const more: LumoChat = { ...chat, updatedAt: '2026-03-05T10:00:00.000Z', messages: [...chat.messages, { id: 'm3', parentId: 'm2', role: 'user', createdAt: '2026-03-05T10:00:00.000Z', private: { content: 'And this report', attachments: [{ id: 'tag-pdf' }] } }] };
	const grown = await run(source(['A1', 'A2', 'A3']), [{ ...item, updated_at: more.updatedAt }], more);
	expect('continued chat: only the new file is fetched and saved', grown.changedCount === 1 && grown.filesSaved === 1 && fetched.join() === 'A2' && files.has(`${dir}/Attachments/${stem}/report.pdf.md`) && note().includes('report.pdf.md'), `${fetched.join()} | ${JSON.stringify(grown)}`);

	// A deleted file comes back; a deleted note is rebuilt from the raw file with its links.
	files.delete(catPath);
	const back2 = await run(source(['A1', 'A2', 'A3']), [{ ...item, updated_at: more.updatedAt }], more);
	expect('a deleted file is fetched and saved again under its name', back2.filesSaved === 1 && fetched.join() === 'A1' && files.has(catPath), `${fetched.join()} | ${JSON.stringify(back2)}`);
	files.delete(g.index[item.uuid]!.md);
	const rebuilt = await run(source(['A1', 'A2', 'A3']), [{ ...item, updated_at: more.updatedAt }], more);
	expect('a deleted note is rebuilt from the raw file, with its file links, without a request', rebuilt.restored.length === 1 && reads === 0 && !fetched.length && note().includes(`![[${catPath}]]`), `${reads} ${fetched.join()}`);

	// An unreadable file: the chat is saved, the file is named and tried again next run.
	const second: ListItem = { uuid: 'C-second', name: 'Second', created_at: '2026-03-06T10:00:00.000Z', updated_at: '2026-03-06T10:00:00.000Z' };
	const secondChat: LumoChat = { ...chat, id: 'C-second', title: 'Second', messages: [] };
	const bad = await run(source(['A8']), [second], secondChat);
	expect('unreadable file: chat saved, file named in the result, sync not stopped', bad.newCount === 1 && bad.filesSkipped.length === 1 && g.index['C-second']!.outputsChecked === undefined, JSON.stringify(bad));
	const retry = await run(source(['A8']), [second], secondChat);
	expect('unreadable file: tried again on the next run', fetched.join() === 'A8' && retry.filesSkipped.length === 1 && retry.unchanged === 0);

	// A chat without any file is only marked as checked: no request.
	const plain: ListItem = { uuid: 'C-plain', name: 'Plain', created_at: '2026-03-07T10:00:00.000Z', updated_at: '2026-03-07T10:00:00.000Z' };
	const plainChat: LumoChat = { ...chat, id: 'C-plain', title: 'Plain', messages: [{ id: 'p1', role: 'user', createdAt: '2026-03-07T10:00:00.000Z', private: { content: 'Just text' } }] };
	g.downloadFiles = false;
	await run(source([]), [plain], plainChat);
	g.downloadFiles = true;
	const quiet = await run(source([]), [plain], plainChat);
	expect('older chat without files: marked as checked from its raw file, not fetched again', quiet.unchanged === 1 && reads === 0 && g.index['C-plain']!.outputsChecked === plain.updated_at);

	// Starred at Lumo later, then unstarred: only that property changes in the note, no request.
	let star = false;
	const starRun = async () => {
		reads = 0;
		const r = fresh();
		await saveLumoChats(plugin, account, 'L/Chat', [plain], async () => { reads++; return plainChat; }, () => undefined, r, source([]), () => star);
		return r;
	};
	await starRun();
	const plainMd = g.index['C-plain']!.md;
	const unstarred = String(files.get(plainMd));
	star = true;
	const st1 = await starRun();
	expect('starred: a later star is written into the note without a request', st1.flagChanges === 1 && reads === 0 && String(files.get(plainMd)).includes('\nstarred: true\nraw:'), String(files.get(plainMd)).slice(0, 200));
	star = false;
	const st2 = await starRun();
	expect('starred: an unstar takes the property out again', st2.flagChanges === 1 && reads === 0 && String(files.get(plainMd)) === unstarred);
	expect('starred: nothing to do when it did not change', (await starRun()).flagChanges === 0);

	// Renames and moves in Obsidian are followed for the saved files too.
	const moved = followRename(settings, dir, 'Moved/Lumo');
	expect('rename followed for Lumo files', moved > 0 && g.fileIndex['tag-cat'] === `Moved/Lumo/Attachments/${stem}/angry cat.png`, g.fileIndex['tag-cat']);
	expect('settings: Lumo downloads are on by default, with an empty file index', normalizeSettings({}).settings.lumo[0]!.web.downloadFiles === true && JSON.stringify(normalizeSettings({ lumo: [{ id: 'default', label: 'x', web: { folder: 'L' } }] }).settings.lumo[0]!.web.fileIndex) === '{}');
}

async function main() {
	// --- associated data, exactly as json-stable-stringify would write it ----
	expect('space AD', spaceAd('s1') === '{"app":"lumo","id":"s1","type":"space"}');
	expect('conversation AD', conversationAd('c1', 's1') === '{"app":"lumo","id":"c1","spaceId":"s1","type":"conversation"}');
	expect('message AD with parent', messageAd('m2', 'assistant', 'c1', 'm1') === '{"app":"lumo","conversationId":"c1","id":"m2","parentId":"m1","role":"assistant","type":"message"}');
	expect('message AD without parent', messageAd('m1', 'user', 'c1') === '{"app":"lumo","conversationId":"c1","id":"m1","role":"user","type":"message"}');

	// --- saved web session ---------------------------------------------------
	const clientRaw = random(32);
	const clientKey = await subtle.importKey('raw', clientRaw, 'AES-GCM', false, ['encrypt']);
	const passphrase = 'derived-key-password';
	const blob = await seal(clientKey, utf8(JSON.stringify({ keyPassword: passphrase })), SESSION_AD);
	const session = parseStoredSession(JSON.stringify({ UID: 'uid1', blob, payloadVersion: 3 }))!;
	expect('saved session parsed', session.UID === 'uid1');
	expect('session blob opens', (await sessionKeyPassword(session, b64(clientRaw))) === passphrase);
	const wrongKey = b64(random(32));
	let refused = false;
	try {
		await sessionKeyPassword(session, wrongKey);
	} catch {
		refused = true;
	}
	expect('session blob refuses the wrong key', refused);
	const v2 = await seal(clientKey, utf8(JSON.stringify({ keyPassword: passphrase })), SESSION_AD, 16);
	expect('version 2 session (16-byte IV) opens', (await sessionKeyPassword({ UID: 'u', blob: v2, payloadVersion: 2 }, b64(clientRaw))) === passphrase);

	// --- account keys and master key -----------------------------------------
	const { privateKey: armoredUser } = await generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'test', email: 'test@example.invalid' }], passphrase });
	const user = checkUser({ Code: 1000, User: { ID: 'user1', Keys: [{ PrivateKey: armoredUser, Primary: 1, Active: 1 }] } });
	const unlocked = await unlockUserKeys(user.keys, passphrase);
	expect('user key unlocks with the session key password', unlocked.length === 1);
	expect('user key stays locked with a wrong password', (await unlockUserKeys(user.keys, 'wrong')).length === 0);

	const masterRaw = random(32);
	const envelope = await signedEnvelope(masterRaw, armoredUser, passphrase, 'lumo.aes.key');
	const opened = await openMasterKey(envelope, unlocked);
	expect('master key opens', opened !== null && b64(opened) === b64(masterRaw));
	expect('master key with another purpose is refused', (await openMasterKey(await signedEnvelope(masterRaw, armoredUser, passphrase, 'other'), unlocked)) === null);
	expect('master key without a purpose is refused', (await openMasterKey(await signedEnvelope(masterRaw, armoredUser, passphrase, null), unlocked)) === null);
	const masterKeys = await openMasterKeys(checkMasterKeys({ Code: 1000, MasterKeys: [{ MasterKey: envelope, IsLatest: true, Version: 1, CreateTime: '2026-01-01T00:00:00Z' }] }), unlocked);
	expect('master key list opens', masterKeys.length === 1);

	// --- space, conversation, messages ---------------------------------------
	const kw = await subtle.importKey('raw', masterRaw, 'AES-KW', false, ['wrapKey']);
	const spaceRaw = random(32);
	const spaceAes = await subtle.importKey('raw', spaceRaw, 'AES-GCM', true, ['encrypt']);
	const wrapped = b64(new Uint8Array(await subtle.wrapKey('raw', spaceAes, kw, 'AES-KW')));
	const hkdf = await subtle.importKey('raw', spaceRaw, 'HKDF', false, ['deriveKey']);
	const dek = await subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from('Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=', 'base64'), info: utf8('dek.space.lumo') },
		hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
	const json = (o: unknown) => utf8(JSON.stringify(o));
	const spaces = checkSpaces({
		Code: 1000,
		Spaces: [{
			ID: 'S1', SpaceTag: 'st1', SpaceKey: wrapped, SpaceType: 1, CreateTime: '2026-03-01T10:00:00Z',
			Encrypted: await seal(dek, json({ projectName: 'Garden', isProject: true }), spaceAd('st1')),
			Conversations: [
				{ ID: 'C1', ConversationTag: 'ct1', CreateTime: '2026-03-01T10:00:00Z', UpdateTime: '2026-03-02T10:00:00Z', IsStarred: true, Encrypted: await seal(dek, json({ title: 'Tomatoes' }), conversationAd('ct1', 'st1')) },
				{ ID: 'C2', ConversationTag: 'ct2', CreateTime: '2026-03-01T10:00:00Z', Encrypted: await seal(dek, json({ title: 'Bad' }), conversationAd('ct2', 'wrong-space')) },
				{ ID: 'C3', ConversationTag: 'ct3', CreateTime: '2026-03-01T10:00:00Z', DeleteTime: '2026-03-03T10:00:00Z', Encrypted: await seal(dek, json({ title: 'Gone' }), conversationAd('ct3', 'st1')) },
			],
		}, {
			ID: 'S2', SpaceTag: 'st2', SpaceKey: wrapped, SpaceType: 1, CreateTime: '2026-03-01T10:00:00Z',
			Encrypted: await seal(dek, json({ projectName: 'Empty one', isProject: true }), spaceAd('st2')),
		}],
	});
	const listing = await decryptListing(spaces, masterKeys);
	expect('listing names a project that has no chats', listing.projects.map((p) => p.name).join() === 'Garden,Empty one');
	expect('listing decrypts the title', listing.entries.length === 1 && listing.entries[0]!.item.name === 'Tomatoes');
	expect('listing finds the project', listing.entries[0]!.item.project?.name === 'Garden');
	expect('a chat with wrong associated data is counted, not saved', listing.failed === 1);
	expect('deleted chats are left out', !listing.entries.some((e) => e.item.uuid === 'C3'));

	const space = async (id: string, tag: string, type: number | undefined, priv: unknown) => ({
		ID: id, SpaceTag: tag, SpaceKey: wrapped, CreateTime: '2026-03-01T10:00:00Z', ...(type === undefined ? {} : { SpaceType: type }),
		Encrypted: await seal(dek, json(priv), spaceAd(tag)),
		Conversations: [{ ID: `C-${id}`, ConversationTag: `ct-${id}`, CreateTime: '2026-03-01T10:00:00Z', Encrypted: await seal(dek, json({ title: id }), conversationAd(`ct-${id}`, tag)) }],
	});
	const older = await decryptListing(checkSpaces({ Code: 1000, Spaces: [
		await space('legacy', 'l1', undefined, { projectName: 'SWAFI', isProject: true }),
		await space('flagged', 'l2', undefined, { isProject: true }),
		await space('plain', 'l3', undefined, {}),
		await space('zero', 'l4', 0, { projectName: 'Typed zero' }),
		await space('sched', 'l5', 3, { projectName: 'A schedule' }),
	] }), masterKeys);
	const projectOf = (id: string) => older.entries.find((e) => e.item.uuid === `C-${id}`)?.item.project;
	expect('older project without SpaceType is found by its name', projectOf('legacy')?.name === 'SWAFI');
	expect('older project with only the flag still counts', projectOf('flagged')?.name === 'Project');
	expect('plain space without SpaceType stays without a project', projectOf('plain') === null);
	expect('default-typed space with a project name counts', projectOf('zero')?.name === 'Typed zero');
	expect('a schedule space is never a project', projectOf('sched') === null);
	expect('all those chats are still listed', older.entries.length === 5 && older.failed === 0);

	const conversation = checkConversation({
		Code: 1000,
		Conversation: {
			ID: 'C1', ConversationTag: 'ct1', CreateTime: '2026-03-01T10:00:00Z',
			Messages: [
				{ ID: 'M1', MessageTag: 'mt1', Role: 1, Status: 2, CreateTime: '2026-03-01T10:00:00Z', Encrypted: await seal(dek, json({ content: 'How deep?' }), messageAd('mt1', 'user', 'ct1')) },
				{ ID: 'M2', MessageTag: 'mt2', Role: 2, Status: 2, ParentID: 'M1', CreateTime: '2026-03-01T10:00:05Z', Encrypted: await seal(dek, json({ content: 'First answer' }), messageAd('mt2', 'assistant', 'ct1', 'mt1')) },
				{ ID: 'M3', MessageTag: 'mt3', Role: 2, Status: 2, ParentID: 'M1', CreateTime: '2026-03-01T10:00:09Z', Encrypted: await seal(dek, json({ content: 'Retried answer', reasoning: 'Think of roots.', blocks: [{ type: 'tool_call' }] }), messageAd('mt3', 'assistant', 'ct1', 'mt1')) },
			],
		},
	});
	const chat = await decryptChat(listing.entries[0]!, conversation);
	expect('all messages decrypt', chat.messages.length === 3 && chat.messages[0]!.private.content === 'How deep?');
	expect('parent links use tags', chat.messages[1]!.parentId === 'mt1');
	expect('the shown branch drops the earlier retry', shownBranch(chat.messages).map((m) => m.id).join() === 'mt1,mt3');
	const md = renderLumoTranscript(chat, 'x.json');
	expect('transcript has the answer', md.includes('Retried answer') && !md.includes('First answer'));
	expect('transcript folds the reasoning', md.includes('> [!note]- Reasoning\n> Think of roots.'));
	expect('transcript counts tool steps', md.includes('*(1 tool step)*'));
	expect('transcript front matter', md.includes('project: "Garden"') && md.includes('starred: true') && md.includes('raw: "[[x.json]]"'));
	expect('saved chat holds no key or blob', !JSON.stringify(chat).includes(wrapped) && !JSON.stringify(chat).includes(conversation.Messages![0]!.Encrypted!));

	const tampered = { ...conversation, Messages: [{ ...conversation.Messages![0]!, Role: 2 }] };
	let halfSaved = true;
	try {
		await decryptChat(listing.entries[0]!, tampered);
	} catch {
		halfSaved = false;
	}
	expect('a tampered message stops the whole chat', !halfSaved);
	expect('outline-only messages are noticed', shallowMessages({ ...conversation, Messages: [{ ...conversation.Messages![0]!, Encrypted: null }] }).length === 1);

	const raw = await importAesGcm(clientRaw);
	expect('blob helper round trip', new TextDecoder().decode(await decryptBlob(raw, blob, SESSION_AD)).includes(passphrase));

	// --- the save loop, on a fake vault ---
	await saveLoop();

	// --- files: uploads and what Lumo made ---
	await fileTests(dek, listing.entries[0]!);

	console.log(failures ? `\n${failures} FAILED` : '\nAll Lumo tests passed.');
	process.exit(failures ? 1 : 0);
}

void main();
