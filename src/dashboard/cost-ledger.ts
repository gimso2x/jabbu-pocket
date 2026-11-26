import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { previewLine } from "../core/preview-line";
import { CURRENT_REQUEST_MARKER } from "../core/types";
import { LANE_ORIGIN_PREFIX, TASK_ORIGIN_PREFIX } from "../lanes/status";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { isRecord } from "../omp/type-guards";
import { allSessionFiles, usageOf } from "../ops/usage";
import { localDay } from "../time";
import { iterJsonlRecords } from "./jsonl";
import { sectionCache } from "./section-cache";
import type { Section } from "./snapshot";

/**
 * The system view's "7일 비용" card (from herdr-modulor `modulor-cost`): model cost per day, the five costliest
 * sessions and the cache-write share, from the session files under `<home>/sessions` (the `/usage-jabbu` reading,
 * `ops/usage.ts` `usageOf`). `<home>/state/cost-ledger.json` keeps a byte offset per file so a refresh reads only the
 * lines appended since; a file that shrank or got a new inode is read again from the start.
 */

export const COST_LEDGER_TTL_MS = 15 * 60_000;
const DAYS = 7;
const TOP = 5;
const OLD_LANE_PREFIX = "ompbot/work/";

/** Per local day (`YYYYMMDD`): cost in dollars and the cache-write part of it. */
type DayCosts = Record<string, { cost: number; cacheWrite: number }>;

interface FileEntry {
	ino: number;
	/** Bytes consumed: the end of the last whole line read. */
	offset: number;
	days: DayCosts;
}

interface LedgerState {
	files: Record<string, FileEntry>;
}

export type CostSessionKind = "대화" | "레인" | "TASK" | "모니터";

export interface CostLedgerInfo {
	/** Oldest first, {@link DAYS} entries ending today (`MM-DD`). */
	days: Array<{ day: string; cost: number }>;
	/** At most {@link TOP}, costliest first. */
	top: Array<{ title: string; kind: CostSessionKind; cost: number }>;
	total: number;
	/** Cache-write cost over all cost of the seven days, 0–100. */
	cacheWritePct: number;
}

export const costLedgerFile = (home: string): string => join(home, "state", "cost-ledger.json");

function loadState(file: string): LedgerState {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (isRecord(value) && isRecord(value.files)) return value as unknown as LedgerState;
	} catch {
		// first run, or a torn file: start over
	}
	return { files: {} };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Reads `file` from `entry.offset` to its last newline, adding each model call's cost to its day. Returns bytes read. */
function readAppended(file: string, entry: FileEntry, size: number, timezone: string): number {
	const length = size - entry.offset;
	if (length <= 0) return 0;
	const buffer = Buffer.allocUnsafe(length);
	const fd = openSync(file, "r");
	let read = 0;
	try {
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, entry.offset + read);
			if (n === 0) break;
			read += n;
		}
	} finally {
		closeSync(fd);
	}
	const end = buffer.subarray(0, read).lastIndexOf(10);
	if (end < 0) return read;
	for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const usage = usageOf(record);
		const at = isRecord(record) && typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
		if (usage === undefined || Number.isNaN(at)) continue;
		const cost = usage.cost as { total?: unknown; cacheWrite?: unknown } | undefined;
		const key = localDay(at, timezone);
		const day = entry.days[key] ?? { cost: 0, cacheWrite: 0 };
		entry.days[key] = day;
		day.cost += num(cost?.total);
		day.cacheWrite += num(cost?.cacheWrite);
	}
	entry.offset += end + 1;
	return read;
}

/**
 * The `localDay` key `days` calendar days before `key`: Gregorian date arithmetic, never 24h steps — a DST
 * spring-forward day has 23 hours, so stepping instants by 24h skips it (and its costs fall out of the window).
 */
const dayKeyBefore = (key: string, days: number): string => {
	const at = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)) - days));
	const pad2 = (n: number): string => String(n).padStart(2, "0");
	return `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
};

/** The origin key of a session file: the URL-encoded first path part under the sessions root. */
const originOf = (sessionsRoot: string, file: string): string =>
	decodeURIComponent(relative(sessionsRoot, file).split(sep)[0] ?? "");

function kindOf(origin: string): CostSessionKind {
	if (origin.startsWith(TASK_ORIGIN_PREFIX)) return "TASK";
	if (origin.startsWith(LANE_ORIGIN_PREFIX) || origin.startsWith(OLD_LANE_PREFIX)) return "레인";
	return origin.startsWith(MONITOR_ORIGIN_PREFIX) ? "모니터" : "대화";
}

/** Strip wrapped Discord channel context header so top-cost titles start from `[현재 요청]`. */
function stripPromptHeader(text: string): string {
	const idx = text.lastIndexOf(`\n\n${CURRENT_REQUEST_MARKER}\n`);
	if (idx >= 0) return text.slice(idx + CURRENT_REQUEST_MARKER.length + 3);
	return text.startsWith(`${CURRENT_REQUEST_MARKER}\n`) ? text.slice(CURRENT_REQUEST_MARKER.length + 1) : text;
}

/** The session's omp title, else its first user text, else the origin key — one masked line. */
function titleOf(origin: string, files: string[]): string {
	const prefix = [TASK_ORIGIN_PREFIX, LANE_ORIGIN_PREFIX, OLD_LANE_PREFIX].find((p) => origin.startsWith(p));
	if (prefix !== undefined) return origin.slice(prefix.length);
	for (const file of files) {
		try {
			for (const record of iterJsonlRecords(file)) {
				if (record.type === "title" && typeof record.title === "string" && record.title.trim() !== "") {
					return previewLine(record.title, origin);
				}
				const message = record.message;
				if (record.type !== "message" || !isRecord(message) || message.role !== "user") continue;
				const part = Array.isArray(message.content) ? message.content.find(isRecord) : undefined;
				if (typeof part?.text === "string") return previewLine(stripPromptHeader(part.text), origin);
				break;
			}
		} catch {
			// gone since listing
		}
	}
	return origin;
}

/**
 * One refresh of the ledger: reads the appended bytes of every session file touched within the seven days, saves the
 * offsets and returns the card with the bytes read. Days and files older than the window are dropped.
 */
export function updateCostLedger(
	home: string,
	now: number,
	timezone: string,
): { info: CostLedgerInfo; bytesRead: number } {
	const sessionsRoot = join(home, "sessions");
	const stateFile = costLedgerFile(home);
	const state = loadState(stateFile);
	const today = localDay(now, timezone);
	const dayKeys = Array.from({ length: DAYS }, (_, i) => dayKeyBefore(today, DAYS - 1 - i));
	const next: LedgerState = { files: {} };
	let bytesRead = 0;
	for (const file of allSessionFiles(sessionsRoot)) {
		let stat: Stats;
		try {
			stat = statSync(file);
		} catch {
			continue;
		}
		if (now - stat.mtimeMs > (DAYS + 1) * 86_400_000) continue; // a pre-filter only; the day keys do the precise cut
		const known = state.files[file];
		const entry: FileEntry =
			known !== undefined && known.ino === stat.ino && known.offset <= stat.size
				? known
				: { ino: stat.ino, offset: 0, days: {} };
		bytesRead += readAppended(file, entry, stat.size, timezone);
		entry.days = Object.fromEntries(Object.entries(entry.days).filter(([day]) => dayKeys.includes(day)));
		next.files[file] = entry;
	}
	try {
		mkdirSync(dirname(stateFile), { recursive: true });
		writeFileSync(`${stateFile}.tmp`, JSON.stringify(next));
		renameSync(`${stateFile}.tmp`, stateFile);
	} catch (error) {
		process.stderr.write(
			`dashboard: cost ledger not saved: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	const perDay = new Map(dayKeys.map((day) => [day, 0]));
	const perOrigin = new Map<string, { cost: number; files: string[] }>();
	let cacheWrite = 0;
	for (const [file, entry] of Object.entries(next.files)) {
		const origin = originOf(sessionsRoot, file);
		const session = perOrigin.get(origin) ?? { cost: 0, files: [] };
		session.files.push(file);
		for (const [day, costs] of Object.entries(entry.days)) {
			perDay.set(day, (perDay.get(day) ?? 0) + costs.cost);
			session.cost += costs.cost;
			cacheWrite += costs.cacheWrite;
		}
		perOrigin.set(origin, session);
	}
	const total = [...perDay.values()].reduce((sum, cost) => sum + cost, 0);
	const top = [...perOrigin.entries()]
		.filter(([, session]) => session.cost > 0)
		.sort((a, b) => b[1].cost - a[1].cost)
		.slice(0, TOP)
		.map(([origin, session]) => ({
			title: titleOf(origin, session.files.sort()),
			kind: kindOf(origin),
			cost: session.cost,
		}));
	return {
		info: {
			days: dayKeys.map((day) => ({ day: `${day.slice(4, 6)}-${day.slice(6)}`, cost: perDay.get(day) ?? 0 })),
			top,
			total,
			cacheWritePct: total === 0 ? 0 : Math.round((cacheWrite / total) * 100),
		},
		bytesRead,
	};
}

const cache = sectionCache<CostLedgerInfo>(COST_LEDGER_TTL_MS);

/** The card's section, computed at most once per {@link COST_LEDGER_TTL_MS} per home (the hidden tab polls every minute). */
export function readCostLedger(home: string, now: () => number, timezone: string): Promise<Section<CostLedgerInfo>> {
	return cache.read(home, now, async () => ({ ok: true, ...updateCostLedger(home, now(), timezone).info }));
}

/** Test only: forget the cached card. */
export const clearCostLedgerCache = (): void => cache.clear();
