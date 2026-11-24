import { readAutoLandHold } from "../ops/apply";
import type { TaskLandOutcome } from "../tasks/land";
import { hostOpsOf, repoMatchesTask } from "../tasks/land-remote";
import type { TaskRow } from "../tasks/ledger";
import { PrLandRetry, postPrLandStop } from "../tasks/pr-land-retry";
import { landsViaPr } from "../tasks/pr-land-task";
import { autoLandPolicy, type DaemonContext } from "./daemon-context";

/** The retry of a `blocked` PR landing, wired to the daemon: its live config, freeze, landing readiness and `autoLand`. */
export function createPrLandRetry(
	ctx: DaemonContext,
	ready: () => boolean,
	autoLand: (row: TaskRow) => Promise<TaskLandOutcome>,
): PrLandRetry {
	const config = () => ctx.options.config;
	return new PrLandRetry({
		policy: () => autoLandPolicy(ctx),
		hold: () => readAutoLandHold(config().homeDir),
		frozen: () => ctx.frozen() !== undefined,
		ready,
		viaPr: (row) => landsViaPr(config(), row),
		repoMatches: (row, repos) => repoMatchesTask(config(), row, repos),
		headOf: (row) => hostOpsOf(config(), row.host, ctx.options.herdrRun).headOf(row.worktree),
		autoLand,
		stop: (row, state, reason) => postPrLandStop(ctx, row, state, reason),
		now: () => ctx.clock.now(),
		// The context is filled in after the landing is built: the logger is read at each call.
		get log() {
			return ctx.log;
		},
	});
}
