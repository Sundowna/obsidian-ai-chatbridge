/** Positive list observations. A chat can appear in both lists while the service is changing. */
export class ArchiveObservations {
	private readonly seen = new Map<string, boolean | null>();

	add(id: string, archived: boolean, explicit?: boolean): void {
		const previous = this.seen.get(id);
		this.seen.set(id, (previous !== undefined && previous !== archived) || (explicit !== undefined && explicit !== archived) ? null : archived);
	}

	get(id: string): boolean | null | undefined {
		return this.seen.get(id);
	}
}
