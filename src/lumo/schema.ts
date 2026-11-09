// Checks Lumo's answers before anything uses them. Anything unexpected stops the sync.

import { ShapeError } from '../schema';
import type { LumoMasterKeyRow, LumoStoredSession, LumoUserKey, LumoWireConversation, LumoWireMessage, LumoWireSpace } from './types';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v !== '';

function row(v: unknown, what: string): Row {
	if (!isRow(v)) throw new ShapeError(`${what} is not an object`);
	return v;
}

/** Proton answers Code 1000 for a single result and 1001 for a list of them. */
export function checkEnvelope(v: unknown, what: string): Row {
	const r = row(v, what);
	if (r.Code !== 1000 && r.Code !== 1001) throw new ShapeError(`${what} has code ${String(r.Code)}`);
	return r;
}

function list(v: unknown, what: string): unknown[] {
	if (!Array.isArray(v)) throw new ShapeError(`${what} is not a list`);
	return v as unknown[];
}

export function isoTime(v: unknown, what: string): string {
	const ms = text(v) ? Date.parse(v) : NaN;
	if (Number.isNaN(ms)) throw new ShapeError(`${what} is not a date`);
	return new Date(ms).toISOString();
}

function checkMessage(v: unknown): LumoWireMessage {
	const r = row(v, 'message');
	if (!text(r.ID) || !text(r.MessageTag) || typeof r.Role !== 'number') throw new ShapeError('message lacks its ID, tag or role');
	isoTime(r.CreateTime, 'message time');
	return r as unknown as LumoWireMessage;
}

function checkConversationRow(v: unknown): LumoWireConversation {
	const r = row(v, 'conversation');
	if (!text(r.ID) || !text(r.ConversationTag)) throw new ShapeError('conversation lacks its ID or tag');
	isoTime(r.CreateTime, 'conversation time');
	if (r.Messages !== undefined && r.Messages !== null) list(r.Messages, 'messages').forEach(checkMessage);
	return r as unknown as LumoWireConversation;
}

function checkSpace(v: unknown): LumoWireSpace {
	const r = row(v, 'space');
	if (!text(r.ID) || !text(r.SpaceTag) || !text(r.SpaceKey)) throw new ShapeError('space lacks its ID, tag or key');
	isoTime(r.CreateTime, 'space time');
	if (r.Conversations !== undefined && r.Conversations !== null) list(r.Conversations, 'conversations').forEach(checkConversationRow);
	return r as unknown as LumoWireSpace;
}

export function checkSpaces(v: unknown): LumoWireSpace[] {
	return list(checkEnvelope(v, 'space list').Spaces, 'Spaces').map(checkSpace);
}

export function checkConversation(v: unknown): LumoWireConversation {
	return checkConversationRow(checkEnvelope(v, 'conversation').Conversation);
}

export function checkFullMessage(v: unknown): LumoWireMessage {
	return checkMessage(checkEnvelope(v, 'message').Message);
}

export function checkMasterKeys(v: unknown): LumoMasterKeyRow[] {
	return list(checkEnvelope(v, 'master key list').MasterKeys ?? [], 'MasterKeys').map((k) => {
		const key = row(k, 'master key');
		if (!text(key.MasterKey)) throw new ShapeError('master key entry is empty');
		return key as unknown as LumoMasterKeyRow;
	});
}

export function checkUser(v: unknown): { id: string; keys: LumoUserKey[] } {
	const user = row(checkEnvelope(v, 'user').User, 'User');
	if (!text(user.ID)) throw new ShapeError('user has no ID');
	const keys = list(user.Keys, 'Keys').map((k) => {
		const key = row(k, 'user key');
		if (!text(key.PrivateKey)) throw new ShapeError('user key is empty');
		return key as unknown as LumoUserKey;
	});
	return { id: user.ID, keys };
}

export function checkClientKey(v: unknown): string {
	const key = checkEnvelope(v, 'session key').ClientKey;
	if (!text(key)) throw new ShapeError('session key is empty');
	return key;
}

/** The saved session in the page's localStorage, or null if a row is not one. */
export function parseStoredSession(json: string): LumoStoredSession | null {
	try {
		const r: unknown = JSON.parse(json);
		return isRow(r) && text(r.UID) && text(r.blob) ? r as unknown as LumoStoredSession : null;
	} catch {
		return null;
	}
}
