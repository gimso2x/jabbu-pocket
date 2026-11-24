import { parseThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import type { DaemonContext } from "./daemon-context";

/**
 * Where a lane asked for from `originKey` opens: its own conversation (`channel`), except that a Discord DM, which
 * has no threads, opens it in `channels.discord.laneChannelId`; `undefined` when there is none.
 */
export function laneChannelOf(ctx: DaemonContext, originKey: string, channel: string | undefined): string | undefined {
	const ref = parseChatOrigin(originKey);
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
