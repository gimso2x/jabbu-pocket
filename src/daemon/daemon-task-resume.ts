import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionToResume, type TurnSettledInfo } from "../core/mailbox-types";
import { sessionDirFor } from "../core/origin";
import type { HerdrRunnerOptions } from "../dispatch/omp";
import { isTaskOrigin, TASK_ORIGIN_PREFIX } from "../lanes/status";
import { AGY_LAST_ANSWER_FILE, AgyPrintDriver } from "../omp/agy-print-driver";
import { AGY_RATE_LIMIT_HEAD } from "../omp/agy-quota";
import type { OmpSessionDriver } from "../omp/driver";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { buildWorkerFloorsPrompt } from "../safety/prompt";
import type { TaskDispatchDeps } from "../tasks/dispatch";
import type { TaskLedger, TaskRow } from "../tasks/ledger";
import { agyWorkspacesOf } from "../tasks/records";
import { runtimeFor, type TaskMailboxPort, type TaskRuntime } from "../tasks/runtime";
import { agyModelOf, agySecretsDirs, agySettings, withWorkerModel } from "../tasks/worker-tier";
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
		lastAgyAnswer: (originKey) => {
			const origin = startedStore(ctx).getOrigin(originKey);
			const path = origin === undefined ? undefined : join(origin.sessionDir, AGY_LAST_ANSWER_FILE);
			return path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : undefined;
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
 * The child of a [TASK] worker origin, whatever the bot's own `agent`, with the model fixed at registration. An agy row
 * (`agy:<model>`) gets the agy print driver: the herdr worker's `--settings` deny rules, the worker floors ahead of each
 * new conversation. Any other row gets headless omp `--mode rpc` (no dialog answerer, so `ask` is cancelled), no jabbu
 * host tools, the worker floors as system prompt.
 */
export function taskDriver(
	ctx: DaemonContext,
	originKey: string,
	sessionDir: string,
	rpcEnv: TaskRpcEnv,
): OmpSessionDriver {
	const row = taskOfOrigin(ctx.store?.tasks, originKey);
	if (row === undefined) throw new Error(`task_row_missing: ${originKey}`);
	const { config } = ctx.options;
	const secretsDir = join(config.homeDir, "secrets");
	const agy = agyModelOf(row.workerModel);
	if (agy !== undefined) {
		const workspaces = agyWorkspacesOf(row);
		return new AgyPrintDriver({
			agyExecutable: config.agyExecutable ?? "agy",
			cwd: row.worktree,
			sessionDir,
			model: agy,
			settings: agySettings(workspaces, agySecretsDirs(secretsDir)),
			addDirs: workspaces.filter((dir) => dir !== row.worktree),
			workerFloors: buildWorkerFloorsPrompt(secretsDir, row),
			logName: row.agent,
			// The worker's session note would repeat the brief, as for a herdr worker (`startHerdrAgent`).
			env: { ...rpcEnv.env, OMP_WIKI_NOTE_DISABLE: "1" },
			...(rpcEnv.baseEnv === undefined ? {} : { baseEnv: rpcEnv.baseEnv }),
			log: ctx.log,
			originKey,
		});
	}
	return new RpcOmpDriver({
		ompExecutable: config.ompExecutable,
		cwd: row.worktree,
		sessionDir,
		...rpcEnv,
		...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
		extraArgs: [
			"--append-system-prompt",
			buildWorkerFloorsPrompt(secretsDir, row),
			...(withWorkerModel(config.workerOmpArgs, row.workerModel) ?? []),
		],
		hostTools: [],
		log: ctx.log,
	});
}

/**
 * A headless agy [TASK] turn that ended on agy's limit (the print driver already ended its child): the task is blocked
 * with one owner card, as the sweep does on a herdr agy screen. Run in the background: the turn's settlement never waits
 * on the ledger or a post.
 */
export function noteAgyTaskLimit(ctx: DaemonContext, info: TurnSettledInfo): void {
	const error = info.error;
	if (error === undefined || !error.startsWith(AGY_RATE_LIMIT_HEAD)) return;
	const row = taskOfOrigin(ctx.store?.tasks, info.originKey);
	if (row === undefined || row.runtime !== "headless" || agyModelOf(row.workerModel) === undefined) return;
	const sweeper = ctx.taskSweeper;
	if (sweeper === undefined) {
		ctx.log.warn("task_agy_limit_unhandled", { task: row.taskId, reason: "no task sweeper" });
		return;
	}
	sweeper.blockOnAgyLimit(row, error).catch((cause: unknown) => {
		ctx.log.warn("task_agy_limit_failed", { task: row.taskId, error: String(cause) });
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
	const entry =
		row.host !== null && Object.hasOwn(ctx.options.config.dispatchHosts ?? {}, row.host)
			? ctx.options.config.dispatchHosts?.[row.host]
			: undefined;
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
