import type { ChannelAdapter } from "../channel/adapter";
import type { ChannelRegistry } from "../channel/registry";
import { LANE_REVIEW_TIMEOUT_MS } from "../config";
import { parseThreadRef, platformOfThreadRef, TOP_LEVEL_TS } from "../core/normalize";
import type { OriginRouter } from "../core/origin";
import { type ChatPlatform, platformOfConversationId } from "../core/origin-key";
import type { MailboxClock } from "../core/types";
import type { LandLane } from "../lanes/land";
import type { LaneManager } from "../lanes/manager";
import type { Logger } from "../log";
import type { FreezeState } from "../ops/freeze";
import type { ApprovalBroker } from "../safety/approval";
import type { Store } from "../store/db";
import type { AutoLandPolicy } from "../tasks/auto-land-policy";
import type { TaskCheckRunner } from "../tasks/check-runner";
import type { TaskGateRunner } from "../tasks/gate";
import type { TaskSweeper } from "../tasks/sweeper";
import type { WikiNotes } from "../wiki/notes";
import type { DaemonStore } from "./daemon-store";
import type { DaemonOptions } from "./daemon-types";

/** Live state of one `Daemon` read via getters so reload updates apply immediately. */
export interface DaemonContext {
	readonly options: DaemonOptions;
	readonly clock: MailboxClock;
	readonly clockFormat: Intl.DateTimeFormat;
	readonly log: Logger;
	readonly channels: ChannelRegistry;
	readonly adapters: Map<ChatPlatform, ChannelAdapter>;
	readonly frozen: () => FreezeState | undefined;
	readonly store: DaemonStore | undefined;
	readonly router: OriginRouter | undefined;
	readonly lanes: LaneManager | undefined;
	readonly broker: ApprovalBroker | undefined;
	readonly wikiNotes: WikiNotes | undefined;
	readonly taskGates: TaskGateRunner | undefined;
	readonly lander: LandLane | undefined;
	readonly checkRunner: TaskCheckRunner | undefined;
	readonly taskSweeper: TaskSweeper | undefined;
	/** Starts one idle sweep now (a lane or [TASK] start was refused for sessions or memory); a sweep already running absorbs it. */
	readonly requestIdleSweep: () => void;
	readonly quotaRefusal?: (model: string | undefined) => string | undefined;
	readonly isQuotaHeld?: (originKey: string) => boolean;
}

/** The ledger of a started daemon; throws before `start()` opened it. */
export function startedStore(ctx: DaemonContext): Store {
	if (!ctx.store) throw new Error("daemon not started");
	return ctx.store;
}

/** The approval broker of a started daemon; throws before `start()` made it. */
export function approvalOf(ctx: DaemonContext): ApprovalBroker {
	if (ctx.broker === undefined) throw new Error("daemon not started");
	return ctx.broker;
}

/** The adapter of a thread ref's platform; none for an unbound platform or a malformed ref. */
export function adapterOfThread(ctx: DaemonContext, threadRef: string): ChannelAdapter | undefined {
	const platform = platformOfThreadRef(threadRef);
	return platform === undefined ? undefined : ctx.adapters.get(platform);
}

/** The adapter of a conversation id's platform; none for an unbound platform. */
export function adapterOfConversation(ctx: DaemonContext, conversationId: string): ChannelAdapter | undefined {
	const platform = platformOfConversationId(conversationId);
	return platform === undefined ? undefined : ctx.adapters.get(platform);
}

/**
 * The owner's notice conversation and the adapter that reaches it: `channels.discord.alertChannelId` when set and
 * Discord is bound, else `ownerHome()`. No home yet (the owner has not written anywhere) is logged as
 * `owner_notice_unroutable` with the notice that could not go out; a home on a platform without a bound adapter as
 * `owner_channel_unbound`.
 */
export function ownerTarget(
	ctx: DaemonContext,
	notice: string,
): { adapter: ChannelAdapter; channel: string } | undefined {
	const store = ctx.store;
	if (store === undefined) return undefined;
	const alertChannel = ctx.options.config.channels.discord?.alertChannelId;
	const discord = alertChannel === undefined ? undefined : ctx.adapters.get("discord");
	if (alertChannel !== undefined && discord !== undefined) return { adapter: discord, channel: alertChannel };
	const home = store.ownerHome();
	if (home === undefined) {
		ctx.log.warn("owner_notice_unroutable", { notice });
		return undefined;
	}
	const adapter = ctx.adapters.get(home.platform);
	if (adapter === undefined) {
		if (ctx.adapters.size > 0) ctx.log.warn("owner_channel_unbound", { channel: home.conversationId });
		return undefined;
	}
	return { adapter, channel: home.conversationId };
}

export function postThreadNotices(ctx: DaemonContext, threads: string[], text: string): void {
	for (const ref of threads) {
		const parsed = parseThreadRef(ref);
		const adapter = adapterOfThread(ctx, ref);
		if (parsed === undefined || adapter === undefined) continue;
		void adapter.postNotice(parsed.channel, text, parsed.threadTs === TOP_LEVEL_TS ? undefined : parsed.threadTs);
	}
}

export function dispatchPending(ctx: DaemonContext, originKey: string): void {
	const router = ctx.router;
	if (!router) return;
	router
		.mailbox(originKey)
		.resumePending()
		.catch((error: unknown) => ctx.log.error("dispatch_pending_failed", { origin: originKey, error: String(error) }));
}

/** `taskAutoLand` as the [TASK] sweep and the lanes apply it (`maxRisk` defaults to L2); `undefined` = off. */
export function autoLandPolicy(ctx: DaemonContext): AutoLandPolicy | undefined {
	const policy = ctx.options.config.taskAutoLand;
	if (policy === undefined) return undefined;
	const { review, qa } = policy;
	return {
		repos: policy.repos,
		maxRisk: policy.maxRisk ?? "L2",
		...(qa === undefined
			? {}
			: {
					qa: {
						minRisk: qa.minRisk ?? "L3",
						overlay: qa.overlay,
						model: qa.model,
						timeoutMs: qa.timeoutMs ?? LANE_REVIEW_TIMEOUT_MS,
					},
				}),
		...(review === undefined
			? {}
			: {
					review: {
						model: review.model,
						timeoutMs: review.timeoutMs ?? LANE_REVIEW_TIMEOUT_MS,
						...(review.confident === undefined ? {} : { confident: review.confident }),
					},
				}),
	};
}
