// Offline test of Lumo decryption. It encrypts its own sample data the way Proton's published
// client does, then runs the plugin's code on it. This proves the plugin matches that source
// as read, not that it matches Lumo's live server.
// Run: npm run test:lumo

import { createMessage, decryptKey, encrypt, generateKey, readPrivateKey } from 'openpgp';
import { checkConversation, checkMasterKeys, checkSpaces, checkUser, parseStoredSession } from '../src/lumo/schema';
import { conversationAd, decryptBlob, importAesGcm, messageAd, SESSION_AD, spaceAd } from '../src/lumo/crypto';
import { openMasterKey, openMasterKeys, sessionKeyPassword, unlockUserKeys } from '../src/lumo/keys';
import { decryptChat, decryptListing, shallowMessages } from '../src/lumo/chat';
import { renderLumoTranscript, shownBranch } from '../src/lumo/transcript';

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

	console.log(failures ? `\n${failures} FAILED` : '\nAll Lumo tests passed.');
	process.exit(failures ? 1 : 0);
}

void main();
