// Minimal protobuf helpers (pure, no schema needed).
// encode: just what ReadConversationRequest needs (string fields).
// decode: a generic reader that turns any protobuf message into a JSON tree
// keyed by field number, so we can look inside claude.ai's binary answers.

/** Encodes { fieldNumber: string } as a protobuf message (wire type 2). */
export function encodeStrings(fields: Record<number, string>): Uint8Array {
	const out: number[] = [];
	const varint = (n: number) => {
		while (n > 0x7f) {
			out.push((n & 0x7f) | 0x80);
			n >>>= 7;
		}
		out.push(n);
	};
	for (const [num, value] of Object.entries(fields)) {
		const bytes = new TextEncoder().encode(value);
		varint((Number(num) << 3) | 2);
		varint(bytes.length);
		out.push(...bytes);
	}
	return new Uint8Array(out);
}

export type ProtoValue = number | string | ProtoTree | { bytes: string };
export interface ProtoTree {
	[field: string]: ProtoValue[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function readVarint(buf: Uint8Array, pos: { i: number }): number {
	let result = 0;
	let shift = 0;
	for (;;) {
		if (pos.i >= buf.length) throw new Error('varint past end');
		const b = buf[pos.i++]!;
		result += (b & 0x7f) * 2 ** shift;
		if (b < 0x80) return result;
		shift += 7;
		if (shift > 63) throw new Error('varint too long');
	}
}

/** Tries to read `buf` as a protobuf message; throws if it is not one. */
export function decodeMessage(buf: Uint8Array, depth = 0): ProtoTree {
	if (depth > 64) throw new Error('too deep');
	const tree: ProtoTree = {};
	const pos = { i: 0 };
	while (pos.i < buf.length) {
		const key = readVarint(buf, pos);
		const field = Math.floor(key / 8);
		const wire = key % 8;
		if (field < 1) throw new Error('bad field number');
		let value: ProtoValue;
		if (wire === 0) value = readVarint(buf, pos);
		else if (wire === 1) {
			if (pos.i + 8 > buf.length) throw new Error('fixed64 past end');
			value = new DataView(buf.buffer, buf.byteOffset + pos.i, 8).getFloat64(0, true);
			pos.i += 8;
		} else if (wire === 5) {
			if (pos.i + 4 > buf.length) throw new Error('fixed32 past end');
			value = new DataView(buf.buffer, buf.byteOffset + pos.i, 4).getUint32(0, true);
			pos.i += 4;
		} else if (wire === 2) {
			const len = readVarint(buf, pos);
			if (pos.i + len > buf.length) throw new Error('length past end');
			const chunk = buf.subarray(pos.i, pos.i + len);
			pos.i += len;
			value = decodeChunk(chunk, depth);
		} else throw new Error(`unsupported wire type ${wire}`);
		(tree[String(field)] ??= []).push(value);
	}
	return tree;
}

/** A length-delimited chunk is a string, a nested message, or raw bytes. */
function decodeChunk(chunk: Uint8Array, depth: number): ProtoValue {
	let text: string | null = null;
	try {
		text = utf8.decode(chunk);
	} catch {
		text = null;
	}
	// Mostly printable text -> string (checked first: short strings also parse as messages).
	// eslint-disable-next-line no-control-regex -- detecting control characters is the point
	if (text !== null && /^[^\u0000-\u0008\u000e-\u001f]*$/.test(text)) return text;
	try {
		return decodeMessage(chunk, depth + 1);
	} catch {
		let b = '';
		for (const x of chunk) b += String.fromCharCode(x);
		return { bytes: btoa(b) };
	}
}
