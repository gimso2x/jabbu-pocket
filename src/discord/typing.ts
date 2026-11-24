// The typing indicator's constants and timer types (the adapter owns the per-thread entries).

/** Discord shows "typing…" for about 10 s per call: one call every 8 s keeps it on without a gap. */
export const TYPING_INTERVAL_MS = 8_000;
/** Typing stops this long after the message; a longer turn shows its progress in the status message. */
export const TYPING_MAX_MS = 330_000;

export interface TypingTimers {
	set(fn: () => unknown, ms: number): unknown;
	clear(handle: unknown): void;
}

export const INTERVAL_TIMERS: TypingTimers = {
	set: (fn, ms) => setInterval(fn, ms).unref(),
	clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One thread's typing indicator, from the owner message until the first answer, the turn's end or the cap. */
export interface TypingEntry {
	/** Where "typing…" shows: the thread channel, or the DM. Unknown until the lookup settles. */
	channelId: string | undefined;
	startedAt: number;
	handle: unknown;
	stopped: boolean;
}
