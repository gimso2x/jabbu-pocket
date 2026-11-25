import type { MonitorTrigger } from "./spec";

/** A stored row whose trigger kind this build no longer runs (webhook and watcher were removed); it never fires. */
export interface UnsupportedTrigger {
	kind: "unsupported";
	/** The `kind` the stored `trigger_json` carried. */
	was: string;
}

const SUPPORTED_KINDS: readonly string[] = ["cron", "at", "script"];

/** A row's `trigger_json`: a kind this build does not know reads as {@link UnsupportedTrigger}. */
export function parseStoredTrigger(json: string): MonitorTrigger | UnsupportedTrigger {
	const parsed = JSON.parse(json) as { kind?: unknown };
	const kind = typeof parsed.kind === "string" ? parsed.kind : "?";
	return SUPPORTED_KINDS.includes(kind) ? (parsed as MonitorTrigger) : { kind: "unsupported", was: kind };
}
