import assert from 'node:assert/strict';
import { accountInventory, completeInventoryJob, scanInventory, type Inventories, type ScanStats } from '../src/chatgpt/inventory';
import { inventoryIdentity } from '../src/chatgpt/token';
import type { GptListItem } from '../src/chatgpt/types';
import { ArchiveObservations } from '../src/archive-state';

const now = Date.parse('2026-11-06T12:00:00Z');
const iso = (value: number) => new Date(value).toISOString();
function row(id: number, time: number): GptListItem {
	return {
		id: '12345678-1234-1234-1234-' + id.toString(16).padStart(12, '0'),
		title: 'Fixture ' + id,
		create_time: iso(now - 86_400_000),
		update_time: iso(time),
		gizmo_id: null,
	};
}
const normal = Array.from({ length: 180 }, (_, i) => row(i, now - i * 120_000));
const tpp = Array.from({ length: 60 }, (_, i) => row(i + 1000, now - i * 120_000));
const archived = [row(2000, now - 3_600_000)];
// Pinned chats come only from the is_starred=true lists (issue #32).
const pinned = [row(3000, now - 1_800_000)];

async function testArchiveDiscovery() {
	const inventory = accountInventory({ accounts: {} }, 'account:archive', 'separate');
	const old = row(7654, now - 2 * 86_400_000);
	const newer = Array.from({ length: 60 }, (_, i) => row(8000 + i, now - i * 60_000));
	let isArchived = false;
	let contradict = false;
	let interrupt = true;
	const scan = async (time: number) => {
		const stats: ScanStats = { requests: 0, fullLists: 0, incrementalLists: 0, seen: new Set() };
		await scanInventory(inventory, {
			archived: true, pinned: false, archive: new ArchiveObservations(), forceFull: false, now: time, overlapMinutes: 10,
			needsCapture: () => false, save: async () => {},
			fetch: async (offset, tpp, archived) => {
				if (interrupt && tpp && archived) throw new Error('archive list interrupted');
				const list = tpp ? [] : [...newer, ...(archived === isArchived || contradict ? [old] : [])];
				return { offset, total: list.length, items: list.slice(offset, offset + 20) };
			},
		}, stats);
		return stats;
	};
	await assert.rejects(scan(now), /archive list interrupted/);
	assert.equal(inventory.known[old.id]?.archived, undefined);
	assert.equal(inventory.archiveReady, undefined);
	interrupt = false;
	assert.equal((await scan(now + 1)).fullLists, 4);
	assert.equal(inventory.known[old.id]?.archived, false);
	isArchived = true;
	assert.equal((await scan(now + 2)).fullLists, 0);
	assert.equal(inventory.known[old.id]?.archived, false, 'outside overlap until a full scan');
	const week = 7 * 86_400_000;
	assert.equal((await scan(now + week + 1)).fullLists, 4);
	assert.equal(inventory.known[old.id]?.archived, true);
	assert.equal(inventory.known[old.id]?.item.update_time, old.update_time);
	contradict = true;
	assert.equal((await scan(now + 2 * week + 1)).fullLists, 4);
	assert.equal(inventory.known[old.id]?.archived, null);
	assert.deepEqual(inventory.queue, {});
}

async function main() {
	await testArchiveDiscovery();
	const jwt = (sub: string, workspace?: string) => 'x.' + Buffer.from(JSON.stringify({
		sub, 'https://api.openai.com/auth': { chatgpt_account_id: workspace },
	})).toString('base64url') + '.signature';
	assert.deepEqual(inventoryIdentity(jwt('user-a', 'personal'), 'team-a'), ['user-a', 'team-a']);
	assert.deepEqual(inventoryIdentity(jwt('user-b', 'personal'), null), ['user-b', 'personal']);
	assert.equal(inventoryIdentity(jwt('user-b'), null), null);

	let storage: Inventories = { accounts: {} };
	let persisted = structuredClone(storage);
	let inventory = accountInventory(storage, 'account:a', 'scope:active');
	const captured = new Set<string>();
	let normalRows = [...normal];
	let failAtOffset: number | undefined = 18;
	let startOffsets: number[] = [];
	let failCheckpoint = false;
	let moveHeadOnSecondPage: GptListItem | undefined;
	let previousSavedJobCount = 0;
	const scan = async ({ force = false, archive = false, pin = true, time = now } = {}) => {
		const stats: ScanStats = { requests: 0, fullLists: 0, incrementalLists: 0, seen: new Set(), pinned: new Set() };
		await scanInventory(inventory, {
			forceFull: force, archived: archive, pinned: pin, overlapMinutes: 10, now: time,
			needsCapture: (item) => !captured.has(item.id + '/' + item.update_time),
			save: async () => {
				if (failCheckpoint && inventory.checkpoints['active-normal']) throw new Error('checkpoint write interrupted');
				assert(Object.keys(inventory.queue).length >= previousSavedJobCount);
				previousSavedJobCount = Object.keys(inventory.queue).length;
				persisted = structuredClone(storage);
			},
			fetch: async (offset, isTpp, isArchived, isPinned) => {
				startOffsets.push(offset);
				if (offset === failAtOffset) throw new Error('listing interrupted');
				if (!isTpp && !isArchived && offset === 18 && moveHeadOnSecondPage) {
					normalRows = [moveHeadOnSecondPage, ...normalRows];
					moveHeadOnSecondPage = undefined;
				}
				const list = isArchived ? (isTpp ? [] : archived) : isPinned ? (isTpp ? [] : pinned) : isTpp ? tpp : normalRows;
				return { offset, total: list.length, items: list.slice(offset, offset + 20) };
			},
		}, stats);
		return stats;
	};
	const restart = () => {
		storage = structuredClone(persisted);
		inventory = storage.accounts['account:a']!;
	};

	await assert.rejects(scan(), /listing interrupted/);
	restart();
	assert.equal(Object.keys(inventory.queue).length, 20);
	assert.equal(inventory.checkpoints['active-normal'], undefined);
	failAtOffset = undefined;
	startOffsets = [];
	failCheckpoint = true;
	await assert.rejects(scan(), /checkpoint write interrupted/);
	assert.equal(inventory.checkpoints['active-normal'], undefined);
	restart();
	assert.equal(Object.keys(inventory.queue).length, normal.length);
	assert.equal(inventory.checkpoints['active-normal'], undefined);
	assert.equal(startOffsets[0], 0);

	failCheckpoint = false;
	const bootstrap = await scan();
	assert.equal(bootstrap.requests, 16);
	assert.equal(bootstrap.fullLists, 4);
	assert.equal(Object.keys(inventory.queue).length, 241);
	assert.equal(inventory.queue[pinned[0]!.id]?.id, pinned[0]!.id, 'pinned chat is found');
	assert(inventory.checkpoints['pinned-normal'] && inventory.checkpoints['pinned-tpp']);
	for (const item of Object.values(inventory.queue)) {
		captured.add(item.id + '/' + item.update_time);
		completeInventoryJob(inventory, item.id, item.update_time);
	}
	previousSavedJobCount = 0;
	const quiet = await scan();
	assert.equal(quiet.requests, 6);
	// The pinned lists are read whole every run (2026-11-27), the others incrementally; same requests as before.
	assert.equal(quiet.incrementalLists, 2);
	assert.equal(quiet.fullLists, 2);
	assert.deepEqual([...quiet.pinned!], [pinned[0]!.id], 'the pinned set is complete each run');
	assert.equal(Object.keys(inventory.queue).length, 0);

	const edited = { ...normal.at(-1)!, update_time: iso(now + 1000) };
	const tie = row(500, now - 10 * 60_000);
	normalRows = [edited, ...normal.slice(0, -1), tie].sort((a, b) => Date.parse(b.update_time) - Date.parse(a.update_time));
	await scan({ time: now + 1000 });
	assert.equal(inventory.queue[edited.id]?.update_time, edited.update_time);
	assert.equal(inventory.queue[tie.id]?.update_time, tie.update_time);
	completeInventoryJob(inventory, edited.id, normal.at(-1)!.update_time);
	assert.equal(inventory.queue[edited.id]?.update_time, edited.update_time);
	assert(inventory.known[normal[150]!.id]);

	// A changed order on the first page requires a full traversal.
	[normalRows[1], normalRows[2]] = [normalRows[2]!, normalRows[1]!];
	const disordered = await scan({ time: now + 1000 });
	assert.equal(disordered.fullLists, 3, 'the disordered list, plus the two pinned lists read whole every run');
	assert.equal(disordered.requests, 14);
	assert.equal(inventory.checkpoints['active-normal']?.watermark, null);
	normalRows.sort((a, b) => Date.parse(b.update_time) - Date.parse(a.update_time));

	const manual = await scan({ force: true, time: now + 2000 });
	assert.equal(manual.fullLists, 4);
	assert.equal(inventory.manual?.length, 0);
	const weekly = await scan({ time: now + 2000 + 7 * 86_400_000 });
	assert.equal(weekly.fullLists, 4);

	const inserted = row(800, now + 3000);
	moveHeadOnSecondPage = inserted;
	const moving = await scan({ force: true, time: now + 3000 + 7 * 86_400_000 });
	assert.equal(moving.seen.size, 242);
	assert(!moving.seen.has(inserted.id));
	await scan({ time: now + 4000 + 7 * 86_400_000 });
	assert.equal(inventory.queue[inserted.id]?.id, inserted.id);

	const secondAccount = accountInventory(storage, 'account:b', 'scope:active');
	assert.equal(Object.keys(secondAccount.queue).length, 0);
	assert.equal(Object.keys(secondAccount.checkpoints).length, 0);
	const oldGeneration = inventory.generation;
	inventory = accountInventory(storage, 'account:a', 'scope:archived');
	assert.equal(inventory.generation, oldGeneration + 1);
	assert.equal(Object.keys(inventory.checkpoints).length, 0);
	assert(inventory.queue[edited.id]);
	const expanded = await scan({ archive: true });
	assert.equal(expanded.fullLists, 6);
	assert.equal(inventory.queue[archived[0]!.id]?.id, archived[0]!.id);
	assert.equal(inventory.known[archived[0]!.id]?.generation, inventory.generation);

	// Include pinned chats off: the pinned lists are not requested at all.
	inventory = accountInventory(storage, 'account:c', 'scope:no-pinned');
	previousSavedJobCount = 0;
	startOffsets = [];
	const unpinned = await scan({ pin: false });
	assert.equal(unpinned.fullLists, 2);
	assert(!unpinned.seen.has(pinned[0]!.id));
	assert.equal(inventory.checkpoints['pinned-normal'], undefined);
	assert.equal(unpinned.pinned!.size, 0, 'pinned lists off: nothing is known as pinned');
	assert.equal(inventory.queue[pinned[0]!.id], undefined);
	console.log(`Inventory tests passed. Quiet run: ${quiet.requests} chat-list requests vs ${bootstrap.requests} for full discovery of 241 rows.`);
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
