/*
 * Edit overlap: sessions that wrote the same file within 15 minutes (파일 겹침), or the same git checkout within 10
 * minutes (저장소 겹침), read from omp session jsonl (`edit`/`write`/`ast_edit` tool calls with an absolute path; bash is
 * not counted). Linked worktrees have no checkout of their own here, so lane/TASK worktrees never overlap each other by
 * repository. Display only: a failure to read leaves the dashboard without the marks, never without the snapshot.
 */
import { Database } from "bun:sqlite";
import { existsSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../omp/type-guards";
import { iterJsonlRecords } from "./jsonl";
import type { PeerInstall } from "./peers";
import { sessionFileOf } from "./session-model";
import { rows } from "./turn-board";

export const FILE_WINDOW_MS = 15 * 60_000;
export const REPO_WINDOW_MS = 10 * 60_000;
const WRITE_TOOLS = ["edit", "write", "ast_edit"];
const LINE_LIMIT = 30;
const ORIGIN_LIMIT = 300;

export interface OverlapSession {
	/** The id a card is keyed by: an origin key (`<install>:` first for a peer's) or `task:<taskId>`. */
	id: string;
	kind: "turn" | "lane" | "task" | "peer";
	name: string;
	/** The omp session jsonl. */
	file: string;
}

export interface Overlap {
	kind: "file" | "repo";
	/** The file path, or the checkout's top-level directory. */
	key: string;
	sessions: OverlapSession[];
}

interface Write {
	path: string;
	at: number;
}

export interface OverlapDeps {
	/** The writes of a session file at or after `since` (more are allowed; the caller filters). */
	writesOf: (file: string, since: number) => Write[];
	/** The top-level of the plain checkout holding `path`; undefined in a linked worktree or outside any repository. */
	checkoutOf: (path: string) => string | undefined;
}

/** What the page shows: hover text per card id, one line per overlap, and the origins of agy sessions (not checked). */
export interface OverlapView {
	hints: Record<string, string>;
	lines: string[];
	agy: string[];
}

const isMissing = (error: unknown): boolean =>
	error instanceof Error && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

const pathsOf = (args: Record<string, unknown>): string[] =>
	[args.path, ...(Array.isArray(args.paths) ? args.paths : [])].filter(
		(path): path is string => typeof path === "string" && path.startsWith("/"),
	);

const parsed = new Map<string, { size: number; mtimeMs: number; writes: Write[] }>();

/**
 * Write-tool calls of a session jsonl at or after `since`, parsed through `iterJsonlRecords`. A file untouched since
 * `since` is not opened; one that changed is read again, the result kept per (path, size, mtime).
 */
export function readWrites(file: string, since: number): Write[] {
	let stat: Stats;
	try {
		stat = statSync(file);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	if (stat.mtimeMs < since) return [];
	const hit = parsed.get(file);
	if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.writes;
	const writes: Write[] = [];
	for (const record of iterJsonlRecords(file)) {
		const at = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "");
		const content = isRecord(record.message) ? record.message.content : undefined;
		if (record.type !== "message" || Number.isNaN(at) || at < since || !Array.isArray(content)) continue;
		for (const part of content) {
			if (!isRecord(part) || part.type !== "toolCall" || !WRITE_TOOLS.includes(String(part.name))) continue;
			if (isRecord(part.arguments)) for (const path of pathsOf(part.arguments)) writes.push({ path, at });
		}
	}
	if (hit === undefined && parsed.size >= 500) parsed.clear();
	parsed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, writes });
	return writes;
}

/**
 * `path`'s checkout top-level: the nearest ancestor whose `.git` is a directory. A `.git` *file* (a linked worktree,
 * or a submodule) means no checkout of its own, so no repository overlap is counted there. No `git` process is run.
 */
export function checkoutOf(path: string): string | undefined {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		try {
			return statSync(join(dir, ".git")).isDirectory() ? dir : undefined;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * Overlaps among `sessions` at `now`. A group made only of TASKs is dropped: the sweeper already reports those.
 * A session that wrote the same path twice counts once.
 */
export function findOverlaps(
	sessions: OverlapSession[],
	now: number,
	deps: OverlapDeps = { writesOf: readWrites, checkoutOf },
): Overlap[] {
	const files = new Map<string, Map<string, OverlapSession>>();
	const repos = new Map<string, Map<string, OverlapSession>>();
	const add = (groups: Map<string, Map<string, OverlapSession>>, key: string, session: OverlapSession): void => {
		const group = groups.get(key) ?? new Map<string, OverlapSession>();
		group.set(session.id, session);
		groups.set(key, group);
	};
	for (const session of sessions) {
		for (const { path, at } of deps.writesOf(session.file, now - FILE_WINDOW_MS)) {
			if (at < now - FILE_WINDOW_MS) continue;
			add(files, path, session);
			const root = at >= now - REPO_WINDOW_MS ? deps.checkoutOf(path) : undefined;
			if (root !== undefined) add(repos, root, session);
		}
	}
	return (
		[
			["file", files],
			["repo", repos],
		] as const
	).flatMap(([kind, groups]) =>
		[...groups]
			.map(([key, group]) => ({ kind, key, sessions: [...group.values()] }))
			.filter(({ sessions: who }) => who.length > 1 && who.some((session) => session.kind !== "task")),
	);
}

/**
 * The page's view of `overlaps`. A card id lists each overlap it is in as `파일 겹침 <path> ↔ <the others>`; a TASK
 * keeps one line (it ends up in a one-line reason). `agy` ids are origins whose session is agy, which has no omp jsonl.
 */
export function overlapView(overlaps: Overlap[], agy: string[]): OverlapView | undefined {
	const hints: Record<string, string> = {};
	const lines: string[] = [];
	for (const { kind, key, sessions } of overlaps) {
		const word = kind === "file" ? "파일 겹침" : "저장소 겹침";
		if (lines.length < LINE_LIMIT)
			lines.push(`${word} ${key} · ${sessions.map((session) => session.name).join(" ↔ ")}`);
		for (const session of sessions) {
			if (session.kind === "task" && hints[session.id] !== undefined) continue;
			const others = sessions.filter((other) => other !== session).map((other) => other.name);
			const line = `${word} ${key} ↔ ${others.join(", ")}`;
			hints[session.id] = hints[session.id] === undefined ? line : `${hints[session.id]}\n${line}`;
		}
	}
	return lines.length === 0 && agy.length === 0 ? undefined : { hints, lines, agy };
}

/**
 * One install's origin sessions: a lane's (`레인 <name>`), a peer's, else a conversation's titled by `titles`
 * (board thread titles by origin key). Origins with an agy pointer have no omp jsonl and go to `agy`.
 */
function originSessions(
	db: Database,
	install: string | undefined,
	titles: Map<string, string>,
): { sessions: OverlapSession[]; agy: string[] } {
	const lanes = new Map(
		rows<{ origin_key: string; name: string }>(db, "SELECT origin_key, name FROM lanes WHERE status != 'closed'").map(
			(lane) => [lane.origin_key, lane.name],
		),
	);
	const sessions: OverlapSession[] = [];
	const agy: string[] = [];
	for (const origin of rows<{ origin_key: string; session_dir: string; session_file: string | null }>(
		db,
		`SELECT origin_key, session_dir, session_file FROM origins ORDER BY updated_at DESC LIMIT ${ORIGIN_LIMIT}`,
	)) {
		const id = install === undefined ? origin.origin_key : `${install}:${origin.origin_key}`;
		if (existsSync(join(origin.session_dir, "agy-conversation.json"))) {
			agy.push(id);
			continue;
		}
		const file = sessionFileOf({ sessionDir: origin.session_dir, sessionFile: origin.session_file });
		const lane = install === undefined ? lanes.get(origin.origin_key) : undefined;
		if (file === undefined) continue;
		const kind = install !== undefined ? "peer" : lane !== undefined ? "lane" : "turn";
		sessions.push({ id, kind, name: lane !== undefined ? `레인 ${lane}` : (titles.get(id) ?? id), file });
	}
	return { sessions, agy };
}

/** What {@link readEditOverlaps} needs from the snapshot: the database, peers, board titles and the herdr listing. */
export interface EditOverlapInput {
	db: Database | undefined;
	now: number;
	peers: PeerInstall[];
	threads: Array<{ originKey: string; title: string }>;
	/** `herdr agent list` of a host (cached by the snapshot); asked for `local` only while a TASK is open. */
	listing: (
		host: string,
	) => Promise<{ ok: true; agents: Array<{ name: string; sessionPath?: string }> } | { ok: false }> | undefined;
}

/**
 * Overlaps among the live omp sessions of this install (conversations, lanes, open TASK workers of the local herdr)
 * and of each `dashboard.peerHomes` install (conversations). `{}` when there is nothing to show or reading failed.
 */
export async function readEditOverlaps(input: EditOverlapInput): Promise<{ overlaps?: OverlapView }> {
	const { db, now } = input;
	if (db === undefined) return {};
	try {
		const titles = new Map(input.threads.map((thread) => [thread.originKey, thread.title]));
		const own = originSessions(db, undefined, titles);
		const sessions = [...own.sessions];
		const agy = [...own.agy];
		const open = rows<{ task_id: string; agent: string }>(
			db,
			"SELECT task_id, agent FROM tasks WHERE status IN ('working','blocked','review') AND COALESCE(host, 'local') = 'local'",
		);
		const listing = open.length === 0 ? undefined : await input.listing("local");
		for (const task of open) {
			const file = listing?.ok ? listing.agents.find((agent) => agent.name === task.agent)?.sessionPath : undefined;
			if (file !== undefined)
				sessions.push({ id: `task:${task.task_id}`, kind: "task", name: `TASK ${task.task_id}`, file });
		}
		for (const peer of input.peers) {
			const peerDb = join(peer.home, "jabbu.db");
			if (!existsSync(peerDb)) continue;
			const handle = new Database(peerDb, { readonly: true, strict: true });
			try {
				const found = originSessions(handle, peer.name, titles);
				sessions.push(...found.sessions);
				agy.push(...found.agy);
			} finally {
				handle.close();
			}
		}
		const view = overlapView(findOverlaps(sessions, now), agy);
		return view === undefined ? {} : { overlaps: view };
	} catch {
		return {};
	}
}
