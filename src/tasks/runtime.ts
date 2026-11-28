import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { PauseCheck } from "../core/mailbox-types";
import type { InboundRecord } from "../core/types";
import {
	type HerdrAgentStatusResult,
	type HerdrInterruptResult,
	type HerdrPromptResult,
	type HerdrRunnerOptions,
	herdrAgentExists,
	herdrAgentStatus,
	herdrCloseTaskAgent,
	herdrInterruptAgent,
	herdrPromptExisting,
	herdrReadAgent,
} from "../dispatch/omp";
import { taskOriginKey } from "../lanes/status";
import type { LogFields } from "../log";
import { lastAnswerOf, readLastAssistant } from "../omp/session-tail";
import { redact } from "../redact";
import type { TaskLedger, TaskRow } from "./ledger";
import { agyModelOf } from "./worker-tier";

/**
 * What the headless runtime needs of the daemon's Mailbox (`daemon-task-resume.ts` builds it): one origin per task,
 * `jabbu/task/<agent>`. The runtime depends on this port only, never on the daemon.
 */
export interface TaskMailboxPort {
	/** `sessionDirFor(sessionsRoot, originKey, 1)`. */
	sessionDirFor(originKey: string): string;
	/** `store.ensureOrigin`. */
	ensureOrigin(originKey: string, sessionDir: string): void;
	/** `store.getOrigin(originKey) !== undefined`. */
	hasOrigin(originKey: string): boolean;
	/** `router.route`: queues the message (a turn in progress steers it). */
	route(record: InboundRecord): Promise<void>;
	/** A turn is in progress on the origin. */
	busy(originKey: string): boolean;
	/** The origin's omp session jsonl, when it has one. */
	sessionFile(originKey: string): string | undefined;
	/** An agy origin's last answer (the print driver's `agy-last-answer.txt`, kept past the driver); undefined: none. */
	lastAgyAnswer(originKey: string): string | undefined;
	/** Aborts the turn: final error `lane_paused`, no failure notice and no failure count. */
	pauseTurn(originKey: string): Promise<PauseCheck>;
	/** Closes the child without cutting a turn. */
	stopWhenIdle(originKey: string): Promise<void>;
	/** Re-injects the rows a pause held. */
	resumePending(originKey: string): Promise<void>;
}

export type TaskStartResult = { ok: true; paneId: string } | { ok: false; error: string };
export type TaskCloseResult = { ok: true } | { ok: false; error: string };

/** What the task callers do to a task's worker, whatever it runs on; the row's `runtime` picks the implementation. */
export interface TaskRuntime {
	/** Starts the worker in the task's worktree with `prompt` (`paneId` is `""` without a pane). */
	start(row: TaskRow, prompt: string, closeOnPromptFailure?: boolean): Promise<TaskStartResult>;
	/** Whether the worker exists; a runtime that cannot be asked is an error, not "no". */
	exists(row: TaskRow): Promise<{ ok: true; exists: boolean } | { ok: false; error: string }>;
	/** working / idle / gone (+ herdr's blocked·done·unknown) and the session file, when known. */
	status(row: TaskRow): Promise<HerdrAgentStatusResult>;
	/** Delivers a follow-up or reminder to the live worker. */
	prompt(row: TaskRow, text: string): Promise<HerdrPromptResult>;
	/** The worker's latest output, redacted and cut to its last 4000 characters. */
	read(row: TaskRow): Promise<{ ok: boolean; output?: string; error?: string }>;
	/** Stops the turn in progress. */
	interrupt(row: TaskRow): Promise<HerdrInterruptResult>;
	/** Ends the worker (the row and the session stay). */
	close(row: TaskRow): Promise<TaskCloseResult>;
}

export type HerdrStart = (row: TaskRow, prompt: string, closeOnPromptFailure: boolean) => Promise<TaskStartResult>;

/** The herdr worker: the herdr CLI functions as they are. `startHerdr` is the caller's herdr start (local, remote, agy). */
export function herdrRuntime(optionsOf: (row: TaskRow) => HerdrRunnerOptions, startHerdr?: HerdrStart): TaskRuntime {
	return {
		start: (row, prompt, closeOnPromptFailure = false) =>
			startHerdr === undefined
				? Promise.resolve({ ok: false, error: "herdr 시작 함수가 주어지지 않았습니다" })
				: startHerdr(row, prompt, closeOnPromptFailure),
		exists: (row) => herdrAgentExists(row.agent, optionsOf(row)),
		status: (row) => herdrAgentStatus(row.agent, optionsOf(row)),
		prompt: (row, text) => herdrPromptExisting(row.agent, text, optionsOf(row)),
		read: (row) => herdrReadAgent(row.agent, optionsOf(row)),
		interrupt: (row) => herdrInterruptAgent(row.agent, optionsOf(row)),
		close: (row) => herdrCloseTaskAgent(row.agent, optionsOf(row)),
	};
}

const READ_TAIL_CHARS = 4_000;

/** The Mailbox worker: origin `jabbu/task/<agent>` driven through `port`. `warn` gets a send that failed. */
export function headlessRuntime(
	port: TaskMailboxPort,
	warn: (event: string, fields: LogFields) => void = () => undefined,
): TaskRuntime {
	/** Queues the text on the task's origin; like a lane's `#send` it does not wait for the turn, a failure is only logged. */
	const send = (row: TaskRow, kind: string, text: string): void => {
		port
			.route({
				platformMessageId: `task:${row.agent}:${kind}:${randomUUID()}`,
				originKey: taskOriginKey(row.agent),
				ownerVerified: true,
				text,
				// Shaped like a thread ref but no chat platform's: progress marks and notices reach no chat.
				threadRef: `task:${row.taskId}`,
			})
			.catch((error: unknown) => warn("task_send_failed", { task: row.taskId, kind, error: String(error) }));
	};
	return {
		async start(row, prompt) {
			const origin = taskOriginKey(row.agent);
			try {
				port.ensureOrigin(origin, port.sessionDirFor(origin));
			} catch (error) {
				return { ok: false, error: `헤드리스 세션을 만들지 못했습니다: ${String(error)}` };
			}
			send(row, "start", prompt);
			return { ok: true, paneId: "" };
		},
		async exists(row) {
			return { ok: true, exists: port.hasOrigin(taskOriginKey(row.agent)) };
		},
		async status(row) {
			const origin = taskOriginKey(row.agent);
			if (!port.hasOrigin(origin)) return { ok: true, status: "gone" };
			const status = port.busy(origin) ? "working" : "idle";
			const sessionPath = port.sessionFile(origin);
			return sessionPath === undefined ? { ok: true, status } : { ok: true, status, sessionPath };
		},
		async prompt(row, text) {
			send(row, "followup", text);
			return { ok: true };
		},
		async read(row) {
			const origin = taskOriginKey(row.agent);
			const path = port.sessionFile(origin);
			try {
				// An agy worker has no omp session: its print driver keeps the last answer in the origin's session dir.
				if (agyModelOf(row.workerModel) !== undefined)
					return { ok: true, output: redact(port.lastAgyAnswer(origin) ?? "").slice(-READ_TAIL_CHARS) };
				const found = path === undefined ? undefined : readLastAssistant(path);
				return {
					ok: true,
					output: found === undefined ? "" : redact(lastAnswerOf(found).text).slice(-READ_TAIL_CHARS),
				};
			} catch (error) {
				// A session the child has not written yet has no file: nothing to read, not a failed read.
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ok: true, output: "" };
				return { ok: false, error: String(error) };
			}
		},
		async interrupt(row) {
			const origin = taskOriginKey(row.agent);
			const { busy } = await port.pauseTurn(origin);
			return {
				confirmed: !busy,
				status: busy ? "working" : "idle",
				text: busy
					? "턴을 멈추라고 했지만 아직 진행 중입니다(헤드리스)"
					: "턴을 멈췄습니다(헤드리스). 다음 후속 지시로 이어집니다",
			};
		},
		async close(row) {
			try {
				await port.stopWhenIdle(taskOriginKey(row.agent));
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		},
	};
}

/**
 * The worker of a task by its recorded runtime. A headless row without a port is an error: the row cannot be driven
 * from here (the daemon always gives the port).
 */
export function runtimeFor(
	row: TaskRow,
	using: {
		herdr: (row: TaskRow) => HerdrRunnerOptions;
		startHerdr?: HerdrStart;
		headless?: TaskMailboxPort | undefined;
		warn?: (event: string, fields: LogFields) => void;
	},
): TaskRuntime {
	if (row.runtime !== "headless") return herdrRuntime(using.herdr, using.startHerdr);
	if (using.headless === undefined)
		throw new Error(`${row.taskId}는 헤드리스 작업인데 이 호출에는 Mailbox 포트가 없습니다`);
	return headlessRuntime(using.headless, using.warn);
}

/**
 * Lifts the owner pause of a task and returns a `fail` that re-applies it: the lift runs before the send, so a
 * headless worker takes the prompt at once (its Mailbox holds rows while paused); a send that fails reports through
 * `fail`, which puts the hold back first — a task whose resume failed stays paused instead of silently unpausing.
 * When the task was not paused `fail` just returns its text.
 */
export function releaseHold(
	ledger: Pick<TaskLedger, "get" | "isPaused" | "unpauseTask" | "pauseTask">,
	row: TaskRow,
): (text: string) => string {
	if (!ledger.isPaused(row)) return (text) => text;
	ledger.unpauseTask(row.taskId);
	return (text) => {
		const fresh = ledger.get(row.taskId);
		if (fresh !== undefined && (fresh.status === "working" || fresh.status === "blocked")) {
			try {
				ledger.pauseTask(row.taskId);
			} catch {
				// The task left working/blocked while the send was in flight (e.g. it reached review): the hold
				// has nothing to go back onto, and the failed resume still reports its failure instead of throwing.
			}
		}
		return text;
	};
}

/**
 * A headless task's worker as the ledger shows it, for a process without the daemon's Mailbox (the dashboard): no origin
 * is `gone`, a dispatched row (a turn in progress) `working`, otherwise `idle`.
 */
export function headlessStatusFromLedger(db: Database, row: TaskRow): "gone" | "working" | "idle" {
	const origin = taskOriginKey(row.agent);
	if (db.query("SELECT 1 FROM origins WHERE origin_key = ?").get(origin) === null) return "gone";
	return db.query("SELECT 1 FROM inbound WHERE origin_key = ? AND state = 'dispatched' LIMIT 1").get(origin) === null
		? "idle"
		: "working";
}
