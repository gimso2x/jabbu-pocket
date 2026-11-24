import { join } from "node:path";
import { sessionToResume } from "../core/mailbox-types";
import { sessionDirFor } from "../core/origin";
import type { HerdrRunnerOptions } from "../dispatch/omp";
import { isTaskOrigin, TASK_ORIGIN_PREFIX } from "../lanes/status";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { buildWorkerFloorsPrompt } from "../safety/prompt";
import type { TaskDispatchDeps } from "../tasks/dispatch";
import type { TaskLedger, TaskRow } from "../tasks/ledger";
import { runtimeFor, type TaskMailboxPort, type TaskRuntime } from "../tasks/runtime";
import { withWorkerModel } from "../tasks/worker-tier";
import { type DaemonContext, startedStore } from "./daemon-context";

/** The ledger row of a [TASK] worker origin `jabbu/task/<agent>`; undefined for any other origin or a row that is gone. */
export function taskOfOrigin(ledger: TaskLedger | undefined, originKey: string): TaskRow | undefined {
	if (ledger === undefined || !isTaskOrigin(originKey)) return undefined;
	return ledger.getByAgent(originKey.slice(TASK_ORIGIN_PREFIX.length), null);
}

/** The headless runtime's view of the daemon: one Mailbox origin per task (`jabbu/task/<agent>`), the same router as lanes. */
export function taskMailboxPort(ctx: DaemonContext): TaskMailboxPort {
	const mailbox = (originKey: string) => {
		if (ctx.router === undefined) throw new Error("daemon not started");
		return ctx.router.mailbox(originKey);
	};
	return {
		sessionDirFor: (originKey) => sessionDirFor(join(ctx.options.config.homeDir, "sessions"), originKey, 1),
		ensureOrigin: (originKey, sessionDir) => startedStore(ctx).ensureOrigin(originKey, sessionDir),
		hasOrigin: (originKey) => startedStore(ctx).getOrigin(originKey) !== undefined,
		route: (record) => ctx.router?.route(record) ?? Promise.reject(new Error("daemon not started")),
		busy: (originKey) => mailbox(originKey).state.busy,
		sessionFile: (originKey) => {
			const origin = startedStore(ctx).getOrigin(originKey);
			return origin === undefined ? undefined : sessionToResume(origin);
		},
		pauseTurn: (originKey) => mailbox(originKey).pauseTurn(),
		stopWhenIdle: (originKey) => mailbox(originKey).stopWhenIdle(),
		resumePending: (originKey) => mailbox(originKey).resumePending(),
	};
}

/** The `env` and `baseEnv` every bot RPC child gets (`botRpcEnv` in run.ts). */
export interface TaskRpcEnv {
	env: Record<string, string>;
	baseEnv?: Record<string, string | undefined>;
}

/**
 * The omp child of a [TASK] worker origin, whatever the bot's own `agent`: headless `--mode rpc` (no dialog answerer,
 * so `ask` is cancelled), no jabbu host tools, the worker floors as system prompt, the model fixed at registration.
 */
export function taskDriver(
	ctx: DaemonContext,
	originKey: string,
	sessionDir: string,
	rpcEnv: TaskRpcEnv,
): RpcOmpDriver {
	const row = taskOfOrigin(ctx.store?.tasks, originKey);
	if (row === undefined) throw new Error(`task_row_missing: ${originKey}`);
	const { config } = ctx.options;
	return new RpcOmpDriver({
		ompExecutable: config.ompExecutable,
		cwd: row.worktree,
		sessionDir,
		...rpcEnv,
		...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
		extraArgs: [
			"--append-system-prompt",
			buildWorkerFloorsPrompt(join(config.homeDir, "secrets"), row),
			...(withWorkerModel(config.workerOmpArgs, row.workerModel) ?? []),
		],
		hostTools: [],
		log: ctx.log,
	});
}

/** `resumeTask`'s deps from the daemon's own: the live config, the ledger, the herdr runner of the sweep and the headless port. */
export function taskResumeDeps(ctx: DaemonContext, ledger: TaskLedger, row: TaskRow): TaskDispatchDeps {
	const { options, store, channels, clock, log } = ctx;
	const config = options.config;
	return {
		ledger,
		originKey: row.originKey,
		threadRef: () => row.threadRef,
		rootText: () => undefined,
		channels,
		now: () => clock.now(),
		timezone: config.timezone,
		workspaceDir: config.workspaceDir,
		...(config.dispatchHosts === undefined ? {} : { dispatchHosts: config.dispatchHosts }),
		...(config.recordsRepo === undefined ? {} : { recordsRepo: config.recordsRepo }),
		...(config.workerOmpArgs === undefined ? {} : { workerOmpArgs: config.workerOmpArgs }),
		secretsDir: join(config.homeDir, "secrets"),
		...(options.herdrRun === undefined ? {} : { run: options.herdrRun }),
		headless: taskMailboxPort(ctx),
		recordPrompt: (input) => store?.recordHerdrPrompt(input),
		log,
	};
}

/**
 * Whether the owner's pause holds the task of a [TASK] origin: its rows wait until a follow-up lifts the hold.
 * `orBlocked`: a task blocked on the owner's answer waits as well (no retry of its pending rows).
 */
export function taskHeld(ledger: TaskLedger | undefined, originKey: string, orBlocked = false): boolean {
	const row = taskOfOrigin(ledger, originKey);
	return row !== undefined && (ledger?.isPaused(row) === true || (orBlocked && row.status === "blocked"));
}

/** A [TASK] origin whose task is closed (done, cancelled) or gone: a cut turn of it is not resumed. */
export function taskClosed(ledger: TaskLedger, originKey: string): boolean {
	if (!isTaskOrigin(originKey)) return false;
	const status = taskOfOrigin(ledger, originKey)?.status;
	return status === undefined || status === "done" || status === "cancelled";
}

/**
 * The ledger as the sweep sees it: only the active and in-review rows `keep` takes (a daemon without herdr leaves the
 * herdr rows alone); every other call goes to the ledger itself.
 */
export function ledgerOf(ledger: TaskLedger, keep: (row: TaskRow) => boolean): TaskLedger {
	return new Proxy(ledger, {
		get(target, key) {
			if (key === "listActive" || key === "listInReview") return () => target[key]().filter(keep);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The herdr call options of a task's host: a dispatch host's ssh target and herdr binary, the local ones otherwise. */
export function herdrOptionsOf(ctx: DaemonContext, row: TaskRow): HerdrRunnerOptions {
	const entry = row.host === null ? undefined : ctx.options.config.dispatchHosts?.[row.host];
	const run = ctx.options.herdrRun;
	return {
		cwd: ctx.options.config.workspaceDir,
		...(entry === undefined ? {} : { sshTarget: entry.ssh }),
		...(entry?.herdrBin === undefined ? {} : { herdrBin: entry.herdrBin }),
		...(run === undefined ? {} : { run }),
	};
}

/** The worker of a task by its recorded runtime: herdr (the row host's options) or the daemon's Mailbox. */
export function taskRuntimeOf(ctx: DaemonContext, row: TaskRow): TaskRuntime {
	return runtimeFor(row, {
		herdr: (r) => herdrOptionsOf(ctx, r),
		headless: taskMailboxPort(ctx),
		warn: (event, fields) => ctx.log.warn(event, fields),
	});
}
