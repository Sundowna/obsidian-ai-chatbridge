// Checks that chatgpt.com's answers still look the way we saw them in DevTools.
// If not, the sync stops instead of writing something wrong.

import { ShapeError } from '../schema';
import type { GptChat, GptListPage, GptProject } from './types';

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^g-p-[0-9a-z]{16,64}$/i;
/** "file_00000000b5f0…" (seen 2026-11-06); older chats may use "file-…". */
const FILE_ID = /^file[-_][0-9A-Za-z]{10,64}$/;

export const isChatId = (x: unknown): x is string => typeof x === 'string' && CHAT_ID.test(x);
export const isProjectId = (x: unknown): x is string => typeof x === 'string' && PROJECT_ID.test(x);
export const isFileId = (x: unknown): x is string => typeof x === 'string' && FILE_ID.test(x);

function isObj(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}
const isDate = (x: unknown) => typeof x === 'string' && !Number.isNaN(Date.parse(x));

export function checkGptList(x: unknown): GptListPage {
	if (!isObj(x) || !Array.isArray(x.items) || typeof x.total !== 'number' || typeof x.offset !== 'number') {
		throw new ShapeError('ChatGPT chat list: expected { items: [...], total, offset }');
	}
	if (!Number.isSafeInteger(x.total) || !Number.isSafeInteger(x.offset) || x.total < 0 || x.offset < 0 ||
		(x.items.length > 0 && x.total < x.offset + x.items.length)) {
		throw new ShapeError('ChatGPT chat list: invalid pagination counts');
	}
	x.items.forEach((it: unknown, i: number) => {
		const where = `ChatGPT chat list item ${i}`;
		if (!isObj(it)) throw new ShapeError(`${where}: not an object`);
		if (!isChatId(it.id)) throw new ShapeError(`${where}: missing or odd "id"`);
		if (it.title !== null && typeof it.title !== 'string') throw new ShapeError(`${where}: odd "title"`);
		if (!isDate(it.create_time) || !isDate(it.update_time)) throw new ShapeError(`${where}: missing dates`);
		if (it.gizmo_id !== null && it.gizmo_id !== undefined && typeof it.gizmo_id !== 'string') throw new ShapeError(`${where}: odd "gizmo_id"`);
	});
	return x as unknown as GptListPage;
}

/** Project names from GET /backend-api/gizmos/snorlax/sidebar. `more` = the answer says there are more projects. */
export function checkGptSidebar(x: unknown): { projects: GptProject[]; more: boolean; cursor?: string } {
	if (!isObj(x) || !Array.isArray(x.items)) throw new ShapeError('ChatGPT projects: expected { items: [...] }');
	const projects: GptProject[] = [];
	x.items.forEach((it: unknown, i: number) => {
		const g = isObj(it) && isObj(it.gizmo) && isObj(it.gizmo.gizmo) ? it.gizmo.gizmo : null;
		const name = g && isObj(g.display) ? g.display.name : undefined;
		if (!g || !isProjectId(g.id) || typeof name !== 'string') throw new ShapeError(`ChatGPT project ${i}: expected gizmo.gizmo { id, display.name }`);
		projects.push({ id: g.id, name });
	});
	const cursor = typeof x.cursor === 'string' && x.cursor !== '' ? x.cursor : undefined;
	return { projects, more: cursor !== undefined, cursor };
}

export function checkGptChat(x: unknown, expectedId: string): GptChat {
	if (!isObj(x)) throw new ShapeError('ChatGPT chat: not an object');
	if (x.conversation_id !== expectedId) throw new ShapeError('ChatGPT chat: "conversation_id" does not match the chat we asked for');
	if (typeof x.create_time !== 'number' || !Number.isFinite(x.create_time) || typeof x.update_time !== 'number' || !Number.isFinite(x.update_time)) throw new ShapeError('ChatGPT chat: missing times');
	checkMessages(x.messages, 'ChatGPT chat');
	checkPageInfo(x.page_info);
	return x as unknown as GptChat;
}

function checkMessages(list: unknown, what: string): void {
	if (!Array.isArray(list)) throw new ShapeError(`${what}: missing "messages" list`);
	list.forEach((m: unknown, i: number) => {
		const where = `${what}, message ${i}`;
		if (!isObj(m)) throw new ShapeError(`${where}: not an object`);
		if (typeof m.id !== 'string') throw new ShapeError(`${where}: missing "id"`);
		if (!isObj(m.author) || typeof m.author.role !== 'string') throw new ShapeError(`${where}: missing "author.role"`);
		if (!isObj(m.content) || typeof m.content.content_type !== 'string') throw new ShapeError(`${where}: missing "content.content_type"`);
	});
}

/** A message ID as used for "before=" (seen: "d4de2201-a361-410f-a40f-3e3f547f334f"). */
export const isMessageId = (x: unknown): x is string => typeof x === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(x);

function checkPageInfo(info: unknown): void {
	if (!isObj(info) || typeof info.has_previous_page !== 'boolean') {
		throw new ShapeError('ChatGPT pagination: missing boolean has_previous_page');
	}
	if (info.has_previous_page && !isMessageId(info.start_cursor)) {
		throw new ShapeError('ChatGPT pagination: missing cursor for older messages');
	}
}

/**
 * GET /backend-api/conversations/<id>/messages?before=<message-id>&num_turns=10 (seen 2026-11-06):
 * the older part of a long chat. Expected like the chat answer: { messages: [...], page_info: {...} }.
 */
export function checkGptOlderPage(x: unknown): Pick<GptChat, 'messages' | 'page_info'> {
	if (!isObj(x)) throw new ShapeError('ChatGPT older messages: not an object');
	checkMessages(x.messages, 'ChatGPT older messages');
	checkPageInfo(x.page_info);
	return x as unknown as Pick<GptChat, 'messages' | 'page_info'>;
}

/** The answer of GET /backend-api/files/download/<id>?… */
export function checkGptFileInfo(x: unknown): { url: string; size?: number } {
	if (!isObj(x) || x.status !== 'success' || typeof x.download_url !== 'string') {
		throw new ShapeError('ChatGPT file: expected { status: "success", download_url }');
	}
	return { url: x.download_url, size: typeof x.file_size_bytes === 'number' ? x.file_size_bytes : undefined };
}
