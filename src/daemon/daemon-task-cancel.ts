import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import {
	buildCancelConfirmCard,
	buildCancelRestoredCard,
	buildCancelSettledCard,
	decodeCancelOrigin,
	RECOMMEND_VALUE_MAX,
	type TaskCancelAction,
} from "../tasks/card-buttons";
import { type TaskRow, TaskTransitionError } from "../tasks/ledger";
import { buildBlockedSettledCard, setStatusReaction, type TaskCard } from "../tasks/notify";
import { RECOMMEND_REJECTED_NOTE } from "./daemon-constants";
import type { DaemonContext } from "./daemon-context";
import { answerInThread } from "./daemon-task-land-entry";

/** Shared lock and card redraw helpers provided by `DaemonTaskLanding` for card button handlers. */
export interface TaskCardButtonHost {
	readonly ctx: DaemonContext;
	readonly settledCards: Set<string>;
	readonly pendingCards: Set<string>;
	readonly taskLanding: Set<string>;
	redraw(
		kind: string,
		taskId: string,
		channel: string | undefined,
		messageTs: string | undefined,
		card: TaskCard | { text: string; buttons: [] },
	): Promise<void>;
	closeTaskAgent(row: TaskRow): Promise<string | undefined>;
}

const cardKey = (taskId: string, channel: string | undefined, messageTs: string | undefined): string =>
	`${channel ?? "-"}:${messageTs ?? taskId}`;

const missingTaskCard = (taskId: string): { text: string; buttons: [] } => ({
	text: `⚠️ 이 TASK를 찾을 수 없음 (${taskId})`,
	buttons: [],
});

/**
 * A `추천대로` click on a blocked task's card: the same as answering "추천대로" in the thread, the button's `value`
 * (the recommendation) quoted. Only a blocked task takes it; one click per card per process. Every outcome redraws the card.
 */
export async function handleTaskRecommendAction(
	host: TaskCardButtonHost,
	taskId: string,
	value: string | undefined,
	channel: string | undefined,
	messageTs: string | undefined,
): Promise<void> {
	const { ctx } = host;
	const log = ctx.log;
	const recommend = (value ?? "").replace(/\s+/g, " ").trim().slice(0, RECOMMEND_VALUE_MAX);
	const short = recommend.length > 120 ? `${recommend.slice(0, 119)}…` : recommend;
	const key = cardKey(taskId, channel, messageTs);
	if (host.settledCards.has(key) || host.pendingCards.has(key)) {
		log.info("task_recommend_ignored", { task: taskId, reason: "duplicate" });
		return;
	}
	host.settledCards.add(key);
	const row = ctx.store?.tasks.get(taskId);
	if (row === undefined || row.status !== "blocked") {
		log.info("task_recommend_ignored", { task: taskId, reason: row === undefined ? "not_found" : row.status });
		await host.redraw(
			"recommend",
			taskId,
			channel,
			messageTs,
			row === undefined
				? { text: `이미 처리됐거나 막힌 상태가 아님 (TASK 없음: ${taskId})`, buttons: [] }
				: buildBlockedSettledCard(row, `이미 처리됐거나 막힌 상태가 아님 (${row.status})`),
		);
		return;
	}
	const thread = parseThreadRef(row.threadRef);
	if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
		log.warn("task_recommend_inject_rejected", { task: taskId, reason: "bad_thread", thread: row.threadRef });
		await host.redraw("recommend", taskId, channel, messageTs, buildBlockedSettledCard(row, RECOMMEND_REJECTED_NOTE));
		return;
	}
	const requested = `▶ 추천대로 진행 요청됨 · ${ctx.clockFormat.format(ctx.clock.now())}${short === "" ? "" : ` — 추천: ${short}`}`;
	await host.redraw("recommend", taskId, channel, messageTs, buildBlockedSettledCard(row, requested));
	const ownerText = recommend === "" ? "추천대로" : `추천대로 (추천: ${recommend})`;
	const answered = await answerInThread(ctx, "recommend", taskId, thread, ownerText, "🔘 추천대로 (버튼)");
	if (!answered.accepted) {
		await host.redraw("recommend", taskId, channel, messageTs, buildBlockedSettledCard(row, RECOMMEND_REJECTED_NOTE));
	}
}

/** Handles `취소`, `유지`, and `취소 확정` clicks on `[TASK]` cards with a two-step confirmation flow. */
export async function handleTaskCancelAction(
	host: TaskCardButtonHost,
	action: TaskCancelAction,
	value: string | undefined,
	channel: string | undefined,
	messageTs: string | undefined,
): Promise<void> {
	const { taskId } = action;
	const { ctx } = host;
	const log = ctx.log;
	const key = cardKey(taskId, channel, messageTs);
	if (action.kind === "prompt") {
		if (host.settledCards.has(key) || host.pendingCards.has(key)) {
			log.info("task_cancel_ignored", { task: taskId, reason: "duplicate" });
			return;
		}
		host.pendingCards.add(key);
		try {
			const row = ctx.store?.tasks.get(taskId);
			if (row === undefined) {
				log.info("task_cancel_ignored", { task: taskId, reason: "not_found" });
				await host.redraw("cancel", taskId, channel, messageTs, missingTaskCard(taskId));
				return;
			}
			if (row.status === "done" || row.status === "cancelled") {
				log.info("task_cancel_ignored", { task: taskId, reason: row.status });
				await host.redraw(
					"cancel",
					taskId,
					channel,
					messageTs,
					buildCancelSettledCard(row, `이미 닫힌 작업입니다 (${row.status})`),
				);
				return;
			}
			if (host.taskLanding.has(taskId)) {
				log.info("task_cancel_ignored", { task: taskId, reason: "in_flight" });
				await host.redraw(
					"cancel",
					taskId,
					channel,
					messageTs,
					buildCancelSettledCard(row, "이미 착지 중이라 취소할 수 없음"),
				);
				return;
			}
			const origin =
				decodeCancelOrigin(value) ??
				(row.status === "blocked" ? { kind: "blocked", recommend: "" } : { kind: "merge" });
			log.info("task_cancel_prompted", { task: taskId, status: row.status });
			await host.redraw("cancel", taskId, channel, messageTs, buildCancelConfirmCard(row, origin));
		} finally {
			host.pendingCards.delete(key);
		}
		return;
	}

	if (action.kind === "keep") {
		if (host.settledCards.has(key) || host.pendingCards.has(key)) {
			log.info("task_cancel_keep_ignored", { task: taskId, reason: "duplicate" });
			return;
		}
		host.pendingCards.add(key);
		try {
			const row = ctx.store?.tasks.get(taskId);
			if (row === undefined) {
				log.info("task_cancel_keep_ignored", { task: taskId, reason: "not_found" });
				await host.redraw("cancel_keep", taskId, channel, messageTs, missingTaskCard(taskId));
				return;
			}
			if (row.status === "done" || row.status === "cancelled") {
				log.info("task_cancel_keep_ignored", { task: taskId, reason: row.status });
				await host.redraw(
					"cancel_keep",
					taskId,
					channel,
					messageTs,
					buildCancelSettledCard(row, `이미 닫힌 작업입니다 (${row.status})`),
				);
				return;
			}
			log.info("task_cancel_kept", { task: taskId, status: row.status });
			await host.redraw(
				"cancel_keep",
				taskId,
				channel,
				messageTs,
				buildCancelRestoredCard(row, decodeCancelOrigin(value)),
			);
		} finally {
			host.pendingCards.delete(key);
		}
		return;
	}

	if (host.settledCards.has(key) || host.pendingCards.has(key)) {
		log.info("task_cancel_ignored", { task: taskId, reason: "duplicate" });
		return;
	}
	const first = ctx.store?.tasks.get(taskId);
	if (ctx.router?.draining === true) {
		log.info("task_cancel_ignored", { task: taskId, reason: "draining" });
		await host.redraw(
			"cancel",
			taskId,
			channel,
			messageTs,
			first === undefined
				? { text: "재시작 준비 중이라 취소를 받지 않음", buttons: [] }
				: buildCancelSettledCard(first, "재시작 준비 중이라 취소를 받지 않음"),
		);
		return;
	}
	if (host.taskLanding.has(taskId)) {
		log.info("task_cancel_ignored", { task: taskId, reason: "in_flight" });
		await host.redraw(
			"cancel",
			taskId,
			channel,
			messageTs,
			first === undefined
				? { text: "이미 착지 중이라 취소할 수 없음", buttons: [] }
				: buildCancelSettledCard(first, "이미 착지 중이라 취소할 수 없음"),
		);
		return;
	}
	host.settledCards.add(key);
	host.taskLanding.add(taskId);
	try {
		const store = ctx.store;
		if (store === undefined || first === undefined) {
			log.info("task_cancel_ignored", { task: taskId, reason: "not_found" });
			await host.redraw("cancel", taskId, channel, messageTs, missingTaskCard(taskId));
			return;
		}
		if (first.status === "done" || first.status === "cancelled") {
			log.info("task_cancel_ignored", { task: taskId, reason: first.status });
			await host.redraw(
				"cancel",
				taskId,
				channel,
				messageTs,
				buildCancelSettledCard(first, `이미 닫힌 작업입니다 (${first.status})`),
			);
			return;
		}
		await ctx.taskGates?.abort(taskId);
		await ctx.checkRunner?.cancel(taskId);
		const fresh = store.tasks.get(taskId);
		if (fresh === undefined || fresh.status === "done" || fresh.status === "cancelled") {
			log.info("task_cancel_ignored", { task: taskId, reason: fresh === undefined ? "not_found" : fresh.status });
			await host.redraw(
				"cancel",
				taskId,
				channel,
				messageTs,
				fresh === undefined
					? missingTaskCard(taskId)
					: buildCancelSettledCard(fresh, `이미 닫힌 작업입니다 (${fresh.status})`),
			);
			return;
		}
		let closed: TaskRow;
		try {
			closed = store.tasks.transition(taskId, "cancelled", "human", "cancel button");
		} catch (error) {
			if (!(error instanceof TaskTransitionError)) throw error;
			const current = store.tasks.get(taskId);
			log.info("task_cancel_ignored", { task: taskId, reason: current?.status ?? "transition_error" });
			await host.redraw(
				"cancel",
				taskId,
				channel,
				messageTs,
				current === undefined
					? missingTaskCard(taskId)
					: buildCancelSettledCard(current, `이미 닫힌 작업입니다 (${current.status})`),
			);
			return;
		}
		ctx.wikiNotes?.taskDropDraft(closed);
		await setStatusReaction(ctx.channels, log, closed.threadRef, "cancelled");
		const closeErr = await host.closeTaskAgent(closed);
		const note = `❌ 취소됨 · ${ctx.clockFormat.format(ctx.clock.now())} — 워크트리·브랜치는 그대로 남습니다${closeErr === undefined ? "" : ` · 워커 정리 실패: ${closeErr.slice(0, 120)}`}`;
		await host.redraw("cancel", taskId, channel, messageTs, buildCancelSettledCard(closed, note));
		log.info("task_cancel_done", {
			task: taskId,
			from: fresh.status,
			...(closeErr === undefined ? {} : { closeError: closeErr }),
		});
	} finally {
		host.taskLanding.delete(taskId);
	}
}
