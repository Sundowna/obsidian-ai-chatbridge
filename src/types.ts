// Shapes of the claude.ai JSON we rely on, as seen in DevTools (2026-11-05).
// Only the fields we actually use are listed; everything else is kept untouched
// in the raw .json file anyway.

export interface ProjectRef {
	name: string;
	uuid: string;
}

/** One entry of GET /api/organizations/<org>/chat_conversations_v2 */
export interface ListItem {
	uuid: string;
	name: string;
	created_at: string;
	updated_at: string;
	project?: ProjectRef | null;
	project_uuid?: string;
	/** "CLAUDE_AI" for every chat seen so far (2026-11-05). */
	platform?: string;
}

export interface ListPage {
	data: ListItem[];
	has_more: boolean;
}

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	[key: string]: unknown;
}

export interface FileRef {
	file_name?: string;
	file_uuid?: string;
	/** "image" or "blob" (seen 2026-11-05) */
	file_kind?: string;
	size_bytes?: number;
	success?: boolean;
	[key: string]: unknown;
}

export interface ChatMessage {
	uuid: string;
	sender: string;
	text?: string;
	content?: ContentBlock[];
	created_at?: string;
	index?: number;
	parent_message_uuid?: string;
	attachments?: FileRef[];
	files?: FileRef[];
}

/** GET /api/organizations/<org>/chat_conversations/<uuid>?tree=True&rendering_mode=messages */
export interface Chat {
	uuid: string;
	name: string;
	created_at: string;
	updated_at: string;
	project_uuid?: string;
	current_leaf_message_uuid?: string;
	chat_messages: ChatMessage[];
}

/** What we remember per chat in data.json (no secrets). */
export interface IndexEntry {
	updated_at: string;
	json: string;
	md: string;
	synced: string;
	/** updated_at for which the chat-view files (ReadConversation) were last checked. */
	outputsChecked?: string;
	/** ChatGPT long chats: the older parts, each saved unchanged ("… (older 1).json" = just before the main file). */
	older?: string[];
}
