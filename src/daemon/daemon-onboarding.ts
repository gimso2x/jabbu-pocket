import { join } from "node:path";
import { parseChatOrigin } from "../core/origin-key";
import { ONBOARDING_DENIED_TOOLS } from "../onboarding/guard";
import { ONBOARDING_TOOL_DENIED, onboardingPromptLine, onboardingRunning, readState } from "../onboarding/state";
import { buildOnboardingTool } from "../onboarding/tools";
import type { HostToolDef } from "../safety/host-tools";
import type { FloorsSurface } from "../safety/prompt";
import type { DaemonContext } from "./daemon-context";

/** The owner notes file the daemon injects (`personaFiles.owner`); the first-run test and `finish` use this path. */
const ownerNotesPath = (ctx: DaemonContext): string => join(ctx.options.config.homeDir, "workspace", "owner.md");

/**
 * Whether the child of `originKey` is offered the onboarding line and tool: an omp bot's chat origin (DM, channel,
 * thread) that no peer bot has written in. Lanes, monitors and [TASK] workers are not chat origins.
 */
function onboardingApplies(ctx: DaemonContext, originKey: string, peerTouched: boolean): boolean {
	return (
		ctx.store !== undefined &&
		!peerTouched &&
		ctx.options.config.agent !== "agy" &&
		parseChatOrigin(originKey) !== undefined
	);
}

/** The stored state, its unreadable case logged. */
function stateOf(ctx: DaemonContext, store: NonNullable<DaemonContext["store"]>) {
	return readState(store, () => ctx.log.warn("onboarding_state_unreadable", {}));
}

/** The floors surface's onboarding line for the stored state (none outside onboarding). */
export function onboardingSurface(ctx: DaemonContext, originKey: string): FloorsSurface {
	const peerTouched = ctx.store?.originHasPeerInbound(originKey) === true;
	if (ctx.store === undefined || !onboardingApplies(ctx, originKey, peerTouched)) return {};
	const onboarding = onboardingPromptLine(stateOf(ctx, ctx.store), ownerNotesPath(ctx));
	return onboarding === undefined ? {} : { onboarding };
}

/**
 * `tools` of `originKey` with the posting and work-starting ones refused at call time while onboarding runs (or its
 * state is unreadable; read at every call), plus `jabbu_onboarding` where it applies.
 */
export function withOnboarding(
	ctx: DaemonContext,
	originKey: string,
	peerTouched: boolean,
	tools: HostToolDef[],
): HostToolDef[] {
	const store = ctx.store;
	if (store === undefined) return tools;
	const own = onboardingApplies(ctx, originKey, peerTouched)
		? [
				buildOnboardingTool({
					originKey,
					store,
					notesPath: ownerNotesPath(ctx),
					timezone: ctx.options.config.timezone,
					now: () => ctx.clock.now(),
					log: ctx.log,
				}),
			]
		: [];
	const guarded = tools.map((tool) =>
		ONBOARDING_DENIED_TOOLS.has(tool.name)
			? {
					...tool,
					execute: async (params: Record<string, unknown>, context: { signal: AbortSignal }) => {
						if (onboardingRunning(stateOf(ctx, store))) {
							ctx.log.warn("host_tool_denied_onboarding", { origin: originKey, tool: tool.name });
							throw new Error(ONBOARDING_TOOL_DENIED);
						}
						return tool.execute(params, context);
					},
				}
			: tool,
	);
	return [...guarded, ...own];
}
