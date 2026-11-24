import { type JabbuConfig, primaryOwnerUserId } from "../config";
import { boardCardLink, diffViewLink } from "../dispatch/board";
import { herdrAgentPane, type ProcessRunner, readRemoteLastAssistant, realProcessRunner } from "../dispatch/omp";
import { lastAnswerOf, readLastAssistant } from "../omp/session-tail";
import { readAutoLandHold } from "../ops/apply";
import { HerdrHealthProbe } from "../ops/herdr-health";
import { TaskCheckRunner } from "../tasks/check-runner";
import { notePrompt } from "../tasks/dispatch";
import { evaluateTask, ledgerTaskChecks, runCheckJob } from "../tasks/evaluate";
import type { TaskGateHooks } from "../tasks/gate";
import type { TaskLandOutcome } from "../tasks/land";
import type { TaskRow } from "../tasks/ledger";
import { integrityBaseOf, landsViaPr } from "../tasks/pr-land-task";
import { taskChangedPaths, taskProgressEvidence } from "../tasks/progress-evidence";
import { recordsTicker, taskHostOf } from "../tasks/records";
import { TaskSweeper } from "../tasks/sweeper";
import { autoLandPolicy, type DaemonContext } from "./daemon-context";
import type { DaemonStore } from "./daemon-store";
import { herdrOptionsOf, ledgerOf, taskRuntimeOf } from "./daemon-task-resume";

/** What the [TASK] sweep needs from the daemon beyond its context. */
export interface TaskSweepDeps {
	store: DaemonStore;
	config: JabbuConfig;
	herdr: JabbuConfig["herdr"];
	herdrRun: ProcessRunner | undefined;
	requestTaskSweep: (taskId: string) => void;
	repoMatches: (row: TaskRow, repos: readonly string[]) => Promise<boolean>;
	autoLand: (row: TaskRow, gate?: TaskGateHooks) => Promise<TaskLandOutcome>;
	landReady: () => boolean;
	pollTaskPrLand: (row: TaskRow) => Promise<void>;
	retryPrLand: (row: TaskRow) => Promise<void>;
}

/** The herdr reachability probe (herdr on only), the local `[check: …]` queue and the [TASK] sweeper. */
export function createTaskSweep(
	ctx: DaemonContext,
	deps: TaskSweepDeps,
): { herdrHealth: HerdrHealthProbe | undefined; checkRunner: TaskCheckRunner; taskSweeper: TaskSweeper } {
	const { store, config, herdrRun } = deps;
	const { log } = ctx;
	const skipSeen = new Set<string>(); // a read a task was left out of is logged once per `<event>:<task>:<reason>`
	const skipOnce = (event: string, row: TaskRow, reason: string) => {
		const key = `${event}:${row.taskId}:${reason}`;
		if (!skipSeen.has(key)) log.info(event, { task: row.taskId, reason });
		skipSeen.add(key);
	};
	const herdrHealth =
		deps.herdr === undefined
			? undefined
			: new HerdrHealthProbe({
					homeDir: config.homeDir,
					bin: deps.herdr.bin ?? "herdr",
					run: herdrRun ?? realProcessRunner,
					now: () => ctx.clock.now(),
				});
	// `deps.config` is the boot snapshot: reloadable fields (dispatchHosts, recordsRepo, herdrBoard, taskAutoLand) are read live from `ctx.options.config`.
	const hostOf = (host: string | null) => taskHostOf(ctx.options.config, host);
	const recordTask = recordsTicker(ctx, (row) => hostOf(row.host));
	const checkRunner = new TaskCheckRunner({
		execute: async (taskId, signal) => {
			const row = store.tasks.get(taskId);
			if (row === undefined || row.host !== null || !["working", "blocked", "review"].includes(row.status)) {
				return { kind: "skipped" };
			}
			return runCheckJob(row, hostOf(null), ledgerTaskChecks(store.tasks), signal);
		},
		onDone: (taskId) => deps.requestTaskSweep(taskId),
		now: () => ctx.clock.now(),
		log,
	});
	const taskSweeper = new TaskSweeper({
		ledger: deps.herdr === undefined ? ledgerOf(store.tasks, (row) => row.runtime === "headless") : store.tasks,
		frozen: ctx.frozen,
		checkRunner,
		evaluate: async (row, checks) => {
			await recordTask(row);
			const { tools, seams } = ctx.options.prLand ?? {};
			const base = () => integrityBaseOf(ctx.options.config, row, tools, seams?.address);
			return evaluateTask(row, hostOf(row.host), checks, checkRunner, base);
		},
		pollTaskPrLand: (row) => deps.pollTaskPrLand(row),
		retryPrLand: (row) => deps.retryPrLand(row),
		landsViaPr: (row) => landsViaPr(ctx.options.config, row),
		remind: async (row, text) => {
			const sent = await taskRuntimeOf(ctx, row).prompt(row, text);
			if (sent.ok || sent.unconfirmed === true) {
				notePrompt(
					{ recordPrompt: (input) => store.recordHerdrPrompt(input), log },
					{ host: row.host, agent: row.agent, kind: "remind", text, originKey: row.originKey },
				);
			}
			return sent;
		},
		agentStatus: (row) => taskRuntimeOf(ctx, row).status(row),
		readAgent: (row) => taskRuntimeOf(ctx, row).read(row),
		lastAnswer: async (row, sessionPath) => {
			if (row.host === null) {
				const found = readLastAssistant(sessionPath);
				return found === undefined ? undefined : lastAnswerOf(found);
			}
			const entry = ctx.options.config.dispatchHosts?.[row.host];
			if (entry === undefined) throw new Error(`dispatchHosts has no ${row.host}`);
			const found = await readRemoteLastAssistant(entry.ssh, sessionPath, herdrRun ?? realProcessRunner);
			return found === undefined ? undefined : lastAnswerOf(found);
		},
		boardLink: async (row) => {
			const board = ctx.options.config.herdrBoard;
			if (board === undefined || row.runtime === "headless") return undefined;
			const pane = await herdrAgentPane(row.agent, herdrOptionsOf(ctx, row));
			return boardCardLink(board, row.host, pane, {
				onError: (error) => log.warn("task_board_link_failed", { task: row.taskId, error }),
			});
		},
		diffLink: (row) => {
			const board = ctx.options.config.herdrBoard;
			return board === undefined || row.host !== null ? undefined : diffViewLink(board, `task:${row.taskId}`);
		},
		autoLandPolicy: () => autoLandPolicy(ctx),
		repoMatches: (row, repos) => deps.repoMatches(row, repos),
		changedPaths: async (row) => {
			const changed = await taskChangedPaths(row.worktree, realProcessRunner);
			if (changed.ok) return changed.paths;
			skipOnce("task_overlap_skipped", row, changed.reason);
			return undefined;
		},
		progressEvidence: async (row) => {
			// A remote task's worktree is on another machine: no evidence is collected.
			if (row.host !== null) return undefined;
			const evidence = await taskProgressEvidence(row, realProcessRunner);
			if (evidence.ok) return evidence.key;
			skipOnce("task_progress_evidence_skipped", row, evidence.reason);
			return undefined;
		},
		autoLand: (row, gate) => deps.autoLand(row, gate),
		gatePending: async (row) => {
			const policy = autoLandPolicy(ctx);
			return policy !== undefined && (ctx.taskGates?.pending(row, policy) ?? false);
		},
		autoLandHold: () => readAutoLandHold(config.homeDir),
		autoLandReady: () => deps.landReady(),
		channels: ctx.channels,
		ownerUserId: primaryOwnerUserId(config.channels),
		ownerSilenceConfig: () => ctx.options.config,
		now: () => ctx.clock.now(),
		log,
	});
	return { herdrHealth, checkRunner, taskSweeper };
}
