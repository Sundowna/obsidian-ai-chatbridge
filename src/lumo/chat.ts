// Turns Lumo's encrypted records into readable chats. Pure code, testable offline.

import { ShapeError } from '../schema';
import type { ListItem } from '../types';
import { conversationAd, decryptJson, messageAd, spaceAd, spaceDataKey } from './crypto';
import { isoTime } from './schema';
import { SPACE_TYPE_DEFAULT, SPACE_TYPE_PROJECT, type LumoChat, type LumoMessage, type LumoWireConversation, type LumoWireAsset, type LumoWireMessage, type LumoWireSpace } from './types';

export interface LumoEntry {
	item: ListItem;
	spaceTag: string;
	conversationTag: string;
	starred: boolean;
	dek: CryptoKey;
	/** The files of the chat's space (shared by all its chats), without content. */
	assets?: LumoWireAsset[];
	/** How many chats the space has: with one, every file Lumo made there is that chat's. */
	spaceChats?: number;
}

export interface LumoListing {
	entries: LumoEntry[];
	/** Every project, including ones with no chats yet. */
	projects: NonNullable<ListItem['project']>[];
	/** Chats that could not be decrypted, so are left out. */
	failed: number;
}

const isRow = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const liveConversations = (s: LumoWireSpace) => (s.Conversations ?? []).filter((c) => !c.DeleteTime);

/**
 * The project this space is, or null. Older records have no SpaceType (Proton's client says
 * so), so for those the decrypted details decide. Throws only if a marked project is unreadable.
 */
async function projectOf(space: LumoWireSpace, dek: CryptoKey): Promise<ListItem['project']> {
	const marked = space.SpaceType === SPACE_TYPE_PROJECT;
	const unmarked = space.SpaceType === undefined || space.SpaceType === null || space.SpaceType === SPACE_TYPE_DEFAULT;
	if (!space.Encrypted || (!marked && !unmarked)) return null;
	let priv: unknown;
	try {
		priv = await decryptJson(dek, space.Encrypted, spaceAd(space.SpaceTag));
	} catch (e) {
		if (marked) throw e;
		return null; // as before: its chats are still listed, just without a project
	}
	const raw = isRow(priv) ? priv.projectName : undefined;
	const name = typeof raw === 'string' && raw.trim() ? raw : undefined;
	if (!marked && !name && !(isRow(priv) && priv.isProject === true)) return null;
	return { uuid: space.ID, name: name ?? 'Project' };
}

/** Every chat that exists, with its title decrypted. */
export async function decryptListing(spaces: readonly LumoWireSpace[], masterKeys: readonly CryptoKey[]): Promise<LumoListing> {
	const entries: LumoEntry[] = [];
	const projects: LumoListing['projects'] = [];
	let failed = 0;
	for (const space of spaces) {
		if (space.DeleteTime) continue;
		const conversations = liveConversations(space);
		const dek = await spaceDataKey(space.SpaceKey, masterKeys);
		if (!dek) {
			failed += conversations.length;
			continue;
		}
		let project: ListItem['project'] = null;
		try {
			project = await projectOf(space, dek);
		} catch {
			failed += conversations.length;
			continue;
		}
		if (project) projects.push(project);
		// An entry that is not a usable asset row is left out; files never stop the listing.
		const assets = (Array.isArray(space.Assets) ? space.Assets : []).filter((a): a is LumoWireAsset => isRow(a) && typeof a.ID === 'string' && !!a.ID && typeof a.AssetTag === 'string' && !!a.AssetTag && !a.DeleteTime);
		for (const c of conversations) {
			try {
				const priv = c.Encrypted ? await decryptJson(dek, c.Encrypted, conversationAd(c.ConversationTag, space.SpaceTag)) : {};
				const title = isRow(priv) ? priv.title : undefined;
				entries.push({
					item: {
						uuid: c.ID,
						name: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled',
						created_at: isoTime(c.CreateTime, 'conversation time'),
						updated_at: isoTime(c.UpdateTime ?? c.CreateTime, 'conversation time'),
						project,
					},
					spaceTag: space.SpaceTag,
					conversationTag: c.ConversationTag,
					starred: c.IsStarred === true,
					dek,
					assets,
					spaceChats: conversations.length,
				});
			} catch (e) {
				if (e instanceof ShapeError) throw e;
				failed++;
			}
		}
	}
	return { entries, projects, failed };
}

const ROLE: Record<number, LumoMessage['role']> = { 1: 'user', 2: 'assistant' };

/** Messages may list only their outline; this says which need fetching one by one. */
export function shallowMessages(c: LumoWireConversation): LumoWireMessage[] {
	return (c.Messages ?? []).filter((m) => !m.Encrypted);
}

/** One whole chat. Throws if any message cannot be decrypted, so a chat is never half-saved. */
export async function decryptChat(entry: LumoEntry, c: LumoWireConversation): Promise<LumoChat> {
	const wire = c.Messages ?? [];
	const tagOf = new Map(wire.map((m) => [m.ID, m.MessageTag]));
	const messages: LumoMessage[] = [];
	for (const m of wire) {
		const role = ROLE[m.Role];
		if (!role) throw new ShapeError(`message has unknown role ${m.Role}`);
		const parentTag = tagOf.get(m.ParentID ?? m.ParentId ?? '');
		const priv = m.Encrypted ? await decryptJson(entry.dek, m.Encrypted, messageAd(m.MessageTag, role, entry.conversationTag, parentTag)) : {};
		messages.push({
			id: m.MessageTag,
			...(parentTag ? { parentId: parentTag } : {}),
			role,
			...(m.Status === 1 ? { status: 'failed' as const } : m.Status === 2 ? { status: 'succeeded' as const } : {}),
			createdAt: isoTime(m.CreateTime, 'message time'),
			private: isRow(priv) ? priv : {},
		});
	}
	messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return {
		id: entry.item.uuid,
		spaceId: entry.spaceTag,
		title: entry.item.name,
		...(entry.item.project ? { project: entry.item.project.name } : {}),
		starred: entry.starred,
		createdAt: entry.item.created_at,
		updatedAt: entry.item.updated_at,
		messages,
	};
}

/** A project's own instructions for Lumo (AI memory). */
export interface LumoProjectInstructions {
	name: string;
	instructions: string;
	/** Marked private in Lumo, or named "Private": counted, never read into a note. */
	private: boolean;
}

/**
 * Every project with instructions, read from the space's own record (`projectInstructions`,
 * Proton's ProjectSpacePriv). Spaces that are not projects, cannot be opened or say nothing
 * are left out; `unreadable` counts the projects whose record could not be opened.
 */
export async function projectInstructions(spaces: readonly LumoWireSpace[], masterKeys: readonly CryptoKey[]): Promise<{ projects: LumoProjectInstructions[]; unreadable: number }> {
	const projects: LumoProjectInstructions[] = [];
	let unreadable = 0;
	for (const space of spaces) {
		if (space.DeleteTime || !space.Encrypted) continue;
		const marked = space.SpaceType === SPACE_TYPE_PROJECT;
		const dek = await spaceDataKey(space.SpaceKey, masterKeys);
		let priv: unknown;
		try {
			if (!dek) throw new Error('no key');
			priv = await decryptJson(dek, space.Encrypted, spaceAd(space.SpaceTag));
		} catch {
			if (marked) unreadable++;
			continue;
		}
		if (!isRow(priv)) continue;
		const isProject = marked || typeof priv.projectName === 'string' || priv.isProject === true;
		const text = typeof priv.projectInstructions === 'string' ? priv.projectInstructions : '';
		if (!isProject || !text.trim()) continue;
		const name = typeof priv.projectName === 'string' && priv.projectName.trim() ? priv.projectName.trim().replace(/[\r\n/\\]+/g, ' ') : 'Project';
		projects.push({ name, instructions: text, private: priv.isPrivate === true || name.split(/\s+/).some((w) => w.toLowerCase() === 'private') });
	}
	projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { projects, unreadable };
}
