import type { ChannelPort, MessageRef } from "../channel/port";
import { threadRefOf } from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import type { Logger } from "../log";
import type { Store } from "../store/db";
import type { LaneRow } from "./status";
import { type ClosedLaneMessage, classifyClosedLaneMessage } from "./trigger";

/** The `borrowThread` start argument for a lane started from `originKey`: its own conversation thread, if any. */
export function borrowThreadOf(originKey: string): { borrowThread?: { threadId: string } } {
	const threadId = parseChatOrigin(originKey)?.threadId;
	return threadId === undefined ? {} : { borrowThread: { threadId } };
}

type StartedLane = LaneRow & { reused?: boolean; startNote?: string };

/** `jabbu_work_start`'s answer for a started (or reused) lane; `link`: its own thread's link, if any. */
export function startToolReply(lane: StartedLane, link: string | undefined): string {
	const where = `(thread ${lane.threadRef}, origin ${lane.originKey})`;
	if (lane.meta.borrowedThread === true)
		return borrowedStartReply(lane, "", ` ${where}; tell the owner exactly this, without a link`);
	const state = lane.reused === true ? "already open for this request" : "started";
	const started = `lane ${lane.name} ${state} ${where}`;
	const reply = link === undefined ? started : `${started}; tell the owner the lane thread link: ${link}`;
	return lane.startNote === undefined ? reply : `${reply}\n${lane.startNote}`;
}

/** What a start that borrowed its conversation's thread says there (no link: the lane is in this very thread). */
export function borrowedStartReply(lane: StartedLane, prefix = "", detail = ""): string {
	const said =
		lane.reused === true
			? `이 스레드의 레인 \`${lane.name}\`이 이미 열려 있어 새로 만들지 않았습니다`
			: `이 스레드에서 레인 \`${lane.name}\`을 시작했습니다`;
	return `${prefix}${said}${detail}${lane.startNote === undefined ? "" : `\n${lane.startNote}`}`;
}

/**
 * The lane an owner message in `threadLane`'s thread belongs to, and how a closed lane reads it (`closedAs`). A
 * borrowed thread is the conversation's again once its lane closed: only `!reopen`, and while its landing waits
 * `머지해`/`폐기해`/`!pr`, still reach the lane; anything else there is a conversation message (no lane, no `closedAs`).
 */
export function inboundLane(
	threadLane: LaneRow | undefined,
	text: string,
): { lane: LaneRow | undefined; closedAs: ClosedLaneMessage | undefined } {
	const land = threadLane?.meta.land?.state;
	const closedAs = threadLane?.status === "closed" ? classifyClosedLaneMessage(text, land) : undefined;
	if (threadLane?.meta.borrowedThread !== true || closedAs === undefined || closedAs === "reopen")
		return { lane: threadLane, closedAs };
	const waiting = land === "pending" || land === "blocked";
	const own = waiting && (closedAs === "land" || closedAs === "discard" || closedAs === "pr");
	return own ? { lane: threadLane, closedAs } : { lane: undefined, closedAs: undefined };
}

/**
 * The conversation thread a lane start may borrow instead of opening a sibling (`borrowThread`): `parentOrigin`'s own
 * thread in `input.channel`, never used by any lane row (the thread ref is unique) and not `inFlight` (borrowed by
 * another start). Claimed into `inFlight` here, synchronously: of two starts borrowing one thread, the second opens a
 * sibling. The caller releases it when its start ends.
 */
export function claimBorrowedThread(
	input: { channel: string; parentOrigin?: string; borrowThread?: { threadId: string } },
	inFlight: Set<string>,
	store: Pick<Store, "getLaneByThread">,
): { threadId: string; threadRef: string } | undefined {
	const threadId = input.borrowThread?.threadId;
	if (threadId === undefined || input.parentOrigin === undefined) return undefined;
	const origin = parseChatOrigin(input.parentOrigin);
	if (origin?.kind !== "ch" || origin.conversationId !== input.channel || origin.threadId !== threadId)
		return undefined;
	const threadRef = threadRefOf(input.channel, threadId);
	if (inFlight.has(threadRef) || store.getLaneByThread(threadRef) !== undefined) return undefined;
	inFlight.add(threadRef);
	return { threadId, threadRef };
}

/** A borrowed start failed after its status was posted: the status becomes ❌ (no button); a new ❌ only if that fails. */
export async function failBorrowedStatus(
	port: Pick<ChannelPort, "edit" | "post">,
	log: Logger,
	statusRef: MessageRef,
	shown: string,
): Promise<void> {
	const channel = statusRef.conversationId;
	try {
		await port.edit(statusRef, { text: `❌ ${shown}`, buttons: [] });
	} catch (editError) {
		log.warn("lane_status_edit_failed", { channel, error: String(editError) });
		await port
			.post({ conversationId: channel, threadId: statusRef.threadId }, { text: `❌ ${shown}` })
			.catch((postError: unknown) => log.warn("lane_thread_post_failed", { channel, error: String(postError) }));
	}
}
