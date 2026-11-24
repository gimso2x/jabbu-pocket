import type { Database } from "bun:sqlite";

/** How far back turn-duration samples reach, and at most how many (newest first). */
export const TURN_SAMPLE_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const TURN_SAMPLE_LIMIT = 200;

/**
 * Open-to-close durations (ms) of the lanes closed in the last 30 days, newest first, at most 200 ({@link TURN_SAMPLE_LIMIT}):
 * `updated_at - created_at` of a `closed` lane, so a reopened lane is no sample until it closes again.
 */
export function laneDurationSamples(db: Database, now: number): number[] {
	const rows = db
		.query(
			"SELECT updated_at - created_at AS ms FROM lanes WHERE status = 'closed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
		)
		.all(now - TURN_SAMPLE_WINDOW_MS, TURN_SAMPLE_LIMIT) as Array<{ ms: number }>;
	return rows.map((row) => row.ms);
}
