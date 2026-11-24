import { Database } from "bun:sqlite";
import type { InboundRecord } from "../../src/core/types";
import type { DispatchToolDeps } from "../../src/dispatch/tool";
import { TaskLedger, type TaskRow } from "../../src/tasks/ledger";
import type { TaskMailboxPort } from "../../src/tasks/runtime";

/** 2026-11-12 (Asia/Seoul): the first row of this ledger is `T-20261112-01`, agent `t-20261112-01`. */
export const LOCAL_TASK_NOW = Date.parse("2026-11-12T03:00:00Z");

/**
 * A ledger holding one local [TASK] row, shaped as `DispatchToolDeps["tasks"]` for the follow-up and read branches of
 * `jabbu_dispatch {mode:"worker", name}`. Its host ops read nothing, so the judgement line says it could not read.
 */
export interface LocalTask {
	row: TaskRow;
	ledger: TaskLedger;
	tasks: NonNullable<DispatchToolDeps["tasks"]>;
}

export function localTask(runtime: TaskRow["runtime"] = "herdr", headless?: TaskMailboxPort): LocalTask {
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => LOCAL_TASK_NOW },
	});
	const row = ledger.register({
		title: "로컬 작업",
		risk: "L0",
		originKey: "discord/dm/200000000000000001",
		threadRef: "c:1",
		host: null,
		repo: "/r/repo",
		acceptance: [],
		runtime,
	});
	const tasks = {
		ledger,
		now: () => LOCAL_TASK_NOW,
		timezone: "Asia/Seoul",
		hostOps: () => ({ readFile: async () => ({ ok: false, error: "no docs" }) }),
		...(headless === undefined ? {} : { headless }),
	} as unknown as NonNullable<DispatchToolDeps["tasks"]>;
	return { row, ledger, tasks };
}

/** A recording `TaskMailboxPort`: what a headless runtime asked of the daemon, with settable origin state. */
export function fakeMailbox() {
	const origins = new Set<string>();
	const busy = new Set<string>();
	const files = new Map<string, string>();
	const calls = {
		ensured: [] as Array<[string, string]>,
		routed: [] as InboundRecord[],
		paused: [] as string[],
		stopped: [] as string[],
		failRoute: undefined as Error | undefined,
		pauseBusy: false,
	};
	const port: TaskMailboxPort = {
		sessionDirFor: (origin) => `/sessions/${origin}`,
		ensureOrigin: (origin, dir) => {
			calls.ensured.push([origin, dir]);
			origins.add(origin);
		},
		hasOrigin: (origin) => origins.has(origin),
		route: async (record) => {
			calls.routed.push(record);
			if (calls.failRoute !== undefined) throw calls.failRoute;
		},
		busy: (origin) => busy.has(origin),
		sessionFile: (origin) => files.get(origin),
		pauseTurn: async (origin) => {
			calls.paused.push(origin);
			if (!calls.pauseBusy) busy.delete(origin);
			return { busy: calls.pauseBusy, settled: !calls.pauseBusy };
		},
		stopWhenIdle: async (origin) => void calls.stopped.push(origin),
		resumePending: async () => undefined,
	};
	return { port, origins, busy, files, calls };
}
