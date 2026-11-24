import type { TaskCheck } from "./checker";
import type { TaskRisk } from "./docs";

/** `taskAutoLand` as the sweep applies it: the repositories it covers and the highest risk it merges unasked. */
export interface AutoLandPolicy {
	repos: string[];
	maxRisk: TaskRisk;
	/**
	 * The independent review a lane's claim commit needs a `CLEAR` receipt from before it merges unasked; a local [TASK]
	 * needs one for its tip only in the `confident` band (src/tasks/gate.ts).
	 */
	review?: { model: string; timeoutMs: number; confident?: LaneReviewConfident };
	/** The run QA a reviewed lane or banded [TASK] at `minRisk` or above needs a `PASS` receipt from for that commit. */
	qa?: LaneQaPolicy;
	/**
	 * `taskAutoLand.commitEmails`: per repository (absolute path) the author/committer emails a lane's commits may
	 * carry. A repository not listed is not checked.
	 */
	commitEmails?: Record<string, string[]>;
}

/** `taskAutoLand.qa` as the lanes apply it (`minRisk` defaults to L3, `timeoutMs` to the review's default). */
export interface LaneQaPolicy {
	minRisk: TaskRisk;
	/** Absolute path of the omp yml overlay the QA run gets after the isolation overlay. */
	overlay: string;
	model: string;
	timeoutMs: number;
}

/**
 * `taskAutoLand.review.confident`: a lane whose explicit risk is above `maxRisk` (policy) and at most this `maxRisk`
 * merges unasked on a `CLEAR` receipt whose confidence is at least `minConfidence`.
 */
export interface LaneReviewConfident {
	maxRisk: TaskRisk;
	minConfidence: number;
}

/** The auto-merge blockers of re-run checks: failed (a violation) and inconclusive (timed out) counted apart. */
export function checkBlockers(checks: readonly TaskCheck[]): string[] {
	const failed = checks.filter((check) => !check.ok && !check.inconclusive).length;
	const inconclusive = checks.filter((check) => check.inconclusive === true).length;
	return [
		...(failed > 0 ? [`재실행 검사 실패 ${failed}/${checks.length}`] : []),
		...(inconclusive > 0 ? [`재실행 검사 확인 불가 ${inconclusive}/${checks.length}`] : []),
	];
}
