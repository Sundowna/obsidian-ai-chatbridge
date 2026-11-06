// ChatGPT list entries in the same shape as claude.ai's, so the same pure functions
// (project filter, new/changed, subfolders) work for both. Testable offline.

import type { ListItem } from '../types';
import { isProjectId } from './schema';
import type { GptListItem, GptProject } from './types';

/**
 * `projects` maps project ID -> name (from the sidebar). Only "g-p-…" IDs are projects;
 * plain "g-…" IDs are custom GPTs, whose chats ChatGPT lists with the normal chats
 * (so they go to the Recent folder). A project the sidebar did not name gets its ID as name.
 */
export function toListItems(items: GptListItem[], projects: GptProject[]): ListItem[] {
	const names = new Map(projects.map((p) => [p.id, p.name]));
	return items.map((it) => ({
		uuid: it.id,
		name: it.title?.trim() || 'Untitled',
		created_at: it.create_time,
		updated_at: it.update_time,
		project: isProjectId(it.gizmo_id) ? { uuid: it.gizmo_id, name: names.get(it.gizmo_id) ?? it.gizmo_id } : null,
	}));
}
