import type { OmpEvent } from "./driver";

export const AGY_TOOL_KEEPALIVE_EVENT = "agy_tool_keepalive";
export const AGY_TOOL_KEEPALIVE_INTERVAL_MS = 60_000;
export const AGY_TOOL_KEEPALIVE_MAX_MS = 8 * 60_000;

export interface AgyToolKeepaliveOptions {
	intervalMs?: number;
	maxMs?: number;
	now?: () => number;
	setIntervalFn?: (fn: () => void, ms: number) => unknown;
	clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Emits bounded keepalive events while at least one agy tool step is active.
 * agy emits no intermediate frames during tool execution, so long builds/tests would otherwise hit `STALL_MS`.
 */
export class AgyToolKeepalive {
	readonly #onEmit: (event: OmpEvent) => void;
	readonly #intervalMs: number;
	readonly #maxMs: number;
	readonly #now: () => number;
	readonly #setIntervalFn: (fn: () => void, ms: number) => unknown;
	readonly #clearIntervalFn: (handle: unknown) => void;
	readonly #active = new Map<string, { name: string; startedAt: number }>();
	#timer: unknown | undefined;

	constructor(onEmit: (event: OmpEvent) => void, options: AgyToolKeepaliveOptions = {}) {
		this.#onEmit = onEmit;
		this.#intervalMs = options.intervalMs ?? AGY_TOOL_KEEPALIVE_INTERVAL_MS;
		this.#maxMs = options.maxMs ?? AGY_TOOL_KEEPALIVE_MAX_MS;
		this.#now = options.now ?? (() => Date.now());
		this.#setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
		this.#clearIntervalFn =
			options.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	}

	start(callId: string, name: string): void {
		if (this.#intervalMs <= 0 || this.#maxMs <= 0) return;
		if (!this.#active.has(callId)) this.#active.set(callId, { name, startedAt: this.#now() });
		if (this.#timer !== undefined) return;
		const handle = this.#setIntervalFn(() => this.#tick(), this.#intervalMs);
		(handle as { unref?: () => void } | undefined)?.unref?.();
		this.#timer = handle;
	}

	end(callId: string): void {
		this.#active.delete(callId);
		if (this.#active.size === 0) this.#stopTimer();
	}

	clear(): void {
		this.#active.clear();
		this.#stopTimer();
	}

	#tick(): void {
		while (this.#active.size > 0) {
			let oldestId: string | undefined;
			let oldest: { name: string; startedAt: number } | undefined;
			for (const [id, entry] of this.#active) {
				if (oldest === undefined || entry.startedAt < oldest.startedAt) {
					oldestId = id;
					oldest = entry;
				}
			}
			if (oldestId === undefined || oldest === undefined) break;
			const elapsedMs = this.#now() - oldest.startedAt;
			// An entry past its budget is spent, not a stop: drop it and let the next active tool keep its cover.
			if (elapsedMs > this.#maxMs) {
				this.#active.delete(oldestId);
				continue;
			}
			this.#onEmit({ type: AGY_TOOL_KEEPALIVE_EVENT, toolCallId: oldestId, toolName: oldest.name, elapsedMs });
			return;
		}
		this.#stopTimer();
	}

	#stopTimer(): void {
		if (this.#timer === undefined) return;
		this.#clearIntervalFn(this.#timer);
		this.#timer = undefined;
	}
}
