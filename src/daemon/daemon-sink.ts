import { randomBytes } from "node:crypto";
import type { CoreSink, DeliveryItem, DeliverySource } from "../channel/types";
import type { JabbuConfig } from "../config";
import { parseThreadRef, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { sessionDirFor } from "../core/origin";
import { type ChatPlatform, parseChatOrigin } from "../core/origin-key";
import { COMMAND_TEXT, parseCommand } from "../core/types";
import { type LaneAction, parseLaneActionId } from "../lanes/card";
import { classifyLaneControl } from "../lanes/control";
import type { LaneManager } from "../lanes/manager";
import { LaneInputError } from "../lanes/manager-constants";
import { parseReservationActionId, type ReservationAction } from "../lanes/reservations";
import { isLaneOrigin, isTaskOrigin, type LaneRow, taskOriginKey } from "../lanes/status";
import {
	buildClosedLaneQuestion,
	classifyClosedLaneMessage,
	DISCORD_LANE_CHANNEL_MISSING,
	isOwnerAcceptText,
	type LaneTrigger,
	parseLaneTrigger,
	parsePrCommand,
	parsePrWatchCommand,
} from "../lanes/trigger";
import { laneTriggerRefusal } from "../lanes/trigger-format";
import { triggerWorkflow } from "../lanes/workflow";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { parseApprovalRetryActionId } from "../safety/approval";
import { AMBIGUOUS_NOTICE_OP_PREFIX, INTERIM_INFIX, LOG_COPY_SUFFIX, PEER_SILENCE_OP_PREFIX } from "../store/db";
import type { DeliveryRow, InboundRow } from "../store/db-rows";
import type { TaskRow } from "../tasks/ledger";
import { parseTaskMergeActionId, parseTaskRecommendActionId } from "../tasks/notify";
import type { CrashPoint } from "./crash";
import {
	DRAIN_DEFERRED_COMMAND_TEXT,
	LANE_DRAIN_REFUSED_TEXT,
	PEER_HOP_NOTICE_CURSOR,
	PEER_HOP_RESET_CURSOR,
} from "./daemon-constants";
import { approvalOf, type DaemonContext, dispatchPending, postThreadNotices, startedStore } from "./daemon-context";
import type { DaemonStore } from "./daemon-store";
import type { PendingDispatchSweep } from "./daemon-sweeps";
import type { DaemonTaskLanding } from "./daemon-task-land";
import { taskMailboxPort, taskRuntimeOf } from "./daemon-task-resume";
import { isSideOpRef } from "./restart";
import { laneChannelOf } from "./thread-target";

/** What the core sink needs beyond the daemon context: the boot's ledger and the state other daemon parts share. */
export interface CoreSinkDeps {
	store: DaemonStore;
	sessionsRoot: string;
	/** Threads told "재시작 뒤에 처리" for an owner message held by the current drain: once per thread per drain. */
	drainDeferNoticed: Set<string>;
	pending: PendingDispatchSweep;
	landing: DaemonTaskLanding;
	statusText: (originKey: string) => Promise<string>;
}

/**
 * The inbound side of the daemon: the core sink every chat adapter feeds, and the lane and [TASK] commands, controls
 * and buttons the core settles itself instead of sending them to an omp session.
 */
export class DaemonInbound {
	readonly #ctx: DaemonContext;

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
	}

	get #lanes(): LaneManager | undefined {
		return this.#ctx.lanes;
	}

	/** The core side of every chat adapter: owner and peer messages, slash commands, card replies and buttons. */
	coreSink(deps: CoreSinkDeps): CoreSink {
		const ctx = this.#ctx;
		const store = deps.store;
		const log = ctx.log;
		const sessionsRoot = deps.sessionsRoot;
		const core: CoreSink = {
			onInbound: (message) => {
				// A message in a work lane's thread belongs to that lane's origin, not to the DM conversation.
				const lane = store.getLaneByThread(message.threadRef);
				const originKey = lane?.originKey ?? message.originKey;
				store.ensureOrigin(originKey, lane?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1));
				// A closed lane stays closed for anything but `!reopen`: a question (or a `!followup` payload) reaches its
				// session behind the answer-only notice; control commands stay as typed — the mailbox reads the recorded text.
				// `머지해`/`폐기해` (the whole message, while the landing waits) are the card's buttons in words.
				const closedAs =
					lane?.status === "closed" ? classifyClosedLaneMessage(message.text, lane.meta.land?.state) : undefined;
				const { inserted, row } = store.recordInbound({
					originKey,
					platformMessageId: message.platformMessageId,
					textRef: closedAs === "question" ? buildClosedLaneQuestion(message.text) : message.text,
					threadRef: message.threadRef,
					injected: message.injected === true,
				});
				if (!inserted) return { duplicate: true };
				// An owner message lets a peer-capped thread continue: the cap counts peer rows after this moment.
				if (store.countPeerInboundSince(message.threadRef, 0) > 0) {
					store.setCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`, String(ctx.clock.now()));
				}
				if (parseCommand(message.text)?.kind === "restart") {
					// Ahead of every lane, task and drain branch: the mailbox answers `!restart` at once, mid-drain too (held
					// for the next process it would restart again), without a turn or a driver.
					dispatchPending(ctx, originKey);
					return {};
				}
				// `!prwatch off <레인>` stops a published PR's tracking; the core settles it wherever the owner writes it,
				// and the lane's omp session never sees it (the lane is named, so no position in a thread implies it).
				const prWatch = parsePrWatchCommand(message.text);
				if (prWatch !== undefined) {
					void this.#settleLaneCommand(
						row,
						"problem" in prWatch ? "-" : prWatch.lane,
						"problem" in prWatch
							? { kind: "refused", text: prWatch.problem }
							: { kind: "prwatch-off", lane: prWatch.lane },
					);
					return {};
				}
				if (lane) {
					// `멈춰`/`계속` (the whole message) are the lane's hold and release: the core settles them itself,
					// before any closed-lane reading — a closed lane's pause holds only its auto-merge.
					const control = classifyLaneControl(message.text);
					if (control !== undefined) {
						void this.#settleLaneControl(row, lane.name, control);
						return {};
					}
					if (lane.status === "paused") this.#heldLaneNotice(lane);
					// The core settles these itself; they never reach the lane's omp session.
					const refusal = closedAs === "reopen" ? ctx.lanes?.reopenRefusal(lane) : undefined;
					if (closedAs === "land" || closedAs === "discard") {
						void this.#settleLaneCommand(row, lane.name, { kind: closedAs });
						return {};
					}
					// `!pr …` marks the closed lane's work as a GitHub PR; the lane session never sees it.
					const prCommand = closedAs === "pr" ? parsePrCommand(message.text) : undefined;
					if (prCommand !== undefined) {
						void this.#settleLaneCommand(
							row,
							lane.name,
							"problem" in prCommand ? { kind: "refused", text: prCommand.problem } : { kind: "pr", ...prCommand },
						);
						return {};
					}
					if (lane.status === "not-done" && isOwnerAcceptText(message.text)) {
						void this.#settleLaneCommand(row, lane.name, { kind: "accept" });
						return {};
					}
					if (refusal !== undefined) {
						void this.#settleLaneCommand(row, lane.name, { kind: "refused", text: refusal });
						return {};
					}
					ctx.lanes?.onOwnerMessage(lane, message.text);
				} else {
					// `멈춰`/`계속` (the whole message) in a [TASK] thread hold or release that thread's one active task; the
					// core settles it like a lane control. A thread without an active task keeps the message as it is.
					const control = store.tasks.isTaskRoot(message.threadRef) ? classifyLaneControl(message.text) : undefined;
					if (control !== undefined && this.#activeTasksOf(message.threadRef).length > 0) {
						void this.#settleTaskControl(row, control);
						return {};
					}
					const trigger = parseLaneTrigger(message.text);
					if (trigger) {
						// A drain must not create a worktree and branch mid-restart, and a pending trigger row would reach
						// the DM's omp session after it instead of starting the lane: refuse it with a retry hint.
						if (ctx.router?.draining === true)
							void this.#settleLaneCommand(row, trigger.title, { kind: "refused", text: LANE_DRAIN_REFUSED_TEXT });
						else void this.#startLane(row, trigger);
						return {};
					}
					const triggerRefusal = laneTriggerRefusal(message.text);
					if (triggerRefusal !== undefined) {
						void this.#settleLaneCommand(row, "-", { kind: "refused", text: triggerRefusal });
						return {};
					}
				}
				if (ctx.router?.draining === true) {
					// Restart drain: the row stays pending for the next process (or the cancel) to dispatch. The owner hears
					// so once per thread, or a held message looks ignored (independent of `restartNotice`). A slash command
					// answers with the same text itself (onCommand).
					log.info("drain_deferred", { origin: originKey, id: row.platformMessageId });
					if (!row.platformMessageId.startsWith("slash:") && !deps.drainDeferNoticed.has(message.threadRef)) {
						deps.drainDeferNoticed.add(message.threadRef);
						postThreadNotices(ctx, [message.threadRef], DRAIN_DEFERRED_COMMAND_TEXT);
					}
					return {};
				}
				// Recorded durably first; dispatch (which may start omp) must not delay the 👀 acknowledgement.
				dispatchPending(ctx, originKey);
				return {};
			},
			onPeerInbound: (message, hop) => {
				// Never the owner paths: no lane routing, no `!reopen`, no lane trigger, no command. A work lane's thread
				// belongs to the owner and its worker; a peer there is dropped before any row exists.
				if (store.getInbound(message.platformMessageId) !== undefined) return { duplicate: true };
				if (store.getLaneByThread(message.threadRef) !== undefined) return { dropped: "peer_in_lane_thread" };
				const resetAt = store.getCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`);
				const since = Math.max(ctx.clock.now() - hop.windowMs, resetAt === undefined ? 0 : Number(resetAt) + 1);
				if (store.countPeerInboundSince(message.threadRef, since) >= hop.turns) {
					// One notice per cap episode: the marker is the owner-reset moment it was posted under.
					const marker = resetAt ?? "0";
					const noticeKey = `${PEER_HOP_NOTICE_CURSOR}${message.threadRef}`;
					const notice = store.getCursor(noticeKey) !== marker;
					if (notice) store.setCursor(noticeKey, marker);
					return { dropped: "peer_hop_cap", notice };
				}
				store.ensureOrigin(message.originKey, sessionDirFor(sessionsRoot, message.originKey, 1));
				const { inserted, row } = store.recordInbound({
					originKey: message.originKey,
					platformMessageId: message.platformMessageId,
					textRef: message.text,
					threadRef: message.threadRef,
					peerUserId: message.peer.userId,
				});
				if (!inserted) return { duplicate: true };
				if (ctx.frozen() !== undefined) {
					// Recorded only: the mailbox holds autonomous rows while frozen, the first sweep after the unfreeze runs it.
					log.info("frozen_deferred", { origin: message.originKey, id: row.platformMessageId });
					deps.pending.frozenHeldOrigins.add(message.originKey);
					return { held: "frozen" };
				}
				if (ctx.router?.draining === true) {
					log.info("drain_deferred", { origin: message.originKey, id: row.platformMessageId });
					return {};
				}
				dispatchPending(ctx, message.originKey);
				return {};
			},
			onPeerSeen: (seen) => void store.notePeerSeen(seen),
			onCommand: ({ command, arg, originKey, channel }) => {
				if (command === "status") return deps.statusText(originKey);
				// A slash command leaves no message to thread under, so it is recorded as an owner message at the
				// top level of the conversation it was typed in: the answer lands right there as the only trace (empty
				// ack — no placeholder root post, no "see the thread" redirect).
				core.onInbound({
					platformMessageId: `slash:${channel}:${randomBytes(6).toString("hex")}`,
					originKey,
					ownerVerified: true,
					text: arg === "" ? COMMAND_TEXT[command] : `${COMMAND_TEXT[command]} ${arg}`,
					threadRef: threadRefOf(channel, TOP_LEVEL_TS),
				});
				// A drain holds the recorded command for the next process; say so, or the owner sees nothing and retypes it.
				// `!restart` is never held: its answer is already on the ledger.
				return ctx.router?.draining === true && command !== "restart" ? DRAIN_DEFERRED_COMMAND_TEXT : undefined;
			},
			knowsThread: (threadRef) => store.getLaneByThread(threadRef) !== undefined || store.hasInboundThread(threadRef),
			hasInbound: (platformMessageId) => store.getInbound(platformMessageId) !== undefined,
			inboundText: (platformMessageId) => store.getInbound(platformMessageId)?.textRef,
			isDraining: () => ctx.router?.draining === true,
			// The thread of an approval card is `<card channel>:<card ts>` — the ledger's approval id.
			onCardReply: ({ threadRef, platformMessageId, text, injected }) => {
				const ts = parseThreadRef(platformMessageId)?.threadTs ?? platformMessageId;
				return approvalOf(ctx).handleCardReply({ approvalId: threadRef, ts, text, injected });
			},
			onAction: ({ actionId, value, userId, channel, messageTs, interactionId }) => {
				if (approvalOf(ctx).handleAction({ actionId, userId, answerId: interactionId })) return;
				const retry = parseApprovalRetryActionId(actionId);
				if (retry !== undefined)
					return deps.landing.handleApprovalRetry(`${retry.channel}:${retry.ts}`, channel, messageTs);
				const taskId = parseTaskMergeActionId(actionId);
				if (taskId !== undefined) return deps.landing.handleTaskMerge(taskId, channel, messageTs);
				const recommended = parseTaskRecommendActionId(actionId);
				if (recommended !== undefined) return deps.landing.handleTaskRecommend(recommended, value, channel, messageTs);
				const reservationAction = parseReservationActionId(actionId);
				if (reservationAction !== undefined)
					return this.#handleReservationButton(reservationAction, channel, messageTs);
				const laneAction = parseLaneActionId(actionId);
				if (laneAction !== undefined) return this.#handleLaneButton(laneAction, channel, messageTs);
				log.info("action_ignored", { action: actionId, user: userId });
			},
		};
		return core;
	}

	/** `작업: <제목> @<경로>`: settled with its own answer (the lane's thread is the real output), never sent to omp. */
	async #startLane(row: InboundRow, trigger: LaneTrigger): Promise<void> {
		await this.#settleOwn("lane", "lane_start", row, async () => {
			const channel = laneChannelOf(this.#ctx, row.originKey, parseThreadRef(row.threadRef)?.channel);
			try {
				if (channel === undefined && parseChatOrigin(row.originKey)?.platform === "discord") {
					throw new LaneInputError(DISCORD_LANE_CHANNEL_MISSING);
				}
				if (!this.#lanes || channel === undefined) throw new Error("lanes unavailable");
				// Only a workflow call at the very start of the brief is a choice; the call is cut from the brief.
				const called = triggerWorkflow(trigger.brief);
				const lane = await this.#lanes.start({
					...trigger,
					...(called === undefined ? {} : { brief: called.brief, workflow: called.choice }),
					channel,
					parentOrigin: row.originKey,
					reuseOpen: true,
				});
				const link = await this.#lanes.threadLink(lane);
				if (lane.reused === true) {
					return `↪ 같은 작업 레인 \`${lane.name}\`이 이미 열려 있어 새로 만들지 않았습니다${link === undefined ? "" : `: ${link}`}`;
				}
				const reply =
					link === undefined
						? `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 새 스레드에서 진행 상황을 확인하세요.`
						: `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 레인 스레드에서 진행 상황을 확인하세요: ${link}`;
				return lane.startNote === undefined ? reply : `${reply}\n${lane.startNote}`;
			} catch (error) {
				if (error instanceof LaneInputError) return `⚠️ 작업 레인을 시작하지 못했습니다: ${error.message}`;
				this.#ctx.log.error("lane_start_failed", { id: row.platformMessageId, error: String(error) });
				return "⚠️ 작업 레인을 시작하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * A message the core answers itself (`<kind>:<id>` op ref): settled with the text `answer` makes, never sent to the
	 * conversation's omp session. A throw anywhere settles it as failed (`failedAs`).
	 */
	async #settleOwn(
		kind: "lane" | "task",
		failedAs: string,
		row: InboundRow,
		answer: () => Promise<string>,
	): Promise<void> {
		try {
			const opRef = `${kind}:${row.platformMessageId}`;
			startedStore(this.#ctx).markDispatched(row.platformMessageId, { opRef, entryCursor: null });
			const reply = await answer();
			startedStore(this.#ctx).recordAnswer({
				originKey: row.originKey,
				opRef,
				threadRef: row.threadRef,
				parts: [reply],
			});
		} catch (error) {
			this.#settleFailed(failedAs, row, error);
		}
	}

	/**
	 * `머지해` / `폐기해` in a closed lane's thread, `닫아` in a `not-done` lane's thread (or a `!reopen` the lane
	 * cannot take: `refusal`): settled with the core's own answer like a lane start — the lane's omp session never
	 * sees it. The answer is recorded once the landing ended; a landing cut off by a restart is finished by the lane
	 * tick and shown on the lane's card.
	 */
	async #settleLaneCommand(
		row: InboundRow,
		name: string,
		command:
			| { kind: "land" | "discard" | "accept" }
			| { kind: "refused"; text: string }
			| { kind: "pr"; repo?: string; prNumber?: number }
			| { kind: "prwatch-off"; lane: string },
	): Promise<void> {
		await this.#settleOwn("lane", "lane_command", row, async () => {
			try {
				const lanes = this.#ctx.lanes;
				if (!lanes) throw new Error("lanes unavailable");
				if (command.kind === "refused") return `⚠️ ${command.text}`;
				if (command.kind === "accept") return (await lanes.acceptByOwner(name)).text;
				if (command.kind === "pr") {
					const { kind: _pr, ...given } = command;
					const outcome = await lanes.attachExternalPr(name, given);
					return outcome.handled ? outcome.text : `⚠️ ${outcome.text}`;
				}
				if (command.kind === "prwatch-off") {
					const outcome = await lanes.stopPrWatch(command.lane);
					return outcome.handled ? outcome.text : `⚠️ ${outcome.text}`;
				}
				return (command.kind === "land" ? await lanes.requestLand(name, "owner") : await lanes.discard(name)).text;
			} catch (error) {
				this.#ctx.log.error("lane_command_failed", { lane: name, command: command.kind, error: String(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * `멈춰` / `계속` in a lane's thread (the whole message, judged by `classifyLaneControl`): settled with the
	 * core's own answer like a lane start — the lane's omp session never sees it. The answer is whatever the
	 * manager re-read after stopping (or resuming) the lane.
	 */
	async #settleLaneControl(row: InboundRow, name: string, control: "pause" | "resume"): Promise<void> {
		await this.#settleOwn("lane", "lane_control", row, async () => {
			try {
				const lanes = this.#ctx.lanes;
				if (!lanes) throw new Error("lanes unavailable");
				return (
					control === "pause" ? await lanes.pause(name, "owner-message") : await lanes.resume(name, "owner-message")
				).text;
			} catch (error) {
				this.#ctx.log.error("lane_control_failed", { lane: name, control, error: String(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/** A thread's working or blocked [TASK]s: the ones a `멈춰`/`계속` there can act on. */
	#activeTasksOf(threadRef: string): TaskRow[] {
		return startedStore(this.#ctx)
			.tasks.getByThread(threadRef)
			.filter((task) => task.status === "working" || task.status === "blocked");
	}

	/**
	 * `멈춰`/`계속` in a [TASK] thread: settled with the core's own answer (`task:` op ref), never sent to omp. With
	 * more than one active task in the thread nothing is applied and the answer lists their ids.
	 */
	async #settleTaskControl(row: InboundRow, control: "pause" | "resume"): Promise<void> {
		await this.#settleOwn("task", "task_control", row, async () => {
			try {
				const active = this.#activeTasksOf(row.threadRef);
				const only = active.length === 1 ? active[0] : undefined;
				return only === undefined
					? `이 스레드에 활성 TASK가 여럿입니다(${active.map((task) => task.taskId).join(", ")}) — 아무것도 ${control === "pause" ? "멈추지" : "재개하지"} 않았습니다. \`jabbu-pocket tasks ${control} <id>\`로 하나를 고르세요.`
					: (await this.controlTask(only.taskId, control)).text;
			} catch (error) {
				this.#ctx.log.error("task_control_failed", { thread: row.threadRef, control, error: String(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * A core-settled message whose store write threw (its callers fire and forget it): logged, and a row already
	 * marked dispatched is discarded — left dispatched it would trip `inbound_starved` and get the restart's
	 * interrupted notice for a turn that never ran.
	 */
	#settleFailed(kind: string, row: InboundRow, error: unknown): void {
		this.#ctx.log.error("lane_settle_failed", { kind, id: row.platformMessageId, error: String(error) });
		try {
			if (startedStore(this.#ctx).getInbound(row.platformMessageId)?.state === "dispatched") {
				startedStore(this.#ctx).discard(row.platformMessageId);
			}
		} catch (discardError) {
			this.#ctx.log.error("lane_settle_discard_failed", {
				kind,
				id: row.platformMessageId,
				error: String(discardError),
			});
		}
	}

	/**
	 * Owner pause/resume of one [TASK] (thread phrase or `jabbu-pocket tasks pause|resume`). A pause marks the ledger first
	 * (the sweep holds its prompts, stale notice and auto-merge from then on), then sends the worker an Esc and reports
	 * only what herdr re-read. A resume lifts the sweep hold only; it never prompts the worker. `ok: false` = nothing
	 * was applied.
	 */
	async controlTask(taskId: string, control: "pause" | "resume"): Promise<{ ok: boolean; text: string }> {
		const tasks = startedStore(this.#ctx).tasks;
		const row = tasks.get(taskId);
		if (row === undefined) return { ok: false, text: `TASK를 찾지 못했습니다: ${taskId}` };
		if (control === "resume") {
			if (!tasks.isPaused(row)) return { ok: true, text: `${taskId}는 멈춘 상태가 아닙니다.` };
			const after = tasks.unpauseTask(taskId);
			if (tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 재개를 확인하지 못했습니다.` };
			// A headless task's rows the pause held go in now (a herdr task's worker is never prompted here).
			if (row.runtime === "headless") await taskMailboxPort(this.#ctx).resumePending(taskOriginKey(row.agent));
			this.#ctx.log.info("task_resumed", { task: taskId });
			return {
				ok: true,
				text: `▶ ${taskId} 재개했습니다 — 스윕 재촉·stale 알림·자동 머지 보류를 풀었습니다. 워커에 재개 프롬프트는 보내지 않았습니다(필요하면 jabbu_dispatch로 보냅니다).`,
			};
		}
		if (row.status !== "working" && row.status !== "blocked") {
			return { ok: false, text: `${taskId}는 ${row.status} 상태라 멈추지 않았습니다(working·blocked만 멈춥니다).` };
		}
		const after = tasks.pauseTask(taskId);
		if (!tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 멈춤을 기록하지 못했습니다.` };
		this.#ctx.log.info("task_paused", { task: taskId });
		let worker: string;
		let stopped = false;
		if (row.runtime === "herdr" && this.#ctx.options.config.herdr === undefined) {
			worker = "herdr가 꺼져 있어 Esc를 보내지 않았습니다";
		} else {
			const interrupted = await taskRuntimeOf(this.#ctx, row).interrupt(row);
			this.#ctx.log.info("task_interrupt", {
				task: taskId,
				confirmed: interrupted.confirmed,
				status: interrupted.status,
			});
			worker = interrupted.text;
			stopped = interrupted.confirmed;
		}
		// Only a re-read stopped worker leads with "멈췄습니다"; otherwise only the sweep hold is certain.
		const lead = stopped ? `⏸ ${taskId} 멈췄습니다` : `⚠️ ${taskId} 스윕만 멈췄습니다(워커 멈춤 미확인)`;
		return {
			ok: true,
			text: `${lead} — 스윕 재촉·stale 알림·자동 머지를 보류합니다. 워커: ${worker}. 재개는 \`계속\` 또는 \`jabbu-pocket tasks resume ${taskId}\`.`,
		};
	}

	/** One notice per pause (keyed by `pausedAt`) that held thread messages wait: the row stays pending, `계속` delivers it. */
	#heldLaneNotice(lane: LaneRow): void {
		const store = startedStore(this.#ctx);
		// A terminal hand-over says so once per attach; a plain pause once per pause.
		const attach = lane.meta.attach;
		const key =
			attach === undefined
				? `lane_held_notice:${lane.name}:${lane.meta.pausedAt ?? 0}`
				: `lane_attach_notice:${lane.name}:${attach.at}`;
		if (store.getCursor(key) !== undefined) return;
		store.setCursor(key, String(this.#ctx.clock.now()));
		const route = this.#ctx.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		const text =
			attach === undefined
				? "⏸ 멈춘 상태라 전달하지 않았습니다 — `계속`이라고 쓰면 전달합니다."
				: "🖥 오너가 터미널에서 작업 중이라 전달하지 않았습니다 — 터미널 omp를 끝내면 전달합니다.";
		void route.port
			.post(route.target, { text })
			.catch((error: unknown) =>
				this.#ctx.log.warn("lane_held_notice_failed", { lane: lane.name, error: String(error) }),
			);
	}

	/**
	 * A `머지` / `폐기` click on a lane's Outcome card: the core lands or discards the lane and redraws the card with
	 * the result. A lane that is not waiting for it (already landed, discarded, working again, or a click while the
	 * first one still runs) takes nothing; a lane that no longer exists loses the buttons with a note.
	 */
	async #handleLaneButton(
		action: LaneAction,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const { kind, name } = action;
		const lanes = this.#ctx.lanes;
		if (lanes === undefined || this.#ctx.store?.getLane(name) === undefined) {
			this.#ctx.log.info(`lane_${kind}_ignored`, { lane: name, reason: "not_found" });
			const port = channel === undefined ? undefined : this.#ctx.channels.forConversation(channel)?.port;
			if (port === undefined || channel === undefined || messageTs === undefined) return;
			await port
				.edit(
					{ platform: port.platform, conversationId: channel, messageId: messageTs },
					{ text: `⚠️ 이 레인을 찾을 수 없음 (${name})`, buttons: [] },
				)
				.catch((error: unknown) => this.#ctx.log.warn("lane_card_edit_failed", { lane: name, error: String(error) }));
			return;
		}
		const outcome =
			action.kind === "session"
				? await lanes.pickSession(name, action.index)
				: kind === "merge"
					? await lanes.requestLand(name, "owner")
					: kind === "discard"
						? await lanes.discard(name)
						: kind === "publish"
							? await lanes.requestPublish(name)
							: kind === "hold"
								? await lanes.hold(name)
								: kind === "pause"
									? await lanes.pause(name, "button")
									: await lanes.resume(name, "button");
		this.#ctx.log.info(outcome.handled ? `lane_${kind}_requested` : `lane_${kind}_ignored`, { lane: name });
		if (kind === "pause" || kind === "resume" || kind === "session") {
			// The status message changes, but the owner clicked: the answer tells what was re-read.
			const lane = this.#ctx.store?.getLane(name);
			const route = lane === undefined ? undefined : this.#ctx.channels.forThreadRef(lane.threadRef);
			if (route !== undefined) {
				await route.port
					.post(route.target, { text: outcome.text })
					.catch((error: unknown) =>
						this.#ctx.log.warn("lane_button_reply_failed", { lane: name, error: String(error) }),
					);
			}
			return;
		}
		if (outcome.handled) return;
		// A refused click changes no card, so the owner is told why in the lane's thread (a text command gets the same).
		const lane = this.#ctx.store?.getLane(name);
		const route = lane === undefined ? undefined : this.#ctx.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		await route.port
			.post(route.target, { text: `⚠️ ${outcome.text}` })
			.catch((error: unknown) => this.#ctx.log.warn("lane_button_reply_failed", { lane: name, error: String(error) }));
	}

	/**
	 * A `▶ 시작` / `✖ 취소` click on a lane reservation card (the adapter already refused every user but the owner). The
	 * card is redrawn without buttons once the reservation has left `waiting`/`ready`; a refusal that leaves it standing
	 * is told in its thread.
	 */
	async #handleReservationButton(
		action: ReservationAction,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const lanes = this.#ctx.lanes;
		const store = this.#ctx.store;
		if (lanes === undefined || store === undefined) return;
		const outcome =
			action.kind === "start" ? await lanes.startReservation(action.id) : lanes.cancelReservation(action.id);
		this.#ctx.log.info(
			outcome.handled ? `lane_reservation_${action.kind}` : `lane_reservation_${action.kind}_ignored`,
			{
				reservation: action.id,
			},
		);
		const state = store.getLaneReservation(action.id)?.state;
		const standing = state === "waiting" || state === "ready";
		const port = channel === undefined ? undefined : this.#ctx.channels.forConversation(channel)?.port;
		if (!standing && port !== undefined && channel !== undefined && messageTs !== undefined) {
			await port
				.edit(
					{ platform: port.platform, conversationId: channel, messageId: messageTs },
					{ text: outcome.handled ? outcome.text : `⚠️ ${outcome.text}`, buttons: [] },
				)
				.catch((error: unknown) =>
					this.#ctx.log.warn("lane_reservation_card_edit_failed", { reservation: action.id, error: String(error) }),
				);
			return;
		}
		if (outcome.handled) return;
		const reservation = store.getLaneReservation(action.id);
		const route = reservation === undefined ? undefined : this.#ctx.channels.forThreadRef(reservation.threadRef);
		if (route === undefined) return;
		await route.port
			.post(route.target, { text: `⚠️ ${outcome.text}` })
			.catch((error: unknown) =>
				this.#ctx.log.warn("lane_reservation_reply_failed", { reservation: action.id, error: String(error) }),
			);
	}
}

/** Each adapter takes only the deliveries whose thread ref is an id of its own platform. */
export function deliverySources(
	store: DaemonStore,
	config: JabbuConfig,
	crash: (point: CrashPoint) => void,
): (platform: ChatPlatform) => DeliverySource {
	const itemOf = (row: DeliveryRow): DeliveryItem => ({
		deliveryId: row.deliveryId,
		originKey: row.originKey,
		threadRef: row.threadRef,
		body: row.body,
		redelivered: row.redelivered,
		finishThreadRefs: store.threadsOfOp(row.originKey, row.opRef),
		// A `queue drop` and a `!stop` re-link their targets (the dropped row; the waiting rows and the stopped
		// turn's rows) to the command op: those threads end 🚫 취소됨, a `/new` keeps finishing its casualties ✅ 완료.
		cancelThreadRefs:
			row.opRef.startsWith("queue:") || row.opRef.startsWith("stop:")
				? store.discardedThreadsOfOp(row.originKey, row.opRef)
				: undefined,
		// A lane's own reports (no owner message behind them) must not stamp ✅ on its thread root, nor may a
		// `!restart` answer or an apply `notify` line (side posts in a thread whose turn may still run).
		finishUntracked:
			!isLaneOrigin(row.originKey) &&
			!isTaskOrigin(row.originKey) &&
			!row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) &&
			!row.opRef.endsWith(LOG_COPY_SUFFIX) &&
			!isSideOpRef(row.opRef),
		// Sent while its turn runs: the thread's ⏳ status and progress go on until the turn-end delivery. A peer
		// silence alert, a `!restart` answer and an apply `notify` line answer no turn, so they never finish the
		// thread's status either.
		keepStatus:
			row.opRef.includes(INTERIM_INFIX) ||
			row.opRef.startsWith(PEER_SILENCE_OP_PREFIX) ||
			row.opRef.startsWith(AMBIGUOUS_NOTICE_OP_PREFIX) ||
			isSideOpRef(row.opRef),
		sentParts: row.sentParts,
		replyTs: row.replyTs,
	});
	return (platform: ChatPlatform): DeliverySource => ({
		claimDue: () => store.claimDue(undefined, platform).map(itemOf),
		takeExpired: () => store.takeExpired(platform).map(itemOf),
		confirm: (deliveryId) => {
			crash("after_post_before_confirm");
			store.confirmDelivery(deliveryId);
		},
		fail: (deliveryId, error, outcome, sentParts, replyTs) => {
			if (outcome === "ambiguous") {
				// The parts already posted stay on the row: an owner `jabbu-pocket deliveries resend` sends only the rest.
				store.markAmbiguous(deliveryId, error, sentParts, replyTs);
				// One owner notice per held delivery, into the thread the answer was headed for (Cataly noticeHeld).
				store.noticeAmbiguous(deliveryId, config.channels.discord?.ownerUserId);
				return true;
			}
			return store.failDelivery(deliveryId, error).state === "expired";
		},
		defer: (deliveryId, error, retry) => void store.deferDelivery(deliveryId, error, retry),
	});
}
