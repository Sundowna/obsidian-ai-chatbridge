// Reads MessagePack, the format Lumo packs a file in before encrypting it (Proton's client:
// serialization.ts, msgpackEncode). Read only, and only what that needs: nil, booleans,
// numbers, text, bytes, lists and maps with text keys. Anything else throws.

import { ShapeError } from '../schema';

const MAX_DEPTH = 32;

class Reader {
	private at = 0;
	private readonly view: DataView;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	get done(): boolean {
		return this.at === this.bytes.byteLength;
	}

	private need(n: number): number {
		if (n < 0 || this.at + n > this.bytes.byteLength) throw new ShapeError('packed file data ends too early');
		const start = this.at;
		this.at += n;
		return start;
	}

	private u8(): number { return this.view.getUint8(this.need(1)); }
	private u16(): number { return this.view.getUint16(this.need(2)); }
	private u32(): number { return this.view.getUint32(this.need(4)); }

	private big(signed: boolean): number {
		const at = this.need(8);
		const v = signed ? this.view.getBigInt64(at) : this.view.getBigUint64(at);
		return Number(v);
	}

	private text(n: number): string {
		const start = this.need(n);
		return new TextDecoder('utf-8', { fatal: false }).decode(this.bytes.subarray(start, start + n));
	}

	/** A copy, so the caller's bytes do not keep the whole packed buffer alive. */
	private bin(n: number): Uint8Array<ArrayBuffer> {
		const start = this.need(n);
		return this.bytes.slice(start, start + n);
	}

	private list(n: number, depth: number): unknown[] {
		if (n > this.bytes.byteLength) throw new ShapeError('packed file data names an impossible list');
		const out: unknown[] = [];
		for (let i = 0; i < n; i++) out.push(this.value(depth + 1));
		return out;
	}

	private map(n: number, depth: number): Record<string, unknown> {
		if (n > this.bytes.byteLength) throw new ShapeError('packed file data names an impossible map');
		const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (let i = 0; i < n; i++) {
			const key = this.value(depth + 1);
			if (typeof key !== 'string') throw new ShapeError('packed file data has a map key that is not text');
			out[key] = this.value(depth + 1);
		}
		return out;
	}

	value(depth = 0): unknown {
		if (depth > MAX_DEPTH) throw new ShapeError('packed file data is nested too deep');
		const b = this.u8();
		if (b <= 0x7f) return b;
		if (b <= 0x8f) return this.map(b & 0x0f, depth);
		if (b <= 0x9f) return this.list(b & 0x0f, depth);
		if (b <= 0xbf) return this.text(b & 0x1f);
		if (b >= 0xe0) return b - 0x100;
		switch (b) {
			case 0xc0: return null;
			case 0xc2: return false;
			case 0xc3: return true;
			case 0xc4: return this.bin(this.u8());
			case 0xc5: return this.bin(this.u16());
			case 0xc6: return this.bin(this.u32());
			case 0xca: return this.view.getFloat32(this.need(4));
			case 0xcb: return this.view.getFloat64(this.need(8));
			case 0xcc: return this.u8();
			case 0xcd: return this.u16();
			case 0xce: return this.u32();
			case 0xcf: return this.big(false);
			case 0xd0: return this.view.getInt8(this.need(1));
			case 0xd1: return this.view.getInt16(this.need(2));
			case 0xd2: return this.view.getInt32(this.need(4));
			case 0xd3: return this.big(true);
			case 0xd9: return this.text(this.u8());
			case 0xda: return this.text(this.u16());
			case 0xdb: return this.text(this.u32());
			case 0xdc: return this.list(this.u16(), depth);
			case 0xdd: return this.list(this.u32(), depth);
			case 0xde: return this.map(this.u16(), depth);
			case 0xdf: return this.map(this.u32(), depth);
			default: throw new ShapeError(`packed file data has an unknown type 0x${b.toString(16)}`);
		}
	}
}

/** The one value in `bytes`. Throws ShapeError on anything it does not know or on leftover bytes. */
export function unpack(bytes: Uint8Array): unknown {
	const r = new Reader(bytes);
	const v = r.value();
	if (!r.done) throw new ShapeError('packed file data has bytes left over');
	return v;
}
