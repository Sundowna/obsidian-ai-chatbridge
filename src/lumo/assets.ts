// The files of a Lumo chat: what you uploaded and what Lumo made (artifacts, pictures).
// Lumo keeps each as an encrypted "asset" of the chat's space (Proton's client: types.ts
// Attachment, serialization.ts deserializeAttachment). Pure code, testable offline.

import { StopError } from '../api';
import type { FileKind } from '../files';
import { ShapeError } from '../schema';
import { attachmentAd, decryptBlob } from './crypto';
import type { LumoEntry } from './chat';
import { unpack } from './msgpack';
import { ASSET_GENERATED_DOC, ASSET_GENERATED_IMAGE, type LumoChat, type LumoMessage, type LumoWireAsset } from './types';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** One asset, decrypted. */
export interface LumoAssetContent {
	filename: string;
	/** The file's bytes; for a picture, the reduced copy Lumo keeps. */
	data?: Uint8Array<ArrayBuffer>;
	/** Lumo's text conversion of the file. */
	markdown?: string;
	mimeType?: string;
	role?: string;
	/** Lumo fetched it from Proton Drive by itself; not something of this chat. */
	autoRetrieved: boolean;
	/** Set when the asset is an artifact Lumo made. */
	artifact?: { conversationId?: string; artifactId?: string; title?: string; type?: string };
}

/** Decrypts one asset with its space's key. Throws when the key, the tag or the content is wrong. */
export async function decryptAsset(dek: CryptoKey, asset: Pick<LumoWireAsset, 'AssetTag' | 'Encrypted'>): Promise<LumoAssetContent> {
	if (!asset.Encrypted) throw new ShapeError('file has no content');
	const v = unpack(await decryptBlob(dek, asset.Encrypted, attachmentAd(asset.AssetTag)));
	if (!isRow(v)) throw new ShapeError('file content is not an object');
	const meta = isRow(v.generatedArtifactAsset) ? v.generatedArtifactAsset : undefined;
	return {
		filename: text(v.filename) ?? '',
		...(v.data instanceof Uint8Array && v.data.byteLength ? { data: v.data as Uint8Array<ArrayBuffer> } : {}),
		...(typeof v.markdown === 'string' && v.markdown ? { markdown: v.markdown } : {}),
		...(text(v.mimeType) ? { mimeType: text(v.mimeType) } : {}),
		...(text(v.role) ? { role: text(v.role) } : {}),
		autoRetrieved: v.autoRetrieved === true,
		...(meta ? { artifact: { conversationId: text(meta.conversationId), artifactId: text(meta.artifactId), title: text(meta.artifactTitle), type: text(meta.artifactType) } } : {}),
	};
}

/** An artifact as the chat itself holds it: a `create_artifact` tool step with the whole text. */
export interface ChatArtifact {
	id: string;
	title: string;
	type?: string;
	language?: string;
	content: string;
	messageId: string;
}

function toolCall(block: unknown): Row | undefined {
	if (!isRow(block) || block.type !== 'tool_call') return undefined;
	if (isRow(block.toolCall)) return block.toolCall;
	if (typeof block.content !== 'string') return undefined;
	try {
		const v: unknown = JSON.parse(block.content);
		return isRow(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** The artifacts one message made, in order. */
export function messageArtifacts(m: LumoMessage): ChatArtifact[] {
	const blocks = Array.isArray(m.private.blocks) ? m.private.blocks as unknown[] : [];
	const out: ChatArtifact[] = [];
	for (const b of blocks) {
		const call = toolCall(b);
		const args = call?.name === 'create_artifact' && isRow(call.arguments) ? call.arguments : undefined;
		const id = args && text(args.id);
		if (!args || !id || typeof args.content !== 'string') continue;
		out.push({ id, title: text(args.title) ?? id, type: text(args.type), language: text(args.language), content: args.content, messageId: m.id });
	}
	return out;
}

/** Every artifact of the chat; made again under the same id, the newest text wins. */
export function chatArtifacts(chat: LumoChat): ChatArtifact[] {
	const byId = new Map<string, ChatArtifact>();
	for (const m of chat.messages) for (const a of messageArtifacts(m)) byId.set(a.id, a);
	return [...byId.values()];
}

/** The asset tags a message names as its attachments. */
export function messageAttachments(m: LumoMessage): string[] {
	const list = Array.isArray(m.private.attachments) ? m.private.attachments as unknown[] : [];
	return list.flatMap((a) => (isRow(a) && text(a.id) ? [a.id as string] : []));
}

/** Index key of an uploaded (or otherwise attached) file: the asset's tag. */
export const attachmentKey = (tag: string): string => tag;
/** Index key of an artifact of one chat. */
export const artifactKey = (chatId: string, artifactId: string): string => `artifact:${chatId}:${artifactId}`;
/** Index key of a file Lumo made that no message and no artifact names. */
export const extraKey = (chatId: string, tag: string): string => `extra:${chatId}:${tag}`;
/** Index key that says "this asset is saved", whatever it is. */
export const assetKey = (assetId: string): string => `asset:${assetId}`;

const EXT_BY_LANGUAGE: Record<string, string> = {
	csv: 'csv', tsv: 'tsv', json: 'json', markdown: 'md', md: 'md', html: 'html', xml: 'xml', svg: 'svg', css: 'css', yaml: 'yaml', yml: 'yml', toml: 'toml',
	javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py', py: 'py', java: 'java', kotlin: 'kt', swift: 'swift', go: 'go', rust: 'rs',
	c: 'c', cpp: 'cpp', csharp: 'cs', php: 'php', ruby: 'rb', bash: 'sh', shell: 'sh', sh: 'sh', powershell: 'ps1', sql: 'sql', r: 'r', lua: 'lua', latex: 'tex', mermaid: 'mmd', text: 'txt', txt: 'txt',
};
const EXT_BY_TYPE: Record<string, string> = { markdown: 'md', document: 'md', html: 'html', svg: 'svg', mermaid: 'mmd', csv: 'csv', json: 'json' };
const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
	'text/markdown': 'md', 'text/html': 'html', 'application/json': 'json',
};

const hasExt = (name: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(name);
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/** What a picture's first bytes say it is, or undefined when they say nothing. */
function pictureFormat(b: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | undefined {
	const at = (i: number, ...want: number[]): boolean => want.every((v, k) => b[i + k] === v);
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
	return undefined;
}

/** A file name for an artifact: its title plus an ending from its language or type (unknown: .txt). */
export function artifactFileName(a: { title: string; type?: string; language?: string }): string {
	if (hasExt(a.title)) return a.title;
	const ext = EXT_BY_LANGUAGE[(a.language ?? '').toLowerCase()] ?? EXT_BY_TYPE[(a.type ?? '').toLowerCase()] ?? 'txt';
	return `${a.title}.${ext}`;
}

/** One file ready to be written to the vault. */
export interface LumoFile {
	/** Index keys that will point at the saved file. */
	keys: string[];
	kind: FileKind;
	name: string;
	bytes: ArrayBuffer;
}

const toBuffer = (u: Uint8Array<ArrayBuffer>): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
const utf8 = (s: string): ArrayBuffer => toBuffer(new TextEncoder().encode(s));

export interface CollectedFiles {
	files: LumoFile[];
	/** Files that could not be read, for the log; tried again next time. */
	skipped: string[];
}

export interface CollectOptions {
	/** Fetches one asset with its `Encrypted` content, or null when Lumo no longer has it. */
	fetch: (assetId: string) => Promise<LumoWireAsset | null>;
	/** True when this index key already points at a file in the vault. */
	have: (key: string) => boolean;
	/** Assets read earlier in this run (a project's assets are shared by its chats). */
	cache?: Map<string, LumoAssetContent | null>;
}

/**
 * The files of one chat that are not saved yet: its messages' attachments, the files Lumo made
 * for it, and (when Lumo has no asset for one) its artifacts from the chat's own text.
 */
export async function collectFiles(entry: LumoEntry, chat: LumoChat, o: CollectOptions): Promise<CollectedFiles> {
	const out: CollectedFiles = { files: [], skipped: [] };
	const attached = new Set(chat.messages.flatMap(messageAttachments));
	const artifacts = chatArtifacts(chat);
	const savedArtifacts = new Set(artifacts.filter((a) => o.have(artifactKey(chat.id, a.id))).map((a) => a.id));
	let unreadGenerated = false;
	const byAge = [...(entry.assets ?? [])].sort((a, b) => (a.CreateTime ?? '').localeCompare(b.CreateTime ?? ''));

	for (const asset of byAge) {
		if (asset.DeleteTime) continue;
		const isAttached = attached.has(asset.AssetTag);
		const generated = asset.AssetType === ASSET_GENERATED_DOC || asset.AssetType === ASSET_GENERATED_IMAGE;
		if ((!isAttached && !generated) || o.have(assetKey(asset.ID))) continue;
		let content = o.cache?.get(asset.ID);
		if (content === undefined) {
			try {
				const full = await o.fetch(asset.ID);
				content = full && !full.DeleteTime && full.Encrypted ? await decryptAsset(entry.dek, { AssetTag: asset.AssetTag, Encrypted: full.Encrypted }) : null;
			} catch (e) {
				// Not logged in, rate limited, stopped by you: the sync stops. A file that cannot be
				// decrypted or read is skipped and tried again next time.
				if (e instanceof StopError) throw e;
				out.skipped.push(`a file of "${chat.title}" could not be read, will retry`);
				if (!isAttached) unreadGenerated = true;
				continue;
			}
			o.cache?.set(asset.ID, content);
		}
		if (!content || content.autoRetrieved) continue;
		const art = content.artifact;
		if (!isAttached) {
			// A file Lumo made: this chat's only if it says so, or if the space has no other chat.
			if (art?.conversationId ? art.conversationId !== entry.conversationTag : entry.spaceChats !== 1) continue;
		}
		const bytes = content.data ? toBuffer(content.data) : content.markdown !== undefined ? utf8(content.markdown) : null;
		if (!bytes) {
			out.skipped.push(`"${content.filename || 'a file'}" of "${chat.title}" has no content at Lumo`);
			continue;
		}
		const known = art?.artifactId ? artifacts.find((a) => a.id === art.artifactId) : undefined;
		const fromLumo = generated || content.role === 'assistant' || !!art;
		let name = content.filename || art?.title || known?.title || 'file';
		if (!hasExt(name)) {
			// An artifact's language says more than its type (Lumo calls a CSV "text/plain", seen live).
			const byLanguage = EXT_BY_LANGUAGE[(known?.language ?? '').toLowerCase()];
			const ext = byLanguage ?? EXT_BY_MIME[(content.mimeType ?? '').toLowerCase()];
			name = ext ? `${name}.${ext}` : art || known ? artifactFileName({ title: name, type: art?.type ?? known?.type }) : content.data ? name : `${name}.md`;
		} else if (!content.data && content.markdown !== undefined && !/\.(md|markdown|txt|csv|json|html?|xml|svg)$/i.test(name) && !art) {
			name = `${name}.md`; // only Lumo's text conversion is left of a binary upload
		}
		// Lumo names an artifact's file "<title>.txt" whatever it holds (a CSV, seen live): the
		// artifact's language in the chat says what it is.
		const spoken = EXT_BY_LANGUAGE[(known?.language ?? '').toLowerCase()];
		if (spoken && spoken !== 'txt' && /\.txt$/i.test(name)) name = name.replace(/\.txt$/i, `.${spoken}`);
		// Lumo keeps a reduced copy of a picture, sometimes in another format under the old name.
		const real = content.data ? pictureFormat(content.data) : undefined;
		if (real && IMAGE_NAME.test(name) && !new RegExp(`\\.${real === 'jpg' ? 'jpe?g' : real}$`, 'i').test(name)) name = name.replace(IMAGE_NAME, `.${real}`);
		const keys = [assetKey(asset.ID)];
		if (isAttached) keys.push(attachmentKey(asset.AssetTag));
		if (art?.artifactId) {
			keys.push(artifactKey(chat.id, art.artifactId));
			savedArtifacts.add(art.artifactId);
		} else if (!isAttached) keys.push(extraKey(chat.id, asset.AssetTag));
		out.files.push({ keys, kind: fromLumo ? 'artifact' : 'attachment', name, bytes });
	}

	// Artifacts Lumo has no file for: their text is in the chat itself. Not while a file Lumo
	// made is still unread: it may be that artifact, and would then be saved twice.
	for (const a of unreadGenerated ? [] : artifacts) {
		if (savedArtifacts.has(a.id)) continue;
		out.files.push({ keys: [artifactKey(chat.id, a.id)], kind: 'artifact', name: artifactFileName(a), bytes: utf8(a.content) });
	}
	return out;
}

/** True when the chat's own text names a file: an attachment or an artifact. */
export function namesFiles(chat: LumoChat): boolean {
	return chat.messages.some((m) => messageAttachments(m).length > 0 || messageArtifacts(m).length > 0);
}
