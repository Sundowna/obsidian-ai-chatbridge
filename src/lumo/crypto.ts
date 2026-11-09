// Lumo's stored-chat encryption, as in Proton's published client (WebClients:
// applications/lumo/src/app/crypto + serialization.ts, and @protontech/crypto's aesGcm.ts).
//   master key --AES-KW--> space key --HKDF-SHA-256--> space data key --AES-GCM--> records
// Pure WebCrypto. Keys stay non-extractable CryptoKeys wherever WebCrypto allows it.

const subtle = () => crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const IV_BYTES = 12;
const SPACE_DEK_SALT = 'Xd6V94/+5BmLAfc67xIBZcjsBPimm9/j02kHPI7Vsuc=';
const SPACE_DEK_INFO = 'dek.space.lumo';

export const SESSION_AD = 'session';

/** Sorted keys, no spaces, undefined left out: the same text as json-stable-stringify. */
function stable(fields: Record<string, string | undefined>): string {
	const entries = Object.entries(fields).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(Object.fromEntries(entries));
}

// Associated data binds each record to its place. Proton's "id" values are the tags, not the server IDs.
export const spaceAd = (id: string): string => stable({ app: 'lumo', type: 'space', id });
export const conversationAd = (id: string, spaceId: string): string => stable({ app: 'lumo', type: 'conversation', id, spaceId });
export const messageAd = (id: string, role: string, conversationId: string, parentId?: string): string =>
	stable({ app: 'lumo', type: 'message', id, role, parentId, conversationId });

export function importMasterKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return subtle().importKey('raw', raw, 'AES-KW', false, ['unwrapKey']);
}

/** The key that decrypts one space's records. `masterKeys` are tried in order; null if none fits. */
export async function spaceDataKey(wrappedSpaceKey: string, masterKeys: readonly CryptoKey[]): Promise<CryptoKey | null> {
	const wrapped = fromBase64(wrappedSpaceKey);
	for (const master of masterKeys) {
		try {
			const material = await subtle().unwrapKey('raw', wrapped, master, 'AES-KW', 'HKDF', false, ['deriveKey']);
			return await subtle().deriveKey(
				{ name: 'HKDF', hash: 'SHA-256', salt: fromBase64(SPACE_DEK_SALT), info: utf8(SPACE_DEK_INFO) },
				material,
				{ name: 'AES-GCM', length: 256 },
				false,
				['decrypt'],
			);
		} catch {
			// An older master key may be the right one.
		}
	}
	return null;
}

export function importAesGcm(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

/** base64(iv || ciphertext+tag). Throws when the key or the associated data is wrong. */
export async function decryptBlob(key: CryptoKey, b64: string, ad?: string, ivBytes = IV_BYTES): Promise<Uint8Array<ArrayBuffer>> {
	const all = fromBase64(b64);
	const params: AesGcmParams = { name: 'AES-GCM', iv: all.slice(0, ivBytes) };
	if (ad !== undefined) params.additionalData = utf8(ad);
	return new Uint8Array(await subtle().decrypt(params, key, all.slice(ivBytes)));
}

export async function decryptJson(key: CryptoKey, b64: string, ad: string): Promise<unknown> {
	return JSON.parse(new TextDecoder().decode(await decryptBlob(key, b64, ad))) as unknown;
}
