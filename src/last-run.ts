// What the last sync of each account surface did, so the settings can say it without a notice.
// Saved in data.json (no chat text, only counts and the stop reason).

import { setIcon } from 'obsidian';

export type RunOutcome = 'ok' | 'stopped' | 'waiting' | 'error' | 'nothing-selected';

export interface LastRun {
	/** When the run ended (ms). */
	at: number;
	trigger: 'manual' | 'auto' | 'resume';
	outcome: RunOutcome;
	/** What the run was called in its notice, such as "claude.ai (Work)". */
	label: string;
	newCount: number;
	changedCount: number;
	unchanged: number;
	restored: number;
	leftForLater: number;
	/** The stop or error reason, or a short extra (Hermes profiles not found). */
	note?: string;
}

/** The last "Sync all": its own start and end; the runs in between are its parts. */
export interface LastAll {
	start: number;
	at: number;
	trigger: 'manual' | 'auto' | 'resume';
	stopped: boolean;
}

export type RunSurface = 'web' | 'desktop' | 'studio';

/** Where a run is filed: one account's surface, all desktop apps at once, or Hermes. */
export const runKey = (surface: RunSurface, provider: string, id: string): string => `${surface}:${provider}:${id}`;
export const DESKTOP_ALL = 'desktop:all';
export const HERMES = 'hermes';

/** The newer of two runs (either may be missing). */
export function newer(a: LastRun | undefined, b: LastRun | undefined): LastRun | undefined {
	if (!a) return b;
	if (!b) return a;
	return b.at > a.at ? b : a;
}

/** A desktop surface's last run: its own, or the "all desktop apps" run if that came later. */
export function desktopRun(runs: Record<string, LastRun>, provider: string, id: string): LastRun | undefined {
	return newer(runs[runKey('desktop', provider, id)], runs[DESKTOP_ALL]);
}

/** "today 14:02", "yesterday 09:10" or "12 Nov, 14:02". */
export function when(ms: number, now = Date.now()): string {
	const d = new Date(ms);
	const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
	if (diff === 0) return `today ${clock}`;
	if (diff === 1) return `yesterday ${clock}`;
	return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock}`;
}

/** The counts in words, leaving out what is zero: "3 new, 1 changed, 240 unchanged". */
export function countsText(r: Pick<LastRun, 'newCount' | 'changedCount' | 'unchanged' | 'restored' | 'leftForLater'>): string {
	const parts: string[] = [];
	if (r.newCount) parts.push(`${r.newCount.toLocaleString()} new`);
	if (r.changedCount) parts.push(`${r.changedCount.toLocaleString()} changed`);
	if (r.restored) parts.push(`${r.restored.toLocaleString()} restored`);
	if (r.leftForLater) parts.push(`${r.leftForLater.toLocaleString()} left for next run`);
	if (r.unchanged || !parts.length) parts.push(`${r.unchanged.toLocaleString()} unchanged`);
	return parts.join(', ');
}

export type Tone = 'ok' | 'warn' | 'bad';

/** One line about a run, and how it went. */
export function runText(r: LastRun, now = Date.now()): { text: string; tone: Tone } {
	const how = r.trigger === 'manual' ? '' : ' (automatic)';
	const head = `${when(r.at, now)}${how}`;
	const saved = r.newCount + r.changedCount + r.restored;
	switch (r.outcome) {
		case 'ok': {
			const extra = r.note ? ` ${r.note}` : '';
			return { text: `${head}: ${countsText(r)}.${extra}`, tone: r.note ? 'warn' : 'ok' };
		}
		case 'nothing-selected':
			return { text: `${head}: no projects selected, so nothing was synced.`, tone: 'warn' };
		case 'stopped':
			return { text: `${head}: stopped by you${saved ? ` after ${saved.toLocaleString()} saved` : ''}. The next sync carries on.`, tone: 'warn' };
		case 'waiting':
			return { text: `${head}: waiting. ${r.note ?? ''}`.trim(), tone: 'warn' };
		case 'error':
			return { text: `${head}: failed. ${r.note ?? ''}`.trim(), tone: 'bad' };
	}
}

/** A small "Last sync" line with a coloured dot; "Not synced yet" when there is no run. */
export function lastRunLine(parent: HTMLElement, r: LastRun | undefined, prefix = 'Last sync'): HTMLElement {
	const line = parent.createDiv({ cls: 'ccs-last-run' });
	setIcon(line.createSpan({ cls: 'ccs-glyph' }), 'history');
	if (!r) {
		line.createSpan({ cls: 'ccs-last-run-text', text: `${prefix}: not synced yet` });
		return line;
	}
	const { text, tone } = runText(r);
	line.addClass(`is-${tone}`);
	line.createSpan({ cls: 'ccs-dot' });
	line.createSpan({ cls: 'ccs-last-run-text', text: `${prefix} ${text}` });
	line.setAttr('title', `${r.label}: ${text}`);
	return line;
}

/** "Sync all" in one line: when, what the parts saved, and which parts had a problem. */
export function allText(all: LastAll, runs: Record<string, LastRun>, now = Date.now()): { text: string; tone: Tone } {
	const parts = Object.values(runs).filter((r) => r.at >= all.start && r.at <= all.at + 1000);
	const sum = (f: (r: LastRun) => number) => parts.reduce((n, r) => n + f(r), 0);
	const problems = parts.filter((r) => r.outcome === 'error' || r.outcome === 'waiting');
	const head = `Last sync all ${when(all.at, now)}${all.trigger === 'manual' ? '' : ' (automatic)'}`;
	if (!parts.length) return { text: `${head}: nothing to sync.`, tone: 'warn' };
	const counts = countsText({ newCount: sum((r) => r.newCount), changedCount: sum((r) => r.changedCount), unchanged: sum((r) => r.unchanged), restored: sum((r) => r.restored), leftForLater: sum((r) => r.leftForLater) });
	const stop = all.stopped ? ' Stopped by you.' : '';
	const bad = problems.length ? ` Problem${problems.length === 1 ? '' : 's'}: ${problems.map((r) => r.label).join(', ')}.` : '';
	const tone: Tone = problems.some((r) => r.outcome === 'error') ? 'bad' : problems.length || all.stopped ? 'warn' : 'ok';
	return { text: `${head}: ${counts}.${stop}${bad}`, tone };
}
