// Runs the Browser link server only while at least one account uses it, and only on a computer.
// The server module (and the Node modules it needs) is loaded the first time it is wanted, so
// the plugin still loads on phones and tablets.

import type { LinkServer, LinkServerOptions } from './server';

export class LinkManager {
	private current: LinkServer | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly options: () => LinkServerOptions,
		private readonly desktop: () => boolean,
	) {}

	/** The running server, or null when no account uses the Browser link (or on a phone). */
	get server(): LinkServer | null {
		return this.current;
	}

	/** Starts or stops the server to match `wanted`; calls run one after another. */
	update(wanted: boolean): Promise<void> {
		this.queue = this.queue.then(() => this.apply(wanted)).catch(() => undefined);
		return this.queue;
	}

	private async apply(wanted: boolean): Promise<void> {
		if (wanted && this.desktop() && !this.current) {
			const { LinkServer: Server } = await import('./server');
			const s = new Server(this.options());
			await s.start();
			this.current = s;
		} else if ((!wanted || !this.desktop()) && this.current) {
			const s = this.current;
			this.current = null;
			await s.stop();
		}
	}

	/** On plugin unload. */
	stop(): Promise<void> {
		return this.update(false);
	}
}
