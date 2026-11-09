// Lumo's API shapes, from Proton's published client (remote/types.ts). Only the fields we use.

export interface LumoStoredSession {
	UID: string;
	UserID?: string;
	blob: string;
	payloadVersion?: number;
	persistedAt?: number;
}

export interface LumoUserKey {
	PrivateKey: string;
	Primary?: number;
	Active?: number;
}

export interface LumoMasterKeyRow {
	MasterKey: string;
	IsLatest?: boolean;
	Version?: number;
	CreateTime?: string;
}

export interface LumoWireMessage {
	ID: string;
	ConversationID?: string;
	CreateTime: string;
	Role: number;
	ParentID?: string | null;
	ParentId?: string | null;
	Status?: number;
	Encrypted?: string | null;
	MessageTag: string;
}

export interface LumoWireConversation {
	ID: string;
	SpaceID?: string;
	CreateTime: string;
	UpdateTime?: string | null;
	DeleteTime?: string | null;
	IsStarred?: boolean;
	Encrypted?: string | null;
	ConversationTag: string;
	Messages?: LumoWireMessage[];
}

export interface LumoWireSpace {
	ID: string;
	/** Absent on older records. */
	SpaceType?: number | null;
	CreateTime: string;
	UpdateTime?: string | null;
	DeleteTime?: string | null;
	Encrypted?: string | null;
	SpaceKey: string;
	SpaceTag: string;
	Conversations?: LumoWireConversation[];
}

export const SPACE_TYPE_DEFAULT = 0;
export const SPACE_TYPE_PROJECT = 1;

/** A message with its text decrypted, as saved in the chat's .json file. */
export interface LumoMessage {
	id: string;
	parentId?: string;
	role: 'user' | 'assistant';
	status?: 'succeeded' | 'failed';
	createdAt: string;
	/** Everything Lumo stored for this message: content, reasoning, tool calls and so on. */
	private: Record<string, unknown>;
}

/** What a chat's .json file holds: readable text, no keys and no encrypted blobs. */
export interface LumoChat {
	id: string;
	spaceId: string;
	title: string;
	project?: string;
	starred: boolean;
	createdAt: string;
	updatedAt: string;
	messages: LumoMessage[];
}
