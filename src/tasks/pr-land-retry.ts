import type { ChannelRegistry } from "../channel/registry";
import type { AutoLandPolicy } from "./auto-land-policy";
import { TASK_RISKS } from "./docs";
import type { TaskLandOutcome } from "./land";
import type { TaskLedger, TaskRow } from "./ledger";
import { buildMergeSettledCard, postToThread, type TaskCard, type TaskChatLog, taskMergeActionId } from "./notify";

/** A remote task's tip is read over ssh at most this often (the same slot as `RemoteJudgeClock`). */
const REMOTE_HEAD_MS = 5 * 60_000;

/** Whether a task's PR landing ended in `blocked` or `held` (the owner can ask for it again). Other results, ff landings and rows without a record are not retryable. */
export const isPrRetryable = (row: TaskRow | undefined): boolean =>
	row?.land?.state === "blocked" || row?.land?.state === "held";

/** The merge-wait card of a stopped PR landing: `note` as the result line and the `머지` button (same action id) labelled "다시 시도". */
export function prLandRetryCard(row: TaskRow, note: string): TaskCard {
	const card = buildMergeSettledCard(row, note);
	return {
		...card,
		buttons: [{ actionId: taskMergeActionId(row.taskId), label: "다시 시도", value: row.taskId, style: "primary" }],
	};
}

/** The one line a stopped PR landing tells the thread. */
export const prLandStopText = (state: "blocked" | "held", reason: string): string =>
	`⛔ PR 착지 ${state === "held" ? "보류" : "멈춤"}: ${reason}`;

/** Tells the task's thread that its PR landing stopped, with the retry button. */
export const postPrLandStop = (
	ctx: { channels: ChannelRegistry; log: TaskChatLog },
	row: TaskRow,
	state: "blocked" | "held",
	reason: string,
): Promise<boolean> =>
	postToThread(ctx.channels, ctx.log, row.threadRef, prLandRetryCard(row, prLandStopText(state, reason)));

/** The notice key of a stopped landing: a new tip (`sha`) tells again even for the same reason. */
export const prLandNoticeKey = (state: "blocked" | "held", sha: string | undefined, reason: string): string =>
	`land:${state}:${sha ?? "-"}:${Bun.hash(reason).toString(36)}`;

type RetryLedger = Pick<TaskLedger, "get" | "isPaused" | "recordNotice">;

export interface PrLandRetryDeps {
	/** Live `taskAutoLand` (maxRisk defaulted); `undefined` = auto-merge off. */
	policy(): AutoLandPolicy | undefined;
	/** Why auto-merge is held after an apply rollback; `undefined` = not held. */
	hold(): string | undefined;
	frozen(): boolean;
	/** Whether the daemon can land now (started, not draining). */
	ready(): boolean;
	/** Whether the task's repository lands through a PR (`lanes.land` pr, for a remote task its host entry). */
	viaPr(row: TaskRow): Promise<boolean>;
	repoMatches(row: TaskRow, repos: readonly string[]): Promise<boolean>;
	/** The tip of the task's worktree (on its host for a remote task) and whether it is clean; rejects when the host cannot answer. */
	headOf(row: TaskRow): Promise<{ sha: string; clean: boolean }>;
	autoLand(row: TaskRow): Promise<TaskLandOutcome>;
	/** Tells the task thread that the landing stopped again (`postPrLandStop`). */
	stop(row: TaskRow, state: "blocked" | "held", reason: string): Promise<boolean>;
	now(): number;
	log: {
		info(event: string, fields?: Record<string, unknown>): void;
		warn(event: string, fields?: Record<string, unknown>): void;
	};
}

/**
 * One automatic retry of a PR landing that `blocked` (a leak check, a failed run) once the task branch got another tip.
 * Only a `blocked` PR record with the tip it was judged at (`land.sha`), a task whose risk is within `maxRisk` (a task in
 * the confident band needs the gate again: the owner's button only), a repository inside `taskAutoLand.repos`, and no
 * freeze, pause or hold. The branch tip is the only thing read while it stays the same: no landing run, `gh` or fetch.
 */
export class PrLandRetry {
	readonly #deps: PrLandRetryDeps;
	/** When each remote task's tip was last read (memory: a restart reads at once). */
	readonly #readAt = new Map<string, number>();

	constructor(deps: PrLandRetryDeps) {
		this.#deps = deps;
	}

	/** One sweep step for a review task; a failure is logged, never thrown (the sweep's review re-alert goes on). */
	async run(row: TaskRow, ledger: RetryLedger): Promise<void> {
		try {
			await this.#attempt(row, ledger);
		} catch (error) {
			this.#deps.log.warn("task_pr_land_retry_failed", { task: row.taskId, error: String(error) });
		}
	}

	async #attempt(row: TaskRow, ledger: RetryLedger): Promise<void> {
		const d = this.#deps;
		const land = row.land;
		const policy = d.policy();
		if (policy === undefined || row.status !== "review" || land?.state !== "blocked" || land.sha === undefined) return;
		if (TASK_RISKS.indexOf(row.risk) > TASK_RISKS.indexOf(policy.maxRisk)) return;
		if (d.hold() !== undefined || d.frozen() || ledger.isPaused(row) || !d.ready()) return;
		if (!(await d.viaPr(row)) || !(await d.repoMatches(row, policy.repos))) return;
		const now = d.now();
		const last = this.#readAt.get(row.taskId);
		if (row.host !== null && last !== undefined && now - last < REMOTE_HEAD_MS) return;
		let head: { sha: string; clean: boolean };
		try {
			head = await d.headOf(row);
		} catch (error) {
			d.log.warn("task_pr_land_retry_read_failed", { task: row.taskId, error: String(error) });
			return;
		}
		if (row.host !== null) this.#readAt.set(row.taskId, now);
		const key = `land-retry:${head.sha}`;
		if (head.sha === land.sha || !head.clean || key in (ledger.get(row.taskId)?.notices ?? {})) return;
		d.log.info("task_pr_land_retry", { task: row.taskId, from: land.sha, to: head.sha });
		let outcome: TaskLandOutcome;
		try {
			outcome = await d.autoLand(row);
		} catch (error) {
			d.log.warn("task_pr_land_retry_failed", { task: row.taskId, error: String(error) });
			return;
		}
		// Refused for now (landing lock, daemon not ready): the next sweep calls again.
		if (outcome.state === "in_flight" || outcome.state === "not_accepted") return;
		ledger.recordNotice(row.taskId, key);
		const fresh = ledger.get(row.taskId);
		const record = fresh?.land;
		if (fresh === undefined || (record?.state !== "blocked" && record?.state !== "held")) return;
		const reason = record.reason ?? "";
		if (ledger.recordNotice(row.taskId, prLandNoticeKey(record.state, record.sha, reason)))
			await d.stop(fresh, record.state, reason);
	}
}
