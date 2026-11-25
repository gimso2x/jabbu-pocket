import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../omp/type-guards";
import { usageOf } from "../ops/usage";
import { sessionFileOf } from "./session-model";
import type { SnapshotDeps } from "./snapshot";
import { rows, type ThreadInfo } from "./turn-board";

/**
 * The turn board's context bar (from herdr-modulor `Panel Load`): how full a conversation's omp session context is.
 * A running turn's numbers come from the daemon's `live` op (the last `OmpState.context` its mailbox heard, no new omp
 * call); an idle conversation's tokens from the session file's last assistant `usage` (input + cache read + cache
 * write). The window size is known only from a `live` answer, so a conversation this process never saw run has no bar
 * — no model-name table guesses it.
 */
export interface ContextLoad {
	/** Share of the window in use, 0-100 (unrounded; the bar rounds). */
	percent: number;
	/** Tokens in use, for the `200k+` mark. */
	tokens: number;
}

/** The daemon's `live` op ({@link SnapshotDeps.callDaemon}): bounded so a wedged daemon cannot hold a snapshot. */
const LIVE_TIMEOUT_MS = 800;
type LiveAsk = (originKey: string) => Promise<unknown>;

/** Bytes read from the end of a session file: far more than one assistant message. */
const TAIL_BYTES = 256 * 1024;
const CACHE_ENTRIES = 1000;

/** Window per origin as its last `live` answer said, with the model it ran then (a changed model forgets it). */
const windows = new Map<string, { window: number; model: string | undefined }>();
const usageCache = new Map<string, { size: number; mtimeMs: number; tokens: number | undefined }>();

const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Test only: forget every learned window and read usage. */
export function clearContextLoad(): void {
	windows.clear();
	usageCache.clear();
}

/** Context tokens of the newest assistant message with usage in the tail of `file`; undefined when it has none. */
function lastUsageTokens(file: string): number | undefined {
	const { size, mtimeMs } = statSync(file);
	const hit = usageCache.get(file);
	if (hit?.size === size && hit.mtimeMs === mtimeMs) return hit.tokens;
	const length = Math.min(size, TAIL_BYTES);
	const fd = openSync(file, "r");
	let text: string;
	try {
		const buffer = Buffer.alloc(length);
		text = buffer.subarray(0, readSync(fd, buffer, 0, length, size - length)).toString("utf8");
	} finally {
		closeSync(fd);
	}
	// A tail starts mid-line: its first (partial) line is dropped.
	const lines = text.split("\n").slice(length < size ? 1 : 0);
	let tokens: number | undefined;
	for (const line of lines.reverse()) {
		if (line === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const usage = isRecord(record) && record.type === "message" ? usageOf(record) : undefined;
		const total = (count(usage?.input) ?? 0) + (count(usage?.cacheRead) ?? 0) + (count(usage?.cacheWrite) ?? 0);
		if (total > 0) {
			tokens = total;
			break;
		}
	}
	if (hit === undefined && usageCache.size >= CACHE_ENTRIES) usageCache.clear();
	usageCache.set(file, { size, mtimeMs, tokens });
	return tokens;
}

/** `{ tokens, window, percent }` of a `live` answer (`{ ok, live: { context } }`); undefined when it carries none. */
function liveContext(answer: unknown): { tokens: number | null; window: number; percent: number | null } | undefined {
	const live = isRecord(answer) && answer.ok === true ? answer.live : undefined;
	const context = isRecord(live) ? live.context : undefined;
	if (!isRecord(context)) return undefined;
	const window = count(context.window);
	if (window === undefined || window === 0) return undefined;
	return { window, tokens: count(context.tokens) ?? null, percent: count(context.percent) ?? null };
}

async function loadOf(thread: ThreadInfo, db: Database, live: LiveAsk | undefined): Promise<ContextLoad | undefined> {
	const key = thread.originKey;
	const model = thread.model?.model;
	// A daemon that cannot answer leaves the session file's reading; the status card already says the daemon is down.
	const context =
		live !== undefined && thread.openCount > 0 ? liveContext(await live(key).catch(() => undefined)) : undefined;
	if (context !== undefined) {
		windows.set(key, { window: context.window, model });
		return context.tokens === null
			? undefined
			: { tokens: context.tokens, percent: context.percent ?? (context.tokens / context.window) * 100 };
	}
	const known = windows.get(key);
	if (known === undefined || known.model !== model) return undefined;
	const [origin] = rows<{ session_dir: string; session_file: string | null }>(
		db,
		"SELECT session_dir, session_file FROM origins WHERE origin_key = ?",
		key,
	);
	if (origin === undefined) return undefined;
	const file = sessionFileOf({ sessionDir: origin.session_dir, sessionFile: origin.session_file });
	const tokens = file === undefined ? undefined : lastUsageTokens(file);
	return tokens === undefined ? undefined : { tokens, percent: (tokens / known.window) * 100 };
}

/**
 * `section` with a {@link ContextLoad} on each own thread that has one. Display only: a thread whose session file
 * cannot be read simply has no bar. The daemon is asked only with `deps.usageLimits` (never in its own `!brief`).
 */
export async function withContextLoad<T extends { threads: ThreadInfo[] }>(
	section: T,
	db: Database,
	deps: Pick<SnapshotDeps, "callDaemon" | "homeDir" | "usageLimits">,
): Promise<T> {
	const live: LiveAsk | undefined =
		deps.usageLimits === true
			? (origin) => deps.callDaemon(join(deps.homeDir, "jabbu.sock"), { op: "live", origin }, LIVE_TIMEOUT_MS)
			: undefined;
	const threads = await Promise.all(
		section.threads.map(async (thread) => {
			if (thread.install !== undefined) return thread;
			let context: ContextLoad | undefined;
			try {
				context = await loadOf(thread, db, live);
			} catch {
				context = undefined;
			}
			return context === undefined ? thread : { ...thread, context };
		}),
	);
	return { ...section, threads };
}
