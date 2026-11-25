import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { confidentBand } from "../lanes/land";
import { readAutoLandHold } from "../ops/apply";
import { evaluateTask, memoryTaskChecks } from "../tasks/evaluate";
import type { TaskGateHooks } from "../tasks/gate";
import { landTask, type TaskLandOutcome, type TaskLandResult, taskLandHold } from "../tasks/land";
import { hostOpsOf, landModeOfRow } from "../tasks/land-remote";
import type { TaskRow } from "../tasks/ledger";
import {
	buildBlockedSettledCard,
	buildMergeSettledCard,
	cardMessage,
	postToThread,
	RECOMMEND_VALUE_MAX,
	setStatusReaction,
	type TaskCard,
	taskLandNote,
} from "../tasks/notify";
import type { PrLandRetry } from "../tasks/pr-land-retry";
import { recordWithConfig } from "../tasks/records";
import {
	AUTO_LAND_MARKER,
	AUTO_LAND_TEXT,
	MERGE_REJECTED_NOTE,
	RECOMMEND_REJECTED_NOTE,
	TASK_LANDING_NOTE,
} from "./daemon-constants";
import { approvalOf, autoLandPolicy, type DaemonContext } from "./daemon-context";
import {
	answerInThread,
	ingestOwnerText,
	LAND_DRAINING_NOTE,
	type LandEntryHost,
	landResultCard,
	landReviewed,
} from "./daemon-task-land-entry";
import { DaemonTaskPrLand } from "./daemon-task-pr-land";
import { taskRuntimeOf } from "./daemon-task-resume";
import { createPrLandRetry } from "./daemon-task-retry";

/** The landing of reached [TASK]s (auto-merge, `머지` button) and the card buttons that put an owner answer in a thread; owns the landing lock and the one-click-per-card keys. */
export class DaemonTaskLanding {
	readonly #ctx: DaemonContext;
	/** Task cards (`<channel>:<ts>`) whose button (`머지`, `추천대로`) was clicked in this process: a second click does nothing. Never cleared. */
	readonly #mergeClicks = new Set<string>();
	/** Approvals (`<channel>:<ts>`) whose `다시 요청` was clicked in this process, on either card. Never cleared. */
	readonly #retryClicks = new Set<string>();
	/** Tasks being landed (auto-merge, `머지` button and PR poll share it): held through `landTask` and, after a handoff, until the "머지해" turn ended. A call meanwhile is `in_flight`. */
	readonly #taskLanding = new Set<string>();
	readonly #prLand: DaemonTaskPrLand; // the PR landing in a `lanes.land` pr repository
	readonly #retry: PrLandRetry;

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
		this.#prLand = new DaemonTaskPrLand(ctx, this.#taskLanding, (task) => this.#afterTaskLanded(task));
		this.#retry = createPrLandRetry(
			ctx,
			() => this.landReady(),
			(row) => this.autoLand(row),
		);
	}

	/** One sweep poll of a review task's open PR (skipped while the task is being landed). */
	pollPrLand(row: TaskRow): Promise<void> {
		return this.#prLand.poll(row);
	}

	/** One sweep step of a `blocked` PR landing: retried once when the task branch got a new tip. */
	async retryPrLand(row: TaskRow): Promise<void> {
		const tasks = this.#ctx.store?.tasks;
		if (tasks !== undefined) await this.#retry.run(row, tasks);
	}

	/** A `머지` click on a task card: the same as answering "머지해" in the task thread. Only a task in review takes it; one click per card per process, except a stopped PR landing's retry button. Every outcome redraws the card. */
	async handleTaskMerge(taskId: string, channel: string | undefined, messageTs: string | undefined): Promise<void> {
		const key = this.#clickKey("merge", taskId, channel, messageTs);
		if (key === undefined) return;
		const redraw = this.#redrawer("merge", taskId, channel, messageTs);
		const requested = `▶ 머지 요청됨 · ${this.#ctx.clockFormat.format(this.#ctx.clock.now())}`;
		const landed = await landReviewed(this.#landHost(), taskId, {
			logKind: "merge",
			marker: "🔘 머지 (버튼)",
			started: (row) => redraw(buildMergeSettledCard(row, `${requested} — 코어 착지 중`)),
			handingOff: (row, result) => redraw(buildMergeSettledCard(row, `${requested} — ${taskLandNote(result)}`)),
		});
		if (landed.kind === "refused") {
			const note = {
				draining: LAND_DRAINING_NOTE,
				in_flight: TASK_LANDING_NOTE,
				bad_thread: MERGE_REJECTED_NOTE,
				wrong_status: `이미 처리됐거나 머지할 상태가 아님 (${landed.row?.status})`,
				not_found: "",
			}[landed.reason];
			if (landed.reason === "draining") this.#mergeClicks.delete(key);
			await redraw(
				landed.row === undefined
					? { text: `⚠️ 이 TASK를 찾을 수 없음 (${taskId})`, buttons: [] }
					: buildMergeSettledCard(landed.row, note),
			);
		} else if (landed.handoff === "rejected") await redraw(buildMergeSettledCard(landed.row, MERGE_REJECTED_NOTE));
		else if (landed.result.state !== "handoff") {
			const card = landResultCard(this.#ctx, landed.row, landed.result, taskLandNote(landed.result));
			// A PR landing that stopped again leaves the retry button and unlocks the card for another click.
			if (card.buttons?.length) this.#mergeClicks.delete(key);
			await redraw(card);
		}
	}

	/** `jabbu-pocket tasks land <id>` (`tasks_land`): the same landing entry as the `머지` button; the result goes to the task thread as a new card (no clicked card to redraw) and back as the IPC answer. */
	async landFromCli(taskId: string): Promise<Record<string, unknown>> {
		const landed = await landReviewed(this.#landHost(), taskId, {
			logKind: "cli_land",
			marker: "🔘 머지 (tasks land)",
		});
		if (landed.kind === "refused") return { ok: false, error: landed.reason, task: taskId, status: landed.row?.status };
		const { row, result } = landed;
		if (landed.handoff === "rejected")
			return { ok: false, error: "handoff_rejected", task: taskId, result, posted: false };
		const note = `tasks land 요청 · ${taskLandNote(result)}`;
		const posted =
			result.state === "handoff"
				? true
				: await postToThread(
						this.#ctx.channels,
						this.#ctx.log,
						row.threadRef,
						landResultCard(this.#ctx, row, result, note),
					);
		return { ok: true, task: taskId, result, posted };
	}

	/** Whether the daemon can land now: started, with a channel, and not draining for a restart. */
	landReady(): boolean {
		return this.#ctx.router?.draining !== true && this.#ctx.adapters.size > 0 && this.#ctx.store !== undefined;
	}

	/** Auto-merge of a reached task (`taskAutoLand`): the core lands a local task (`landTask`); only a `handoff` has the bot answer "머지해" in the thread. `not_accepted`: draining or unstarted daemon, bad thread, "머지해" not in. `in_flight`: the landing lock is held. */
	async autoLand(row: TaskRow, gate?: TaskGateHooks): Promise<TaskLandOutcome> {
		const log = this.#ctx.log;
		if (!this.landReady()) {
			log.info("task_autoland_ignored", { task: row.taskId, reason: "not_ready" });
			return { state: "not_accepted" };
		}
		if (this.#ctx.taskGates?.has(row.taskId) === true) {
			log.info("task_autoland_ignored", { task: row.taskId, reason: "gating" });
			return { state: "in_flight" };
		}
		// A local task in the confident band lands only after the review·QA gate (`TaskGateRunner`), never on the reach.
		const policy = autoLandPolicy(this.#ctx);
		// A task on a host cannot get that gate (the reviewers read a local worktree): it is never auto-merged in the band.
		if (policy !== undefined && row.host !== null && confidentBand(row.risk, policy) !== undefined)
			return { state: "held", reasons: [`원격 TASK는 독립 리뷰·QA 게이트를 받을 수 없음(위험 ${row.risk})`] };
		if (gate !== undefined && policy !== undefined && row.host === null && confidentBand(row.risk, policy)) {
			const decided = await this.#ctx.taskGates?.decide(row, gate, policy);
			if (decided !== undefined) return decided;
		}
		return this.landAuto(row);
	}

	/** The landing half of `autoLand`: the core's landing under the task's landing lock, "머지해" on a handoff. */
	async landAuto(row: TaskRow): Promise<TaskLandOutcome> {
		const log = this.#ctx.log;
		if (this.#taskLanding.has(row.taskId)) {
			log.info("task_autoland_ignored", { task: row.taskId, reason: "in_flight" });
			return { state: "in_flight" };
		}
		this.#taskLanding.add(row.taskId);
		let handedOff = false;
		try {
			const thread = parseThreadRef(row.threadRef);
			if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
				log.warn("task_autoland_rejected", { task: row.taskId, reason: "bad_thread", thread: row.threadRef });
				return { state: "not_accepted" };
			}
			const result = await this.#coreLand(row, "auto");
			if (result.state !== "handoff") return result;
			const posted: { ts?: string } = {};
			const { outcome } = await ingestOwnerText(
				this.#ctx,
				{ channel: thread.channel, threadTs: thread.threadTs, kind: "ch" },
				AUTO_LAND_TEXT,
				AUTO_LAND_MARKER,
				undefined,
				posted,
			);
			if (outcome === "dropped" || outcome === "card_rejected") {
				log.warn("task_autoland_rejected", { task: row.taskId, reason: outcome, marker: posted.ts });
				return { state: "not_accepted" };
			}
			log.info("task_autoland_requested", { task: row.taskId, marker: posted.ts, outcome });
			handedOff = true;
			this.#releaseAfterTurn(row.taskId, thread.channel, posted.ts);
			return result;
		} finally {
			if (!handedOff) this.#taskLanding.delete(row.taskId);
		}
	}

	/** The core's landing of a task (`landTask`, or its PR path in a `lanes.land` pr repository). A remote task is the model turn's. */
	async #coreLand(row: TaskRow, mode: "auto" | "button"): Promise<TaskLandResult> {
		const log = this.#ctx.log;
		const config = this.#ctx.options.config;
		const landMode = await landModeOfRow(config, row);
		if (row.host !== null && landMode?.config.mode !== "pr") {
			log.info("task_land_handoff", { task: row.taskId, mode, reason: "remote" });
			return { state: "handoff", reason: `원격 호스트(${row.host}) TASK` };
		}
		const store = this.#ctx.store;
		const land = this.#ctx.lander;
		if (store === undefined || land === undefined) throw new Error("daemon not started");
		const wikiNotes = this.#ctx.wikiNotes;
		const hostOps = hostOpsOf(config, row.host, this.#ctx.options.herdrRun);
		const result = await (this.#ctx.options.taskLand ?? landTask)(row, {
			mode,
			...(landMode?.config.mode === "pr" ? { pr: this.#prLand.hook(mode, landMode) } : {}),
			// The worktree and branch go with the landing: the note's content is collected right before it starts.
			land: async (request, hooks) => {
				await wikiNotes?.taskDraft(row);
				return land(request, hooks);
			},
			stopChecks: (taskId) => this.#ctx.checkRunner?.cancel(taskId) ?? Promise.resolve(),
			judge: (task, options) => evaluateTask(task, hostOps, memoryTaskChecks(), undefined, options?.integrityBase),
			holdReason: () => {
				const fresh = store.tasks.get(row.taskId);
				return taskLandHold(fresh, {
					frozen: this.#ctx.frozen() !== undefined,
					paused: fresh !== undefined && store.tasks.isPaused(fresh),
					hold: mode === "auto" ? readAutoLandHold(config.homeDir) : undefined,
				});
			},
			ledger: store.tasks,
			afterDone: (task) => this.#afterTaskLanded(task),
		});
		if (result.state === "landed" || result.state === "merged-not-pushed") {
			await wikiNotes?.taskDone(row.taskId, [
				`${result.baseBranch}에 머지 (${result.sha.slice(0, 12)})`,
				result.state === "landed" && result.pushed !== undefined
					? `push ${result.pushed}`
					: result.state === "landed"
						? "push 없음(origin 원격 없음)"
						: `push 안 됨: ${result.reason}`,
			]);
		} else wikiNotes?.taskDropDraft(row);
		const fields = { task: row.taskId, mode, ...result };
		const event = `task_land_${result.state.replace(/-/g, "_")}`;
		if (result.state === "landed" || result.state === "pr-open") log.info(event, fields);
		else log.warn(event, fields);
		return result;
	}

	/** After a core landing closed the task: the reaction follows the ledger, the herdr agent is closed; a failure is a card line. */
	async #afterTaskLanded(row: TaskRow): Promise<string[]> {
		const status = this.#ctx.store?.tasks.get(row.taskId)?.status ?? "done";
		await setStatusReaction(this.#ctx.channels, this.#ctx.log, row.threadRef, status);
		const failed = await this.closeTaskAgent(row);
		return failed === undefined ? [] : [`herdr 워커 정리 실패: ${failed.slice(0, 160)}`];
	}

	/** Ends a closed task's herdr agent where it runs (`herdrCloseTaskAgent`, over ssh for a remote task). Undefined when nothing failed; a failure is logged (`task_agent_close_failed`) and returned. */
	async closeTaskAgent(row: TaskRow): Promise<string | undefined> {
		const config = this.#ctx.options.config; // live: dispatchHosts and recordsRepo are reloadable
		await recordWithConfig(config, this.#ctx.store?.tasks.get(row.taskId) ?? row); // the closed task's last records commit
		const entry = row.host === null ? undefined : config.dispatchHosts?.[row.host];
		if (row.runtime === "herdr" && (row.host === null ? config.herdr === undefined : entry === undefined))
			return undefined;
		const closed = await taskRuntimeOf(this.#ctx, row).close(row);
		if (closed.ok) return undefined;
		this.#ctx.log.warn("task_agent_close_failed", {
			task: row.taskId,
			agent: row.agent,
			host: row.host ?? "local",
			error: closed.error,
		});
		return closed.error;
	}

	/** Frees a task's landing lock once the turn that took its handed-off "머지해" (inbound `<channel>:<markerTs>`) has ended; an inbound not found frees it at once. */
	#releaseAfterTurn(taskId: string, channel: string, markerTs: string | undefined): void {
		const inbound = markerTs === undefined ? undefined : this.#ctx.store?.getInbound(`${channel}:${markerTs}`);
		const router = this.#ctx.router;
		if (inbound === undefined || router === undefined) {
			this.#ctx.log.warn("task_land_release_early", { task: taskId, marker: markerTs });
			this.#taskLanding.delete(taskId);
			return;
		}
		const originKey = inbound.originKey;
		const mailbox = router.mailbox(originKey);
		void mailbox
			.resumePending()
			.then(() => mailbox.whenTurnEnds())
			.catch((error: unknown) => this.#ctx.log.warn("task_land_release_failed", { task: taskId, error: String(error) }))
			.finally(() => this.#taskLanding.delete(taskId));
	}

	/** A `추천대로` click on a blocked task's card: the same as answering "추천대로" in the thread, the button's `value` (the recommendation) quoted. Only a blocked task takes it; one click per card per process. Every outcome redraws the card. */
	async handleTaskRecommend(
		taskId: string,
		value: string | undefined,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const recommend = (value ?? "").replace(/\s+/g, " ").trim().slice(0, RECOMMEND_VALUE_MAX);
		const short = recommend.length > 120 ? `${recommend.slice(0, 119)}…` : recommend;
		if (this.#clickKey("recommend", taskId, channel, messageTs) === undefined) return;
		const redraw = this.#redrawer("recommend", taskId, channel, messageTs);
		const log = this.#ctx.log;
		const row = this.#ctx.store?.tasks.get(taskId);
		if (row === undefined || row.status !== "blocked") {
			log.info("task_recommend_ignored", { task: taskId, reason: row === undefined ? "not_found" : row.status });
			await redraw(
				row === undefined
					? { text: `이미 처리됐거나 막힌 상태가 아님 (TASK 없음: ${taskId})`, buttons: [] }
					: buildBlockedSettledCard(row, `이미 처리됐거나 막힌 상태가 아님 (${row.status})`),
			);
			return;
		}
		const thread = parseThreadRef(row.threadRef);
		if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
			log.warn("task_recommend_inject_rejected", { task: taskId, reason: "bad_thread", thread: row.threadRef });
			await redraw(buildBlockedSettledCard(row, RECOMMEND_REJECTED_NOTE));
			return;
		}
		const requested = `▶ 추천대로 진행 요청됨 · ${this.#ctx.clockFormat.format(this.#ctx.clock.now())}${short === "" ? "" : ` — 추천: ${short}`}`;
		await redraw(buildBlockedSettledCard(row, requested));
		const ownerText = recommend === "" ? "추천대로" : `추천대로 (추천: ${recommend})`;
		const answered = await answerInThread(this.#ctx, "recommend", taskId, thread, ownerText, "🔘 추천대로 (버튼)");
		if (!answered.accepted) await redraw(buildBlockedSettledCard(row, RECOMMEND_REJECTED_NOTE));
	}

	/** The key of a task card's button click (`<channel>:<ts>`), or undefined for a second click of this process (keyed before the first await). */
	#clickKey(
		kind: string,
		taskId: string,
		channel: string | undefined,
		messageTs: string | undefined,
	): string | undefined {
		const key = `${channel ?? "-"}:${messageTs ?? taskId}`;
		if (this.#mergeClicks.has(key)) {
			this.#ctx.log.info(`task_${kind}_ignored`, { task: taskId, reason: "duplicate" });
			return undefined;
		}
		this.#mergeClicks.add(key);
		return key;
	}

	/** Redraws the clicked card (nothing without a card); a failed edit is logged. */
	#redrawer(
		kind: string,
		taskId: string,
		channel: string | undefined,
		messageTs: string | undefined,
	): (card: TaskCard | { text: string; buttons: [] }) => Promise<void> {
		return async (card) => {
			if (channel === undefined || messageTs === undefined) return;
			const port = this.#ctx.channels.forConversation(channel)?.port;
			if (port === undefined) return;
			const msg = "title" in card ? cardMessage(card, port) : card;
			await port
				.edit({ platform: port.platform, conversationId: channel, messageId: messageTs }, msg)
				.catch((error: unknown) =>
					this.#ctx.log.warn(`task_${kind}_card_edit_failed`, { task: taskId, error: String(error) }),
				);
		};
	}

	#landHost(): LandEntryHost {
		return {
			ctx: this.#ctx,
			taskLanding: this.#taskLanding,
			landReady: () => this.landReady(),
			coreLand: (row, mode) => this.#coreLand(row, mode),
			releaseAfterTurn: (taskId, channel, markerTs) => this.#releaseAfterTurn(taskId, channel, markerTs),
		};
	}

	/** A `다시 요청` click on a timed-out approval card: the owner asks the requesting thread to put the request up again (a new turn; approving takes a click on the new card). One click per approval per process. */
	async handleApprovalRetry(
		approvalId: string,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const log = this.#ctx.log;
		if (this.#retryClicks.has(approvalId)) {
			log.info("approval_retry_ignored", { id: approvalId, reason: "duplicate" });
			return;
		}
		this.#retryClicks.add(approvalId);
		const clicked = channel === undefined || messageTs === undefined ? undefined : { channel, ts: messageTs };
		const redraw = (note: string) => approvalOf(this.#ctx).redrawCards(approvalId, note, clicked);
		const row = this.#ctx.store?.getApproval(approvalId);
		const thread = row?.originThreadRef ? parseThreadRef(row.originThreadRef) : undefined;
		const refused =
			row === undefined
				? "승인 기록 없음"
				: row.status !== "expired"
					? `상태 ${row.status}`
					: thread === undefined || thread.threadTs === TOP_LEVEL_TS
						? "요청 스레드를 알 수 없음"
						: undefined;
		if (refused !== undefined || row === undefined || thread === undefined) {
			const reason = row === undefined ? "not_found" : row.status !== "expired" ? row.status : "bad_thread";
			log.info("approval_retry_ignored", { id: approvalId, reason });
			await redraw(`⚠️ 다시 요청할 수 없음 (${refused})`);
			return;
		}
		await redraw(`▶ 다시 요청됨 · ${this.#ctx.clockFormat.format(this.#ctx.clock.now())}`);
		const firstLine = row.summary.split("\n")[0] ?? "";
		const posted: { ts?: string } = {};
		try {
			const { outcome } = await ingestOwnerText(
				this.#ctx,
				{ channel: thread.channel, threadTs: thread.threadTs, kind: "ch" },
				`다시 요청: ${firstLine.slice(0, 200)}\n(방금 시간 초과로 거부된 승인 요청입니다. 같은 요청을 jabbu_request_approval로 다시 올려 주세요.)`,
				"🔘 다시 요청 (버튼)",
				undefined,
				posted,
			);
			if (outcome !== "dropped" && outcome !== "card_rejected") {
				log.info("approval_retry_requested", { id: approvalId, marker: posted.ts, outcome });
				return;
			}
			log.warn("approval_retry_inject_rejected", { id: approvalId, reason: "dropped", marker: posted.ts });
		} catch (error) {
			log.warn("approval_retry_inject_rejected", {
				id: approvalId,
				reason: "error",
				...(posted.ts === undefined ? {} : { marker: posted.ts }),
				error: String(error),
			});
		}
		await redraw("⚠️ 다시 요청을 넣지 못함 — 스레드에 직접 다시 요청해 주세요");
	}
}
