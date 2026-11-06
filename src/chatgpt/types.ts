// Shapes of chatgpt.com's JSON we rely on, as seen in Firefox DevTools (2026-11-06).
// Only the fields we use; the raw .json keeps everything else untouched.

/** One entry of GET /backend-api/conversations?…&offset=N */
export interface GptListItem {
	id: string;
	title: string | null;
	/** ISO date, e.g. "2026-10-27T13:14:06.272528Z" */
	create_time: string;
	update_time: string;
	/** "g-p-…" when the chat is in a project, else null. */
	gizmo_id: string | null;
	/** null for normal chats, "tpp" for some (they are listed separately). */
	conversation_origin?: string | null;
}

export interface GptListPage {
	items: GptListItem[];
	total: number;
	limit: number;
	offset: number;
}

export interface GptPart {
	content_type?: string;
	asset_pointer?: string;
	mime_type?: string;
	size_bytes?: number;
	[key: string]: unknown;
}

export interface GptAttachment {
	id?: string;
	name?: string;
	size?: number;
	mime_type?: string;
}

export interface GptMessage {
	id: string;
	author: { role: string; name?: string | null };
	/** Unix seconds */
	create_time?: number | null;
	content: {
		content_type: string;
		parts?: (string | GptPart)[];
		text?: string;
		language?: string;
	};
	metadata?: {
		is_visually_hidden_from_conversation?: boolean;
		attachments?: GptAttachment[];
		image_gen_title?: string;
		[key: string]: unknown;
	};
	recipient?: string;
	channel?: string | null;
}

/** GET /backend-api/conversations/<id>?num_turns=…&include_has_versions=true */
export interface GptChat {
	conversation_id: string;
	title: string | null;
	/** Unix seconds */
	create_time: number;
	update_time: number;
	gizmo_id: string | null;
	messages: GptMessage[];
	current_node?: string;
	/** start_cursor = oldest message loaded; has_previous_page = older messages exist. */
	page_info?: { start_cursor?: string; has_previous_page?: boolean; has_next_page?: boolean };
}

export interface GptProject {
	id: string;
	name: string;
}
