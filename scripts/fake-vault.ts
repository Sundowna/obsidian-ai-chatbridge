// Reading and rewriting files in a test vault that is a Map of path -> content.
// Spread it into a fake vault next to its own create/getAbstractFileByPath.

type Content = string | ArrayBuffer;
interface Named {
	path: string;
}

const text = (v: Content | undefined): string => (v === undefined ? '' : typeof v === 'string' ? v : new TextDecoder().decode(v));

function bytes(v: Content | undefined): ArrayBuffer {
	if (v !== undefined && typeof v !== 'string') return v;
	const u = new TextEncoder().encode(v ?? '');
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

/** `asText`: keep binary writes as text too (for vaults whose Map holds strings only). */
export function readWrite<T extends Content>(files: Map<string, T>, asText = true) {
	return {
		read: async (f: Named) => text(files.get(f.path)),
		cachedRead: async (f: Named) => text(files.get(f.path)),
		readBinary: async (f: Named) => bytes(files.get(f.path)),
		modify: async (f: Named, d: string) => void files.set(f.path, d as T),
		modifyBinary: async (f: Named, d: ArrayBuffer) => void files.set(f.path, (asText ? text(d) : d) as T),
		createBinary: async (p: string, d: ArrayBuffer) => {
			if (files.has(p)) throw new Error('exists ' + p);
			files.set(p, (asText ? text(d) : d) as T);
		},
	};
}
