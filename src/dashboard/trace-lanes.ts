import type { Database } from "bun:sqlite";
import type { LaneHistoryEntry, LaneMeta, LaneStatus } from "../lanes/status";

/** One `lanes` row of the turn window whose `meta` and `history` read as the shapes the trace uses. */
export interface TraceLaneRow {
	name: string;
	status: LaneStatus;
	session_dir: string;
	created_at: number;
	meta: LaneMeta;
	history: LaneHistoryEntry[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrAbsent = (value: unknown): boolean => value === undefined || typeof value === "string";

/** `meta` an object whose text fields the trace reads are text; `history` an array of `{at: number, event: string}`. */
function shaped(meta: unknown, history: unknown): meta is LaneMeta {
	return (
		isObject(meta) &&
		["laneId", "parentOrigin", "workerModel", "tier", "tierReason"].every((key) => stringOrAbsent(meta[key])) &&
		Array.isArray(history) &&
		history.every((entry) => isObject(entry) && typeof entry.at === "number" && typeof entry.event === "string")
	);
}

/**
 * The lanes created in `[from, to)`. A row whose `meta` or `history` is not JSON, or parses to another shape, is left
 * out and counted in `skipped`: its parent origin cannot be read, so the trace cannot say whether it was this turn's
 * worker, and the caller shows that the list may be incomplete.
 */
export function readTraceLanes(db: Database, from: number, to: number): { lanes: TraceLaneRow[]; skipped: number } {
	const rows = db
		.query<Omit<TraceLaneRow, "meta" | "history"> & { meta: string; history: string }, [number, number]>(
			"SELECT name, status, history, meta, session_dir, created_at FROM lanes WHERE created_at >= ? AND created_at < ?",
		)
		.all(from, to);
	const lanes: TraceLaneRow[] = [];
	for (const row of rows) {
		try {
			const meta: unknown = JSON.parse(row.meta);
			const history: unknown = JSON.parse(row.history);
			if (shaped(meta, history)) {
				lanes.push({ ...row, meta, history: history as LaneHistoryEntry[] });
			}
		} catch {
			// not JSON: counted below
		}
	}
	return { lanes, skipped: rows.length - lanes.length };
}
