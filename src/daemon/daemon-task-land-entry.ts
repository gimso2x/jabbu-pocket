import type { IngestOutcome } from "../channel/types";
import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import type { TaskLandResult } from "../tasks/land";
import type { TaskRow } from "../tasks/ledger";
import { buildMergeSettledCard, type TaskCard } from "../tasks/notify";
import { isPrRetryable, prLandRetryCard } from "../tasks/pr-land-retry";
import { adapterOfConversation, type DaemonContext } from "./daemon-context";

/** What the landing entry needs from `DaemonTaskLanding`: its lock, readiness and landing body. */
export interface LandEntryHost {
	readonly ctx: DaemonContext;
	readonly taskLanding: Set<string>;
	landReady(): boolean;
	coreLand(row: TaskRow, mode: "button"): Promise<TaskLandResult>;
	releaseAfterTurn(taskId: string, channel: string, markerTs: string | undefined): void;
}

/** Who asked: `logKind` names the log events (`task_<logKind>_ignored`…), `marker` is the bot line of a handoff's "머지해". */
export interface LandEntryVia {
	logKind: string;
	marker: string;
	/** The landing lock is held and the core is about to land. */
	started?: (row: TaskRow) => Promise<void>;
	/** The core handed the landing to the model turn; "머지해" goes into the thread next. */
	handingOff?: (row: TaskRow, result: TaskLandResult) => Promise<void>;
}

export type LandEntryRefusal = "draining" | "not_found" | "wrong_status" | "bad_thread" | "in_flight";

export type LandEntryOutcome =
	| { kind: "refused"; reason: LandEntryRefusal; row?: TaskRow }
	/** `handoff`: only for a `handoff` result — whether "머지해" got into the thread. */
	| { kind: "landed"; row: TaskRow; result: TaskLandResult; handoff?: "requested" | "rejected" };

/** Card note of a landing request refused while the daemon drains for a restart. */
export const LAND_DRAINING_NOTE = "재시작 준비 중이라 착지를 받지 않음";

/** Feeds `text` as an owner message through the adapter's message path: the bot posts `marker` (in `threadTs`'s thread, or as a root) and the message takes its id; `posted.ts` is set once the marker is up. */
export async function ingestOwnerText(
	ctx: DaemonContext,
	/** `injected`: put in by `jabbu-pocket inject`, not by an owner click (`OwnerIngest.injected`). */
	target: { channel: string; threadTs?: string | undefined; kind: "dm" | "ch"; injected?: boolean },
	text: string,
	marker: string,
	quoted?: readonly string[],
	posted: { ts?: string } = {},
): Promise<{ outcome: IngestOutcome; markerTs: string }> {
	const { channel, threadTs, kind, injected } = target;
	const adapter = adapterOfConversation(ctx, channel);
	const route = ctx.channels.forConversation(channel);
	if (adapter === undefined || route === undefined) throw new Error("daemon not started");
	const { messageId } = await route.port.post(
		{ conversationId: channel, ...(threadTs === undefined ? {} : { threadId: threadTs }) },
		{ text: marker },
	);
	posted.ts = messageId;
	// A reply in an approval card's thread settles the card without an inbound row, so acceptance comes from the
	// adapter's own verdict, not from the ledger.
	const outcome = await adapter.ingestOwner({
		conversationId: channel,
		kind,
		threadId: threadTs,
		messageId,
		text,
		quoted,
		...(injected === true ? { injected } : {}),
	});
	return { outcome, markerTs: messageId };
}

/** Puts `ownerText` into the task thread as an owner message (after the bot's `marker`); false when it did not get in. Failures are logged as `task_<kind>_inject_rejected`. */
export async function answerInThread(
	ctx: DaemonContext,
	kind: string,
	taskId: string,
	thread: { channel: string; threadTs: string },
	ownerText: string,
	marker: string,
): Promise<{ accepted: boolean; markerTs: string | undefined }> {
	const posted: { ts?: string } = {};
	try {
		const { outcome } = await ingestOwnerText(
			ctx,
			{ channel: thread.channel, threadTs: thread.threadTs, kind: "ch" },
			ownerText,
			marker,
			undefined,
			posted,
		);
		if (outcome !== "dropped" && outcome !== "card_rejected") {
			ctx.log.info(`task_${kind}_requested`, { task: taskId, marker: posted.ts, outcome });
			return { accepted: true, markerTs: posted.ts };
		}
		ctx.log.warn(`task_${kind}_inject_rejected`, { task: taskId, reason: "dropped", marker: posted.ts });
	} catch (error) {
		ctx.log.warn(`task_${kind}_inject_rejected`, {
			task: taskId,
			reason: "error",
			...(posted.ts === undefined ? {} : { marker: posted.ts }),
			error: String(error),
		});
	}
	return { accepted: false, markerTs: posted.ts };
}

/** The card of a finished landing that is not a handoff: settled, or with the retry button when a PR landing stopped again. */
export function landResultCard(ctx: DaemonContext, row: TaskRow, result: TaskLandResult, note: string): TaskCard {
	const retry = result.state === "blocked" && isPrRetryable(ctx.store?.tasks.get(row.taskId));
	return (retry ? prLandRetryCard : buildMergeSettledCard)(row, note);
}

/**
 * The one landing entry of a task in review, shared by the `머지` button and `tasks land`: refuse while draining, stop a running
 * gate, read the task again (the wait can change its status or start a drain), take the landing lock, land through the core and,
 * on a handoff, answer "머지해" in the thread (the lock then waits for that turn).
 */
export async function landReviewed(host: LandEntryHost, taskId: string, via: LandEntryVia): Promise<LandEntryOutcome> {
	const { ctx } = host;
	const log = ctx.log;
	const refuse = (reason: LandEntryRefusal, row?: TaskRow): LandEntryOutcome => {
		log.info(`task_${via.logKind}_ignored`, { task: taskId, reason: reason === "wrong_status" ? row?.status : reason });
		return { kind: "refused", reason, ...(row === undefined ? {} : { row }) };
	};
	if (!host.landReady()) return refuse("draining");
	const first = ctx.store?.tasks.get(taskId);
	if (first === undefined) return refuse("not_found");
	if (first.status !== "review") return refuse("wrong_status", first);
	const thread = parseThreadRef(first.threadRef);
	if (thread === undefined || thread.threadTs === TOP_LEVEL_TS) {
		log.warn(`task_${via.logKind}_inject_rejected`, { task: taskId, reason: "bad_thread", thread: first.threadRef });
		return { kind: "refused", reason: "bad_thread", row: first };
	}
	// The owner's landing goes without the gate: a running one is aborted (no receipt) and waited for first.
	await ctx.taskGates?.abort(taskId);
	const row = ctx.store?.tasks.get(taskId);
	if (row === undefined) return refuse("not_found");
	if (row.status !== "review") return refuse("wrong_status", row);
	if (!host.landReady()) return refuse("draining", row);
	if (host.taskLanding.has(taskId)) return refuse("in_flight", row);
	host.taskLanding.add(taskId);
	let handedOff = false;
	try {
		await via.started?.(row);
		const result = await host.coreLand(row, "button");
		if (result.state !== "handoff") return { kind: "landed", row, result };
		await via.handingOff?.(row, result);
		const answered = await answerInThread(ctx, via.logKind, taskId, thread, "머지해", via.marker);
		if (!answered.accepted) return { kind: "landed", row, result, handoff: "rejected" };
		handedOff = true;
		host.releaseAfterTurn(taskId, thread.channel, answered.markerTs);
		return { kind: "landed", row, result, handoff: "requested" };
	} finally {
		if (!handedOff) host.taskLanding.delete(taskId);
	}
}
