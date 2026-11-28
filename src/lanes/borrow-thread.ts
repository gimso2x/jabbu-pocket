import type { ChannelPort, MessageRef } from "../channel/port";
import { parseThreadRef, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { GRAMMAR, parseChatOrigin } from "../core/origin-key";
import type { Logger } from "../log";
import type { Store } from "../store/db";
import type { LaneRow } from "./status";
import { type ClosedLaneMessage, classifyClosedLaneMessage } from "./trigger";

export interface BorrowThreadRequest {
	threadId: string;
	/** True for a channel-body root message (e.g. `inlineReplyChannels`) that has no Discord thread yet. */
	openThread?: true;
}

/** The `borrowThread` start argument for a lane started from `originKey`: its thread, or an inline message ref. */
export function borrowThreadOf(originKey: string, inlineThreadRef?: string): { borrowThread?: BorrowThreadRequest } {
	const origin = parseChatOrigin(originKey);
	if (origin?.threadId !== undefined) return { borrowThread: { threadId: origin.threadId } };
	if (origin?.platform !== "discord" || origin.kind !== "ch" || inlineThreadRef === undefined) return {};
	const parsed = parseThreadRef(inlineThreadRef);
	if (parsed === undefined || parsed.channel !== origin.conversationId) return {};
	if (parsed.threadTs === TOP_LEVEL_TS || !GRAMMAR.discord.thread.test(parsed.threadTs)) return {};
	return { borrowThread: { threadId: parsed.threadTs, openThread: true } };
}

type StartedLane = LaneRow & { reused?: boolean; startNote?: string };

/** True when `lane` borrowed `borrow`'s own thread in `channel` (a reuse from another inline message gets the link). */
export function isBorrowedInPlace(
	lane: Pick<LaneRow, "threadRef" | "meta">,
	borrow: BorrowThreadRequest | undefined,
	channel: string,
): boolean {
	return (
		lane.meta.borrowedThread === true &&
		borrow !== undefined &&
		lane.threadRef === threadRefOf(channel, borrow.threadId)
	);
}

/** `jabbu_work_start`'s answer for a started (or reused) lane; `link`: its own thread's link, if any. */
export function startToolReply(
	lane: StartedLane,
	link: string | undefined,
	inPlace = lane.meta.borrowedThread === true,
): string {
	const where = `(thread ${lane.threadRef}, origin ${lane.originKey})`;
	if (inPlace) return borrowedStartReply(lane, "", ` ${where}; tell the owner exactly this, without a link`);
	const state = lane.reused === true ? "already open for this request" : "started";
	const started = `lane ${lane.name} ${state} ${where}`;
	const reply = link === undefined ? started : `${started}; tell the owner the lane thread link: ${link}`;
	return lane.startNote === undefined ? reply : `${reply}\n${lane.startNote}`;
}

/** What a start that borrowed its conversation's thread says there (no link: the lane is in this very thread). */
function borrowedStartReply(lane: StartedLane, prefix = "", detail = ""): string {
	const said =
		lane.reused === true
			? `이 스레드의 레인 \`${lane.name}\`이 이미 열려 있어 새로 만들지 않았습니다`
			: `이 스레드에서 레인 \`${lane.name}\`을 시작했습니다`;
	return `${prefix}${said}${detail}${lane.startNote === undefined ? "" : `\n${lane.startNote}`}`;
}

/** The answer to a `작업:` line whose lane has a thread of its own (`link`: that thread's link, if the adapter has one). */
function chatStartReply(lane: StartedLane, link: string | undefined): string {
	if (lane.reused === true) {
		return `↪ 같은 작업 레인 \`${lane.name}\`이 이미 열려 있어 새로 만들지 않았습니다${link === undefined ? "" : `: ${link}`}`;
	}
	const reply =
		link === undefined
			? `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 새 스레드에서 진행 상황을 확인하세요.`
			: `🔄 작업 레인 \`${lane.name}\`을 시작했습니다. 레인 스레드에서 진행 상황을 확인하세요: ${link}`;
	return lane.startNote === undefined ? reply : `${reply}\n${lane.startNote}`;
}

/** The `작업:` answer for `rowThreadRef`: in-place text when the lane borrowed this message's thread, else with link. */
export async function chatStartReplyFor(
	lane: StartedLane,
	rowThreadRef: string,
	linkOf: () => Promise<string | undefined>,
): Promise<string> {
	if (lane.meta.borrowedThread === true && lane.threadRef === rowThreadRef) {
		return borrowedStartReply(lane, lane.reused === true ? "↪ " : "🔄 ");
	}
	return chatStartReply(lane, await linkOf());
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
 * The conversation thread (or inline root message) a lane start may borrow instead of opening a sibling: `parentOrigin`'s
 * thread or Discord channel-body message in `input.channel`, free in `inFlight` and `lanes`. Claimed synchronously into
 * `inFlight`; the caller releases it when the start ends.
 */
export function claimBorrowedThread(
	input: { channel: string; parentOrigin?: string; borrowThread?: BorrowThreadRequest },
	inFlight: Set<string>,
	store: Pick<Store, "getLaneByThread">,
): { threadId: string; threadRef: string; openThread: boolean } | undefined {
	const threadId = input.borrowThread?.threadId;
	const openThread = input.borrowThread?.openThread === true;
	if (threadId === undefined || input.parentOrigin === undefined) return undefined;
	const origin = parseChatOrigin(input.parentOrigin);
	if (origin?.kind !== "ch" || origin.conversationId !== input.channel) return undefined;
	if (origin.threadId !== undefined) {
		if (origin.threadId !== threadId || openThread) return undefined;
	} else if (origin.platform !== "discord" || !openThread || !GRAMMAR.discord.thread.test(threadId)) {
		return undefined;
	}
	const threadRef = threadRefOf(input.channel, threadId);
	if (inFlight.has(threadRef) || store.getLaneByThread(threadRef) !== undefined) return undefined;
	inFlight.add(threadRef);
	return { threadId, threadRef, openThread };
}

/**
 * Opens (or reuses) the lane's thread in `input.channel`: borrows an existing thread or opens one on the owner's inline
 * root message when `borrowed` is set, otherwise posts a `🔄` root message and opens a thread from it.
 */
export async function openLaneThread(
	port: Pick<ChannelPort, "platform" | "post" | "openThread">,
	input: { channel: string; title: string; shown: string },
	borrowed: { threadId: string; openThread: boolean } | undefined,
	onRoot: (ref: MessageRef) => void,
	onThreadOpened: () => void,
): Promise<string> {
	if (borrowed !== undefined) {
		if (borrowed.openThread && port.openThread !== undefined) {
			await port.openThread(
				{ platform: port.platform, conversationId: input.channel, messageId: borrowed.threadId },
				input.title,
			);
		}
		return borrowed.threadId;
	}
	const root = await port.post({ conversationId: input.channel }, { text: `🔄 ${input.shown}` });
	const rootRef: MessageRef = { platform: port.platform, conversationId: input.channel, messageId: root.messageId };
	onRoot(rootRef);
	if (port.openThread !== undefined) {
		await port.openThread(rootRef, input.title);
		onThreadOpened();
	}
	return root.messageId;
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
