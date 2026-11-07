// Collects a session's messages into alternating "You" / assistant turns.
// Tool steps are counted; consecutive steps are merged into one count.

import type { DesktopTurn } from './types';

export class TurnBuilder {
	readonly turns: DesktopTurn[] = [];
	private cur: DesktopTurn | null = null;

	/** A new message from you always starts a new turn. */
	user(text: string, time?: string): void {
		const t = text.trim();
		if (!t) return;
		this.cur = { role: 'user', time, parts: [{ text: t }] };
		this.turns.push(this.cur);
	}

	/** Assistant text joins the current assistant turn (or starts one). */
	assistant(text: string, time?: string): void {
		const t = text.trim();
		if (!t) return;
		this.assistantTurn(time).parts.push({ text: t });
	}

	tool(time?: string, n = 1): void {
		const turn = this.assistantTurn(time);
		const last = turn.parts[turn.parts.length - 1];
		if (last && 'tools' in last) last.tools += n;
		else turn.parts.push({ tools: n });
	}

	private assistantTurn(time?: string): DesktopTurn {
		if (this.cur?.role !== 'assistant') {
			this.cur = { role: 'assistant', time, parts: [] };
			this.turns.push(this.cur);
		}
		return this.cur;
	}

	/** Drops assistant turns that hold nothing but tool steps at the very start (setup noise). */
	result(): DesktopTurn[] {
		const first = this.turns.findIndex((t) => t.role === 'user');
		return first > 0 ? this.turns.slice(first) : this.turns;
	}
}

/** Parses JSON Lines, skipping lines that are not valid JSON objects (a file may end mid-write). */
export function jsonLines(text: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of text.split('\n')) {
		const l = line.trim();
		if (!l) continue;
		try {
			const o: unknown = JSON.parse(l);
			if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
		} catch {
			// half-written last line or garbage: ignore
		}
	}
	return out;
}

export function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

export function obj(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** First line of a prompt, shortened, as a fallback title. */
export function titleFrom(text: string | undefined): string | undefined {
	const line = text?.split('\n').map((l) => l.trim()).find(Boolean);
	if (!line) return undefined;
	const chars = Array.from(line);
	return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : line;
}
