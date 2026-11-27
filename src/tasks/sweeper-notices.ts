import type { TaskRow, TaskTransitionRow } from "./ledger";

/** Where the nudge count starts: the latest `resume:<ms>` mark of `resumeTask`, else the registration. */
export function nudgeBase(row: TaskRow): number {
	const resumes = Object.keys(row.notices)
		.filter((key) => key.startsWith("resume:"))
		.map((key) => Number(key.slice("resume:".length)))
		.filter((at) => Number.isFinite(at));
	return Math.max(row.createdAt, ...resumes);
}

/**
 * When the task was last resumed: the latest `resume:<ms>` mark of `resumeTask`, or a `resume dispatch` transition of
 * the ledger (resumes marked before the marks existed); `undefined` for a task never resumed.
 */
export function lastResumeAt(row: TaskRow, history: readonly TaskTransitionRow[]): number | undefined {
	const resumes = [
		...Object.keys(row.notices)
			.filter((key) => key.startsWith("resume:"))
			.map((key) => Number(key.slice("resume:".length)))
			.filter((at) => Number.isFinite(at)),
		...history.filter((entry) => entry.reason === "resume dispatch").map((entry) => entry.at),
	];
	return resumes.length === 0 ? undefined : Math.max(...resumes);
}

/** An agy limit block since `nudgeBase` (the latest resume, else the registration): no prompt goes to the worker. */
export function agyLimitHeld(row: TaskRow): boolean {
	return Object.entries(row.notices).some(([key, at]) => key.startsWith("agylimit:") && at >= nudgeBase(row));
}

/** Unmet-condition nudges recorded since `nudgeBase`. */
export function nudgesSince(row: TaskRow): number {
	return Object.entries(row.notices).filter(([key, at]) => key.startsWith("unmet:") && at >= nudgeBase(row)).length;
}

/** The `<ms>` of every `blockretry:<ms>` mark (one per retry prompt, sent or not). */
function blockRetryMarks(row: TaskRow): number[] {
	return Object.keys(row.notices)
		.filter((key) => key.startsWith("blockretry:"))
		.map((key) => Number(key.slice("blockretry:".length)))
		.filter((at) => Number.isFinite(at));
}

/** Retry prompts since `nudgeBase` (the latest resume, else the registration). */
export function blockRetriesSince(row: TaskRow): number {
	const since = nudgeBase(row);
	return blockRetryMarks(row).filter((at) => at >= since).length;
}

/**
 * The retry prompt the current block is waiting on: the latest `blockretry:<ms>` without its `blockcleared:<ms>` and
 * with no working → blocked move since (the card went up); `undefined` when there is none.
 */
export function pendingBlockRetry(row: TaskRow, history: readonly TaskTransitionRow[]): number | undefined {
	const marks = blockRetryMarks(row);
	if (marks.length === 0) return undefined;
	const latest = Math.max(...marks);
	if (`blockcleared:${latest}` in row.notices) return undefined;
	const carded = history.some(
		(entry) => entry.fromStatus === "working" && entry.toStatus === "blocked" && entry.at >= latest,
	);
	return carded ? undefined : latest;
}
