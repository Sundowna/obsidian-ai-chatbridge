// Unlocks the account keys and opens Lumo's master key. Everything here lives in memory
// for one sync and is never saved or logged.

import { decrypt, decryptKey, readMessage, readPrivateKey, type PrivateKey } from 'openpgp';
import { StopError } from '../api';
import { decryptBlob, fromBase64, importAesGcm, importMasterKey, SESSION_AD } from './crypto';
import type { LumoMasterKeyRow, LumoStoredSession, LumoUserKey } from './types';

/** How Proton's OpenPGP layer labels a signature's purpose. */
const CONTEXT_NOTATION = 'context@proton.ch';
const MASTER_KEY_CONTEXT = 'lumo.aes.key';

/** The password-derived key from Proton's saved web session (the same step its web app does on reload). */
export async function sessionKeyPassword(session: LumoStoredSession, clientKeyB64: string): Promise<string> {
	const version = session.payloadVersion ?? 1;
	if (version !== 2 && version !== 3) throw new StopError(`Proton's saved session has version ${version}, which the plugin does not know. Log in to Lumo again.`);
	const key = await importAesGcm(fromBase64(clientKeyB64));
	let text: string;
	try {
		text = new TextDecoder().decode(await decryptBlob(key, session.blob, SESSION_AD, version === 2 ? 16 : 12));
	} catch {
		throw new StopError('Could not open Proton\'s saved session. Log in to Lumo again.');
	}
	let keyPassword: unknown;
	try {
		keyPassword = (JSON.parse(text) as { keyPassword?: unknown }).keyPassword;
	} catch {
		keyPassword = undefined;
	}
	if (typeof keyPassword !== 'string' || !keyPassword) throw new StopError('Proton\'s saved session holds no key. Log in to Lumo again.');
	return keyPassword;
}

/** Every account key this passphrase opens, primary first. */
export async function unlockUserKeys(keys: readonly LumoUserKey[], passphrase: string): Promise<PrivateKey[]> {
	const out: PrivateKey[] = [];
	const ordered = [...keys].filter((k) => k.Active !== 0).sort((a, b) => (b.Primary ?? 0) - (a.Primary ?? 0));
	for (const k of ordered) {
		try {
			out.push(await decryptKey({ privateKey: await readPrivateKey({ armoredKey: k.PrivateKey }), passphrase }));
		} catch {
			// Keys from before a password reset can stay locked; the others may still be enough.
		}
	}
	return out;
}

/** The raw master key, only if it carries a valid signature from these keys made for this purpose. */
export async function openMasterKey(encryptedB64: string, keys: PrivateKey[]): Promise<Uint8Array<ArrayBuffer> | null> {
	let result;
	try {
		result = await decrypt({
			message: await readMessage({ binaryMessage: fromBase64(encryptedB64) }),
			decryptionKeys: keys,
			verificationKeys: keys.map((k) => k.toPublic()),
			format: 'binary',
			config: { knownNotations: [CONTEXT_NOTATION] },
		});
	} catch {
		return null;
	}
	for (const s of result.signatures) {
		try {
			await s.verified;
			const notations = (await s.signature).packets.flatMap((p) => p.rawNotations);
			const context = notations.find((n) => n.name === CONTEXT_NOTATION);
			if (context && new TextDecoder().decode(context.value) === MASTER_KEY_CONTEXT) return new Uint8Array(result.data);
		} catch {
			// Not this signature.
		}
	}
	return null;
}

/** Newest key first, like Proton's own choice, so the likely key is tried first. */
export function orderMasterKeys(rows: readonly LumoMasterKeyRow[]): LumoMasterKeyRow[] {
	return [...rows].sort((a, b) =>
		Number(b.IsLatest === true) - Number(a.IsLatest === true)
		|| (b.Version ?? 0) - (a.Version ?? 0)
		|| Date.parse(b.CreateTime ?? '') - Date.parse(a.CreateTime ?? ''));
}

export async function openMasterKeys(rows: readonly LumoMasterKeyRow[], userKeys: PrivateKey[]): Promise<CryptoKey[]> {
	const out: CryptoKey[] = [];
	for (const row of orderMasterKeys(rows)) {
		const raw = await openMasterKey(row.MasterKey, userKeys);
		if (raw) out.push(await importMasterKey(raw));
	}
	return out;
}
