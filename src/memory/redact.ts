// The privacy filter for AI memory: finds things that must never reach the vault (passwords,
// recovery codes, 2FA seeds, ID and card numbers) and replaces only the value with [REDACTED].
// Everything else stays byte for byte. Pure code, no Obsidian.
//
// How it finds them, and why:
// - by label ("Passwort: …", "wagwoord: …", "recovery codes: …") in English, German and
//   Afrikaans, because a password has no shape of its own; the label and the rest of the line stay;
// - by shape plus checksum (card numbers: Luhn; IBANs: mod 97), so an ordinary long number
//   such as a phone number or an order number is left alone;
// - by shape alone only where the shape is unmistakable (otpauth:// links, Swiss AHV numbers).
// A hit is reported as a kind, never as the value.

export const REDACTED = '[REDACTED]';

export type RedactKind = 'password' | 'secret key' | '2FA seed' | 'recovery code' | 'ID number' | 'card number' | 'bank account number';

export interface Redaction {
	text: string;
	/** How many values were replaced, per kind. */
	hits: Partial<Record<RedactKind, number>>;
	total: number;
}

/** A letter or digit may not come directly before a label ("mypassword" is not a label). */
const START = '(?<![\\p{L}\\p{N}_])';
/** "for Proton", "für die Bank": a few words between the label and its ":" */
const FOR = '(?:\\s+(?:for|für|fuer|vir|of|von|to|zu)\\s+[^\\n:=]{1,30}?)?';
/** ":" or "=" (with Markdown bold or code marks around it), or "is" / "ist" / "lautet". */
const SEP = '[*_`]{0,2}\\s*(?:[:=]|\\s(?:is|ist|lautet|was|war)\\s)(?:\\s*[*_`]{1,2})*\\s*';
/** A value: quoted text, or everything up to the next space. */
const VALUE = '("[^"\\n]{1,200}"|\'[^\'\\n]{1,200}\'|[^\\s"\'`*|<>]+)';

const PASSWORD = new RegExp(`${START}(pass ?words?|passwort|passwörter|kennwort|passphrase|passcode|wagwoord|pwd|pin(?:[- ]?code)?)${FOR}${SEP}${VALUE}`, 'giu');
const SECRET = new RegExp(`${START}(api[-_ ]?keys?|secret(?:[-_ ]?key)?|access[-_ ]?tokens?|auth[-_ ]?tokens?|bearer|tokens?|private[-_ ]?key|client[-_ ]?secret|session[-_ ]?key|geheimnis|schlüssel|sleutel)${FOR}${SEP}${VALUE}`, 'giu');
const SEED = new RegExp(`${START}((?:2fa|totp|otp|mfa|two[- ]factor|zwei[- ]faktor|twee[- ]faktor|authenticator|authentifizierung)[^\\n:=]{0,40}?)${SEP}((?:[A-Za-z2-7]{4}[ -]?){4,16})(?![\\p{L}\\p{N}])`, 'giu');
const ID = new RegExp(`${START}(passport|reisepass|paspoort|pass|ausweis|personalausweis|identity|identiteits?|id|ahv|avs|social security|ssn|sozialversicherungs?|steuer|tax|driver'?s licen[cs]e|führerschein|rybewys)[- ]?(number|nummer|nommer|nr\\.?|no\\.?|#)${FOR}${SEP}((?:[A-Z0-9]*\\d[A-Z0-9]*)(?:[ .\\-/][A-Z0-9]*\\d[A-Z0-9]*){0,8})`, 'giu');
const OTPAUTH = /otpauth:\/\/[^\s"'`<>)\]]+/gi;
const AHV = /(?<![\d.])756\.\d{4}\.\d{4}\.\d{2}(?![\d.])/g;
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;
const DIGITS = /(?<![\d.,+])\d(?:[ -]?\d){12,18}(?![\d]|[.,]\d)/g;
const RECOVERY = new RegExp(`${START}(?:recovery|backup|restore|emergency|wiederherstellungs?|notfall|sicherungs?|herstel|rugsteun|nood)[- ]?(?:codes?|keys?|phrase|schlüssel|kodes?|sleutels?)`, 'iu');
/** One recovery code: letters and digits, at least one digit, perhaps in groups ("a1b2-c3d4"). */
const CODE = /(?<![\p{L}\p{N}])(?=[A-Za-z-]*\d)[A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{2,})*(?![\p{L}\p{N}])/gu;

/** Words after "password:" that say something about the password instead of being it. */
const NOT_A_VALUE = new Set([
	'a', 'an', 'the', 'is', 'in', 'on', 'at', 'not', 'no', 'none', 'never', 'yes', 'n/a', 'see', 'stored', 'saved', 'kept', 'required', 'optional', 'missing', 'unknown', 'empty', 'set', 'unset', 'use', 'ask', 'do', "don't", 'must', 'should', 'will', 'was', 'are', 'only', 'always', 'managed', 'from', 'via', 'changed', 'reset', 'hidden', 'redacted', 'true', 'false', 'null', 'string', 'here', 'below', 'above',
	'der', 'die', 'das', 'ist', 'im', 'in', 'nicht', 'kein', 'keine', 'keins', 'nie', 'niemals', 'ja', 'nein', 'siehe', 'gespeichert', 'steht', 'liegt', 'wird', 'muss', 'nur', 'immer', 'unbekannt', 'leer', 'fehlt',
	'nie', 'geen', 'ja', 'nee', 'sien', 'gestoor', 'moet', 'net', 'altyd', 'onbekend', 'leeg', 'is',
]);

const bare = (v: string) => v.replace(/^["']|["']$/g, '');

function luhn(digits: string): boolean {
	let sum = 0;
	for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
		let d = digits.charCodeAt(i) - 48;
		if (double && (d *= 2) > 9) d -= 9;
		sum += d;
	}
	return sum % 10 === 0;
}

/** The IBAN checksum: letters become numbers, the whole thing must leave 1 when divided by 97. */
function ibanOk(raw: string): boolean {
	const s = raw.replace(/ /g, '');
	if (s.length < 15 || s.length > 34) return false;
	let rem = 0;
	for (const ch of s.slice(4) + s.slice(0, 4)) {
		const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
		for (const d of n) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
	}
	return rem === 1;
}

/** Replaces the values of sensitive items in one memory text. */
export function redact(input: string): Redaction {
	const hits: Partial<Record<RedactKind, number>> = {};
	let total = 0;
	const hit = (kind: RedactKind): string => {
		hits[kind] = (hits[kind] ?? 0) + 1;
		total++;
		return REDACTED;
	};
	/** Keeps everything of the match except its last group (the value). */
	const keepLabel = (kind: RedactKind, ok: (value: string) => boolean) => (match: string, ...groups: unknown[]): string => {
		// replace() passes the groups, then the position (a number), then the whole text.
		const captured = groups.slice(0, groups.findIndex((g) => typeof g === 'number'));
		const raw = captured.filter((g): g is string => typeof g === 'string').pop() ?? '';
		const value = raw.trimEnd().replace(/[.,;!?)]+$/, '');
		if (!value || value.includes(REDACTED) || !ok(value)) return match;
		return match.slice(0, match.length - raw.length) + hit(kind) + raw.slice(value.length);
	};

	let text = input.replace(OTPAUTH, () => hit('2FA seed'));
	text = text.replace(SEED, keepLabel('2FA seed', (v) => v.replace(/[ -]/g, '').length >= 16 && (/^[A-Z2-7 -]+$/.test(v) || /\d/.test(v))));
	text = recoveryCodes(text, () => hit('recovery code'));
	text = text.replace(PASSWORD, keepLabel('password', (v) => bare(v).length >= 3 && !NOT_A_VALUE.has(bare(v).toLowerCase())));
	// A key or token is long and not a plain word: "token: expired" stays.
	text = text.replace(SECRET, keepLabel('secret key', (v) => bare(v).length >= 12 && /\d/.test(v)));
	text = text.replace(ID, keepLabel('ID number', (v) => (v.match(/\d/g) ?? []).length >= 5));
	text = text.replace(AHV, () => hit('ID number'));
	text = text.replace(IBAN, (m) => (ibanOk(m) ? hit('bank account number') : m));
	text = text.replace(DIGITS, (m) => (luhn(m.replace(/[ -]/g, '')) ? hit('card number') : m));
	return { text, hits, total };
}

/**
 * Recovery codes come as a list: on the line that names them and on the lines directly below.
 * Below the label, a line counts only if it holds nothing but codes (and list marks).
 */
function recoveryCodes(text: string, hit: () => string): string {
	const lines = text.split('\n');
	let open = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const label = RECOVERY.exec(line);
		if (label) {
			const at = label.index + label[0].length;
			lines[i] = line.slice(0, at) + line.slice(at).replace(CODE, hit);
			open = true;
			continue;
		}
		if (!open) continue;
		const rest = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, '').replace(/\r$/, '');
		if (rest === '') continue; // an empty line inside the list
		if (rest.replace(CODE, '').replace(/[\s,;|`]/g, '') === '') lines[i] = line.replace(CODE, hit);
		else open = false;
	}
	return lines.join('\n');
}

/** "2 passwords, 1 card number" */
export function describeHits(hits: Partial<Record<RedactKind, number>>): string {
	return Object.entries(hits)
		.filter(([, n]) => n > 0)
		.map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
		.join(', ');
}
