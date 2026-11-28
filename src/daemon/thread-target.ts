import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import type { DaemonContext } from "./daemon-context";

/** Refusal message when `작업:` lane creation is triggered from a web conversation. */
export const WEB_LANE_REFUSED = "레인은 디스코드 스레드에서 시작할 수 있습니다.";

/**
 * Where a lane asked for from `originKey` opens: its own conversation (`channel`), except that a Discord DM, which
 * has no threads, opens it in `channels.discord.laneChannelId`; web conversations return `undefined`.
 */
export function laneChannelOf(ctx: DaemonContext, originKey: string, channel: string | undefined): string | undefined {
	const ref = parseChatOrigin(originKey);
	if (ref?.platform === "web") return undefined;
	return ref?.platform === "discord" && ref.kind === "dm"
		? ctx.options.config.channels.discord?.laneChannelId
		: channel;
}

/**
 * Where an uploaded file (or a dialog card) lands: the lane's own thread, else the thread of the origin's running
 * turn (the newest inbound may already be a steered message of another thread), else the origin's newest inbound
 * thread. Undefined → the channel's main view (the previous behaviour).
 */
export function uploadThreadTs(
	ctx: DaemonContext,
	originKey: string,
	laneThreadRef: string | undefined,
): string | undefined {
	const turnRef = ctx.router?.mailbox(originKey).state.threadRef;
	const ref = laneThreadRef ?? turnRef ?? ctx.store?.latestInboundThread(originKey);
	const parsed = ref === undefined ? undefined : parseThreadRef(ref);
	return parsed !== undefined && parsed.threadTs !== TOP_LEVEL_TS ? parsed.threadTs : undefined;
}

/**
 * Owner message thread ref (`<channel>:<messageId>`) an inline-reply channel lane start may open a thread on and
 * borrow; `undefined` outside `channels.discord.inlineReplyChannels` or without a message id.
 */
export function inlineBorrowThreadRef(
	ctx: DaemonContext,
	originKey: string,
	explicitThreadRef?: string,
): string | undefined {
	const origin = parseChatOrigin(originKey);
	if (origin?.platform !== "discord" || origin.kind !== "ch" || origin.threadId !== undefined) return undefined;
	if (!ctx.options.config.channels.discord?.inlineReplyChannels?.includes(origin.conversationId)) return undefined;
	return (
		explicitThreadRef ?? ctx.router?.mailbox(originKey).state.threadRef ?? ctx.store?.latestInboundThread(originKey)
	);
}
