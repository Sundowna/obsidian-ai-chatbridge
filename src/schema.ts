// Checks that claude.ai's answers still look the way we saw them in DevTools.
// claude.ai's API is unofficial and can change any day. If the shape is not
// what we expect, we stop instead of writing something wrong.

import type { Chat, ListPage } from './types';

export class ShapeError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(x: unknown): x is string {
	return typeof x === 'string' && UUID_RE.test(x);
}

function isObj(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isDate(x: unknown): boolean {
	return typeof x === 'string' && !Number.isNaN(Date.parse(x));
}

export function checkListPage(x: unknown): ListPage {
	if (!isObj(x) || !Array.isArray(x.data) || typeof x.has_more !== 'boolean') {
		throw new ShapeError('chat list: expected { data: [...], has_more: true/false }');
	}
	x.data.forEach((it: unknown, i: number) => {
		const where = `chat list item ${i}`;
		if (!isObj(it)) throw new ShapeError(`${where}: not an object`);
		if (!isUuid(it.uuid)) throw new ShapeError(`${where}: missing or odd "uuid"`);
		if (typeof it.name !== 'string') throw new ShapeError(`${where}: missing "name"`);
		if (!isDate(it.created_at)) throw new ShapeError(`${where}: missing "created_at"`);
		if (!isDate(it.updated_at)) throw new ShapeError(`${where}: missing "updated_at"`);
		const p = it.project;
		if (p !== undefined && p !== null) {
			if (!isObj(p) || typeof p.name !== 'string' || typeof p.uuid !== 'string') {
				throw new ShapeError(`${where}: "project" is not { name, uuid }`);
			}
		}
	});
	return x as unknown as ListPage;
}

export function checkChat(x: unknown, expectedUuid: string): Chat {
	if (!isObj(x)) throw new ShapeError('chat: not an object');
	if (x.uuid !== expectedUuid) throw new ShapeError('chat: "uuid" does not match the chat we asked for');
	if (typeof x.name !== 'string') throw new ShapeError('chat: missing "name"');
	if (!isDate(x.created_at) || !isDate(x.updated_at)) throw new ShapeError('chat: missing dates');
	if (!Array.isArray(x.chat_messages)) throw new ShapeError('chat: missing "chat_messages" list');
	x.chat_messages.forEach((m: unknown, i: number) => {
		const where = `chat message ${i}`;
		if (!isObj(m)) throw new ShapeError(`${where}: not an object`);
		if (typeof m.uuid !== 'string') throw new ShapeError(`${where}: missing "uuid"`);
		if (typeof m.sender !== 'string') throw new ShapeError(`${where}: missing "sender"`);
		if (m.content !== undefined && !Array.isArray(m.content)) {
			throw new ShapeError(`${where}: "content" is not a list`);
		}
		if (m.content === undefined && typeof m.text !== 'string') {
			throw new ShapeError(`${where}: has neither "content" nor "text"`);
		}
	});
	return x as unknown as Chat;
}
