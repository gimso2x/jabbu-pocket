import type { LaneReservation } from "./reservations";
import type { LaneLand, LanePr, LaneRow } from "./status";

export const DEFAULT_MAX_LANES = 4;
/** The thread status message is edited at most this often (milestones excepted). */
export const PROGRESS_INTERVAL_MS = 15 * 60_000;
/** A claim whose check could not finish is judged again after this long: closed when it passes, `not-done` when not. */
export const CLAIM_GRACE_MS = 5 * 60_000;

/** Judgements at one HEAD whose checks may time out; the last one asks the owner instead of running them again. */
export const INCONCLUSIVE_RUNS_MAX = 2;

/** A landing refused as not fast-forward goes back to the lane once; the second refusal is the owner's (`blocked`). */
export const LAND_ATTEMPTS_MAX = 2;
/** A landing that threw (git or the host unavailable) is run again by the tick; the third throw in a row is `blocked`. */
export const LAND_ERRORS_MAX = 3;

/** Root mark and status-message suffix of a closed lane, by where its landing stands. */
export const CLOSED_MARKS: Record<LaneLand["state"], readonly [mark: string, waiting: string]> = {
	pending: ["🔍", "머지 대기"],
	"pr-open": ["🔄", "PR · CI 대기"],
	blocked: ["🔍", "머지 막힘"],
	landed: ["✅", ""],
	"merged-not-pushed": ["⚠️", "머지됨 · push 안 됨"],
	discarded: ["🗑", "폐기"],
};
/** Root mark and status suffix of a closed external PR lane whose landing is open, by where its publish stands. */
export const PR_MARKS: Record<LanePr["state"] | "waiting", readonly [mark: string, waiting: string]> = {
	waiting: ["📤", "PR 게시 대기"],
	asking: ["📤", "PR 승인 대기"],
	published: ["📤", "PR 게시됨"],
	held: ["⏸", "보류"],
	failed: ["🚧", "PR 게시 실패"],
};

/**
 * What a closed lane's root and status show (설계 5): an external PR lane by its publish, a pending lane with blocking
 * leftovers as `남은 일 대기`, any other by its landing.
 */
export function closedMarkOf(lane: LaneRow): readonly [mark: string, waiting: string] {
	const { land, externalPr, pr, sha, leftovers, launchFailed } = lane.meta;
	if (launchFailed !== undefined) return ["❌", "시작 실패"];
	const state = land?.state ?? "landed";
	if (state === "pending" || state === "blocked") {
		if (externalPr !== undefined) {
			return PR_MARKS[pr === undefined || (pr.state === "published" && pr.sha !== sha) ? "waiting" : pr.state];
		}
		if (state === "pending" && (leftovers ?? []).some((item) => item.blocking)) return ["🔍", "남은 일 대기"];
	}
	return CLOSED_MARKS[state];
}

/** `meta.pr.reason` of a publish a stopping core cut off, and of an `asking` a restart left behind. */
export const PR_CUT_BY_STOP = "재시작으로 끊김";
export const PR_CUT_BY_RESTART = "재시작으로 승인 대기 끊김";

export const MAX_TITLE_CHARS = 120;
/** `notice` of an `expired` reservation whose expiry notice has not been posted yet. */
export const EXPIRY_UNANNOUNCED = "expiry-unannounced";

/** A reservation's state as the owner reads it in a refusal. */
export const STATE_TEXT: Record<LaneReservation["state"], string> = {
	waiting: "대기",
	ready: "시작 가능",
	started: "시작됨",
	cancelled: "취소됨",
	expired: "만료됨",
};
/** A lane's review files: the diff, the reviewer's `--config` overlay and its empty cwd directory. */
export const REVIEW_FILE_SUFFIXES = [".diff", ".omp.yml", ".cwd"] as const;
export const MAX_MILESTONE_CHARS = 300;
/** Evidence entries a lane keeps (the newest); the files among them are copied when the lane's worktree goes. */
export const MAX_LANE_EVIDENCE = 20;
export const MAX_BRIEF_CHARS = 16_000;

/** The request itself is wrong (bad title or path); the message is shown to the owner. */
export class LaneInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LaneInputError";
	}
}

export class LaneCapError extends LaneInputError {
	constructor(max: number) {
		super(`동시 작업 레인 상한(${max}개)에 도달했습니다. 진행 중인 레인이 완료·종료된 뒤 다시 시작하세요.`);
		this.name = "LaneCapError";
	}
}

/** What the lane tools answer on a closed lane: nothing changed, and the owner's `!reopen` is the way back to work. */
export const CLOSED_LANE_REPLY =
	"is closed: nothing was recorded. Answer only; if changes are needed, ask the owner to write `!reopen <지시>` in this lane's thread.";
/** What the lane tools answer while the owner holds the lane: nothing is recorded until the owner resumes it. */
export const PAUSED_LANE_REPLY =
	"is paused: nothing was recorded. The owner resumes this lane (`계속` here or the ▶ button) before it works again.";

/** A verdict git or the check host could not finish now: the claim stays pending for the tick after the grace. */
export const DEFERRED_REPLY = "검증을 지금 끝내지 못했습니다. 코어가 5분 안에 다시 확인합니다.";
/** Why a booked auto-merge is withdrawn when `taskAutoLand` is off at landing time. */
export const AUTO_LAND_OFF = "자동 머지 꺼짐";
/** A claim that arrived while the lane's verdict ran: judged the moment that verdict ends. */
export const OVERLAP_REPLY = "검증이 돌고 있어 끝나는 대로 새 클레임을 바로 판정합니다.";
/** The core stopped while the checks ran: nothing is recorded; the tick after the restart judges the claim again. */
export const STOPPED_REPLY = "코어가 멈춰 검사를 중단했습니다. 다시 시작한 뒤 코어가 다시 판정합니다.";
export const CHECK_DETAIL_MAX = 120;
