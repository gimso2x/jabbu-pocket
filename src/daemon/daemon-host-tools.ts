import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseThreadRef, platformOfThreadRef } from "../core/normalize";
import { parseChatOrigin } from "../core/origin-key";
import { buildBoardTools } from "../lanes/board";
import { isLaneOrigin, isTaskOrigin } from "../lanes/status";
import { buildLaneTools, buildWorkStartTool } from "../lanes/tools";
import { buildMonitorTools, isPersonaOrigin } from "../monitors/tools";
import type { OmpDialogAnswerer } from "../omp/driver";
import { diskHeadroom, resolvedCeiling } from "../ops/host-resources";
import { answerDialog } from "../safety/choice";
import { buildHostTools, type HostToolDef, PEER_TOOL_DENIED } from "../safety/host-tools";
import type { FloorsSurface } from "../safety/prompt";
import type { HerdrPromptInput } from "../store/db-rows";
import { offsetLabel } from "../time";
import { approvalOf, type DaemonContext } from "./daemon-context";
import { taskMailboxPort, taskOfOrigin } from "./daemon-task-resume";
import { laneChannelOf, uploadThreadTs } from "./thread-target";

/** Longest wait for the recorded deliveries before a dialog card goes out anyway. */
const DIALOG_FLUSH_MS = 10_000;

/**
 * A peer bot has written in this origin: a child started from now on gets the reduced host tool set (and is told so);
 * a running child keeps its list, and `hostToolsFor`'s call-time guard reads this at every call. Read from the ledger.
 */
export function peerTouched(ctx: DaemonContext, originKey: string): boolean {
	return ctx.store?.originHasPeerInbound(originKey) === true;
}

/**
 * What the floors prompt of `originKey` must know beyond the key: a lane session's thread platform (its upload
 * tool), whether a Discord DM is without lanes for want of `channels.discord.laneChannelId`, and the peer bots of a
 * chat origin's platform with their mention tokens.
 */
export function floorsSurfaceFor(ctx: DaemonContext, originKey: string): FloorsSurface {
	const lane = isLaneOrigin(originKey) ? ctx.store?.getLaneByOrigin(originKey) : undefined;
	const lanePlatform = lane === undefined ? undefined : platformOfThreadRef(lane.threadRef);
	if (lanePlatform !== undefined) return { lanePlatform, laneCwd: cwdFor(ctx, originKey) };
	// A persona session's monitor line quotes the bot's zone and the offset in force when it starts.
	const timezone = isPersonaOrigin(originKey)
		? {
				timezone: {
					name: ctx.options.config.timezone,
					offset: offsetLabel(ctx.clock.now(), ctx.options.config.timezone),
				},
			}
		: {};
	const ref = parseChatOrigin(originKey);
	const noLaneChannel =
		ref?.platform === "discord" &&
		ctx.lanes !== undefined &&
		isPersonaOrigin(originKey) &&
		laneChannelOf(ctx, originKey, ref.conversationId) === undefined &&
		!peerTouched(ctx, originKey);
	// The peer bots of the conversation's platform in its mention syntax (Discord's `channels.discord.peerBots`; none elsewhere).
	const { config } = ctx.options;
	const peerBots = ref?.platform === "discord" ? config.channels.discord?.peerBots : undefined;
	const port = ctx.options.channels.find((binding) => binding.port.platform === ref?.platform)?.port;
	const peers =
		peerBots === undefined || peerBots.length === 0 || port === undefined
			? {}
			: { peers: peerBots.map((peer) => ({ name: peer.name, mention: port.mentionUser(peer.userId) })) };
	return noLaneChannel ? { noLaneChannel, ...timezone, ...peers } : { ...timezone, ...peers };
}

/**
 * Host tools for the omp child of `originKey`, fixed for the child's life. A child started after a peer bot wrote
 * here gets the reduced set. A child started before keeps the full set (no restart, no prompt-cache rewrite), and
 * every tool missing from the reduced set re-reads the ledger when it runs: once a peer row exists it throws
 * instead of running. Each call runs inside the origin's mailbox: no stall alert while the child waits on the host
 * (an approval click can take minutes), and `drain` counts it as unfinished work.
 */
export function hostToolsFor(ctx: DaemonContext, originKey: string): HostToolDef[] {
	if (isTaskOrigin(originKey)) return []; // a [TASK] worker has no jabbu tools: its board is PROGRESS.md
	const reduced = hostToolSet(ctx, originKey, true);
	const allowed = new Set(reduced.map((tool) => tool.name));
	const tools = peerTouched(ctx, originKey)
		? reduced
		: hostToolSet(ctx, originKey, false).map((tool) =>
				allowed.has(tool.name) ? tool : peerGuarded(ctx, originKey, tool),
			);
	return tools.map((tool) => ({
		...tool,
		execute: (params, context) => {
			const mailbox = ctx.router?.mailbox(originKey);
			return mailbox ? mailbox.trackHostTool(() => tool.execute(params, context)) : tool.execute(params, context);
		},
	}));
}

/** `tool` refused at call time once a peer bot has written in `originKey`; the ledger is read at every call. */
function peerGuarded(ctx: DaemonContext, originKey: string, tool: HostToolDef): HostToolDef {
	return {
		...tool,
		execute: async (params, context) => {
			if (peerTouched(ctx, originKey)) {
				ctx.log.warn("host_tool_denied_peer", { origin: originKey, tool: tool.name });
				throw new Error(PEER_TOOL_DENIED);
			}
			return tool.execute(params, context);
		},
	};
}

/**
 * The host tool set of `originKey` with (`peerTouched`) or without a peer bot in the conversation; `hostToolsFor`
 * builds both from here so the guarded difference follows any tool added later.
 */
function hostToolSet(ctx: DaemonContext, originKey: string, peerTouched: boolean): HostToolDef[] {
	const { config } = ctx.options;
	const lane = isLaneOrigin(originKey) ? ctx.store?.getLaneByOrigin(originKey) : undefined;
	const chatOrigin = parseChatOrigin(originKey);
	const channel = lane ? parseThreadRef(lane.threadRef)?.channel : chatOrigin?.conversationId;
	// With a peer bot in the conversation only file upload, approval and dispatch remain (no lane or monitor tools).
	const base = buildHostTools({
		originKey,
		channels: ctx.channels,
		broker: approvalOf(ctx),
		log: ctx.log,
		homeDir: config.homeDir,
		workspaceDir: config.workspaceDir,
		...(chatOrigin !== undefined ? { ompExecutable: config.ompExecutable } : {}),
		...(config.ompProfile === undefined ? {} : { ompProfile: config.ompProfile }),
		...(config.ompConfigOverlay === undefined ? {} : { ompConfigOverlay: config.ompConfigOverlay }),
		...(channel === undefined ? {} : { channel }),
		dispatchHosts: () => ctx.options.config.dispatchHosts,
		...(config.workerOmpArgs === undefined ? {} : { workerOmpArgs: config.workerOmpArgs }),
		// A live setting like the lane manager's: each new [TASK] reads the config the last reload left.
		laneModels: () => ctx.options.config.lanes?.models,
		workerAgy: () => ctx.options.config.workerAgy,
		...(config.herdrBoard === undefined ? {} : { herdrBoard: config.herdrBoard }),
		...(config.herdr === undefined ? {} : { herdr: config.herdr }),
		frozen: ctx.frozen,
		...(ctx.store === undefined
			? {}
			: {
					tasks: {
						ledger: ctx.store.tasks,
						threadRef: () =>
							ctx.router?.mailbox(originKey).state.threadRef ?? ctx.store?.latestInboundThread(originKey),
						rootText: (threadRef: string) => ctx.store?.getInbound(threadRef)?.textRef,
						channels: ctx.channels,
						headless: taskMailboxPort(ctx),
						now: () => ctx.clock.now(),
						timezone: config.timezone,
						...(config.recordsRepo === undefined ? {} : { recordsRepo: config.recordsRepo }),
						...(ctx.options.statfs === undefined
							? {}
							: { diskHeadroom: (path: string) => diskHeadroom(path, ctx.options.statfs) }),
						...(ctx.options.hostLoad === undefined ? {} : { hostLoad: ctx.options.hostLoad }),
						hostSessions: {
							ceiling: resolvedCeiling(ctx.options.config.hostSessionCeiling),
							onPressure: () => ctx.requestIdleSweep(),
						},
					},
					recordPrompt: (input: HerdrPromptInput) => ctx.store?.recordHerdrPrompt(input),
				}),
		// Resolved when the tool runs: the upload thread follows the origin's current conversation, not driver start.
		threadTs: () => uploadThreadTs(ctx, originKey, lane?.threadRef),
	});
	const lanes = ctx.lanes;
	const store = ctx.store;
	const monitorTools = store
		? buildMonitorTools({
				originKey,
				ledger: store.monitors,
				scriptsRoot: join(config.homeDir, "scripts"),
				watcherRoots: config.watcherRoots,
				workspaceDir: config.workspaceDir,
				webhook: config.webhook,
				timezone: config.timezone,
				now: () => ctx.clock.now(),
				log: ctx.log,
			})
		: [];
	// Discord conversations get monitors (and lanes where a lane can open); another platform's the base set.
	const otherPlatform = chatOrigin !== undefined && chatOrigin.platform !== "discord";
	const laneChannel = laneChannelOf(ctx, originKey, channel);
	const boardTools = store && (lane || chatOrigin) ? buildBoardTools(store, originKey) : [];
	return peerTouched || otherPlatform
		? base
		: !lanes
			? [...base, ...monitorTools, ...boardTools]
			: lane
				? [...base, ...buildLaneTools(lanes, originKey), ...boardTools]
				: channel === undefined
					? base
					: laneChannel === undefined
						? [...base, ...monitorTools, ...boardTools]
						: [...base, buildWorkStartTool(lanes, laneChannel, originKey), ...monitorTools, ...boardTools];
}

/**
 * Owner answers to the omp child's dialogs (select/confirm/input/editor/ask) as choice cards in the thread of the
 * origin's running turn. Undefined when the origin has no chat channel (monitors) — the driver then cancels them.
 * `flush` first sends the recorded deliveries (the text next to the `ask` call is an interim one), so the card lands
 * below that text; a flush slower than {@link DIALOG_FLUSH_MS} does not hold the card back.
 */
export function answerDialogsFor(
	ctx: DaemonContext,
	originKey: string,
	flush: () => Promise<void>,
): OmpDialogAnswerer | undefined {
	const lane = isLaneOrigin(originKey) ? ctx.store?.getLaneByOrigin(originKey) : undefined;
	const channel = lane ? parseThreadRef(lane.threadRef)?.channel : parseChatOrigin(originKey)?.conversationId;
	if (channel === undefined) return undefined;
	return (request, signal) => {
		const threadTs = uploadThreadTs(ctx, originKey, lane?.threadRef);
		const mailbox = ctx.router?.mailbox(originKey);
		const opRef = mailbox?.turnOpRef;
		const ask = async () => {
			const late = Promise.withResolvers<"late">();
			const timer = setTimeout(() => late.resolve("late"), DIALOG_FLUSH_MS);
			const flushed = await Promise.race([flush(), late.promise]);
			clearTimeout(timer);
			if (flushed === "late") ctx.log.warn("dialog_flush_late", { origin: originKey, ms: DIALOG_FLUSH_MS });
			return answerDialog(
				approvalOf(ctx),
				{
					originKey,
					channel,
					...(threadTs === undefined ? {} : { threadTs }),
					...(opRef === undefined ? {} : { opRef }),
				},
				request,
				signal,
			);
		};
		// Like host tools: the owner can take minutes, so stall alerts rest and `drain` counts the wait.
		return mailbox ? mailbox.trackHostTool(ask) : ask();
	};
}

/** Working directory of the omp child: a [TASK] worker's worktree, the project of a work lane, the bot workspace otherwise. */
export function cwdFor(ctx: DaemonContext, originKey: string): string {
	const task = taskOfOrigin(ctx.store?.tasks, originKey);
	if (task !== undefined) return task.worktree;
	const lane = isLaneOrigin(originKey) ? ctx.store?.getLaneByOrigin(originKey) : undefined;
	if (lane === undefined) return ctx.options.config.workspaceDir;
	if (existsSync(lane.cwd)) return lane.cwd;
	// An open lane without its worktree was damaged by hand: the live checkout must not be changed, so the child is refused.
	if (lane.status !== "closed") throw new Error(`lane_worktree_missing: ${lane.name} ${lane.cwd}`);
	// A landed or discarded lane has no worktree: its session answers later questions from the repository it was merged into.
	return lane.meta.repo ?? ctx.options.config.workspaceDir;
}
