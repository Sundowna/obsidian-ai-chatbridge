// Just enough LevelDB to find one value in Chromium's Local Storage: the plain
// write-ahead .log files and the Snappy-compressed .ldb tables. Read-only, pure code.
// The Claude desktop app keeps its Code-tab sidebar groups there (key "customGroupsByScope").

function varint(buf: Uint8Array, pos: number): [number, number] {
	let value = 0;
	let factor = 1;
	for (let i = 0; i < 10 && pos < buf.length; i++) {
		const b = buf[pos++]!;
		value += (b & 0x7f) * factor;
		if (!(b & 0x80)) return [value, pos];
		factor *= 128;
	}
	throw new Error('bad varint');
}

export function snappyDecompress(src: Uint8Array): Uint8Array {
	const [len, start] = varint(src, 0);
	const out = new Uint8Array(len);
	let p = start;
	let o = 0;
	while (p < src.length) {
		const tag = src[p++]!;
		const type = tag & 3;
		if (type === 0) {
			let l = tag >> 2;
			if (l >= 60) {
				const n = l - 59;
				l = 0;
				for (let i = 0; i < n; i++) l += src[p++]! * 2 ** (8 * i);
			}
			l += 1;
			out.set(src.subarray(p, p + l), o);
			p += l;
			o += l;
			continue;
		}
		let l: number;
		let off: number;
		if (type === 1) {
			l = ((tag >> 2) & 7) + 4;
			off = ((tag >> 5) << 8) | src[p++]!;
		} else if (type === 2) {
			l = (tag >> 2) + 1;
			off = src[p]! | (src[p + 1]! << 8);
			p += 2;
		} else {
			l = (tag >> 2) + 1;
			off = (src[p]! | (src[p + 1]! << 8) | (src[p + 2]! << 16)) + src[p + 3]! * 2 ** 24;
			p += 4;
		}
		if (off <= 0 || off > o) throw new Error('bad snappy offset');
		for (let i = 0; i < l; i++, o++) out[o] = out[o - off]!;
	}
	return out;
}

/** The (decompressed) data blocks of an .ldb table file. */
export function tableBlocks(file: Uint8Array): Uint8Array[] {
	if (file.length < 48) return [];
	const footer = file.subarray(file.length - 48);
	let p = 0;
	[, p] = varint(footer, p); // metaindex offset
	[, p] = varint(footer, p); // metaindex size
	const [indexOff, p2] = varint(footer, p);
	const [indexSize] = varint(footer, p2);
	const read = (off: number, size: number): Uint8Array => {
		const raw = file.subarray(off, off + size);
		return file[off + size] === 1 ? snappyDecompress(raw) : raw;
	};
	const index = read(indexOff, indexSize);
	const restarts = new DataView(index.buffer, index.byteOffset, index.byteLength).getUint32(index.length - 4, true);
	const end = index.length - 4 - 4 * restarts;
	const blocks: Uint8Array[] = [];
	let q = 0;
	while (q < end) {
		let nonShared: number;
		let valueLen: number;
		[, q] = varint(index, q); // shared key bytes
		[nonShared, q] = varint(index, q);
		[valueLen, q] = varint(index, q);
		q += nonShared;
		const handle = index.subarray(q, q + valueLen);
		q += valueLen;
		const [off, h] = varint(handle, 0);
		const [size] = varint(handle, h);
		try {
			blocks.push(read(off, size));
		} catch {
			// a damaged block: skip it
		}
	}
	return blocks;
}

/** The JSON object right after the last parseable `"<key>":` in the text, or null. */
export function lastJsonObject(text: string, key: string): unknown {
	const marker = `"${key}":`;
	let at = text.lastIndexOf(marker);
	while (at >= 0) {
		const start = text.indexOf('{', at + marker.length);
		if (start === at + marker.length) {
			let depth = 0;
			let inStr = false;
			for (let i = start; i < text.length; i++) {
				const c = text[i];
				if (inStr) {
					if (c === '\\') i++;
					else if (c === '"') inStr = false;
				} else if (c === '"') inStr = true;
				else if (c === '{') depth++;
				else if (c === '}' && --depth === 0) {
					try {
						return JSON.parse(text.slice(start, i + 1));
					} catch {
						break; // e.g. split by a log block header: try an older copy
					}
				}
			}
		}
		at = text.lastIndexOf(marker, at - 1);
	}
	return null;
}

/** Text views of some bytes: Chromium stores Local Storage values as Latin-1 or UTF-16LE. */
function texts(bytes: Uint8Array): string[] {
	const out = [new TextDecoder('latin1').decode(bytes)];
	out.push(new TextDecoder('utf-16le').decode(bytes), new TextDecoder('utf-16le').decode(bytes.subarray(1)));
	return out;
}

/**
 * Newest value of `key` across a LevelDB folder's files (higher file number = newer;
 * within a file, later = newer). `files` is [name, bytes] for the *.log and *.ldb files.
 */
export function findLatestJson(files: [string, Uint8Array][], key: string): unknown {
	const num = (n: string) => Number(/(\d+)\.(log|ldb)$/.exec(n)?.[1] ?? -1);
	const sorted = [...files].sort((a, b) => num(b[0]) - num(a[0]));
	for (const [name, bytes] of sorted) {
		let chunks: Uint8Array[];
		try {
			chunks = name.endsWith('.ldb') ? tableBlocks(bytes).reverse() : [bytes];
		} catch {
			continue;
		}
		for (const chunk of chunks) {
			for (const t of texts(chunk)) {
				if (!t.includes(key)) continue;
				const v = lastJsonObject(t, key);
				if (v !== null) return v;
			}
		}
	}
	return null;
}
