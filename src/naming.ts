// File names and dates. Pure functions, no Obsidian needed (testable offline).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** "2026-11-04T08:48:08Z" -> "2026-11-04" in this computer's local time. */
export function localDate(iso: string): string {
	const d = new Date(iso);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** -> "2026-11-04 09:48" (local time) */
export function localDateTime(iso: string): string {
	const d = new Date(iso);
	return `${localDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** -> "2026-11-04 0948", usable in a file name */
export function localStamp(iso: string): string {
	return localDateTime(iso).replace(':', '');
}

/** Daily note name for a date, e.g. "2026-11-05 Thu" (matches the vault's daily notes). */
export function dailyNoteName(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${DAYS[d.getDay()]}`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Makes a chat title safe for a file name on Windows and in Obsidian links.
 * Replaces \ / : * ? " < > | (Windows) and # ^ [ ] (break Obsidian links) with "-".
 */
export function safeTitle(name: string): string {
	let t = name
		.normalize('NFC')
		// eslint-disable-next-line no-control-regex -- removing control characters is the point
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/[\\/:*?"<>|#^[\]]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
	// Max 100 characters (Array.from keeps emoji in one piece).
	const chars = Array.from(t);
	if (chars.length > 100) t = chars.slice(0, 100).join('');
	// Windows dislikes names ending in "." or " "; Obsidian hides names starting with ".".
	t = t.replace(/[. ]+$/, '').replace(/^\.+/, '').trim();
	if (!t) t = 'Untitled';
	if (RESERVED.test(t)) t = `_${t}`;
	return t;
}

/**
 * Adds `account: "<name>"` to a transcript's front matter, right after its opening line, so
 * chats from several accounts can share one folder and still be told apart (Dataview, Bases).
 */
export function tagAccount(md: string, account: string): string {
	const open = /^---\r?\n/.exec(md);
	if (!open || !account) return md;
	return `${open[0]}account: ${JSON.stringify(account)}\n${md.slice(open[0].length)}`;
}

/** The transcript without the line tagAccount adds, for comparing renderings. */
export const untagAccount = (md: string): string => md.replace(/^(---\r?\n)account: [^\n]*\n/, '$1');

/** "YYYY-MM-DD <title>" with the date the chat was created. */
export function baseName(createdAt: string, name: string): string {
	return `${localDate(createdAt)} ${safeTitle(name)}`;
}

/**
 * The `model` property of a chat note: the models that answered, each once, in the order used.
 * One model is a plain value, several are a list; none (the service did not say) gives no line.
 */
export function modelProperty(models: readonly unknown[]): string[] {
	const seen = [...new Set(models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()))];
	if (!seen.length) return [];
	if (seen.length === 1) return [`model: ${JSON.stringify(seen[0])}`];
	return ['model:', ...seen.map((m) => `  - ${JSON.stringify(m)}`)];
}
