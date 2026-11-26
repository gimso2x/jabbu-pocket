import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { noteAgyTaskLimit, taskDriver } from "../src/daemon/daemon-task-resume";
import { taskOriginKey } from "../src/lanes/status";
import { AgyPrintDriver } from "../src/omp/agy-print-driver";
import type { OmpFinal } from "../src/omp/driver";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { buildWorkerFloorsPrompt } from "../src/safety/prompt";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { agySecretsDirs, agySettings } from "../src/tasks/worker-tier";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A daemon context with only what `taskDriver` and `noteAgyTaskLimit` read: config, ledger, log, sweeper. */
function context(options: { runtime: TaskRow["runtime"]; workerModel?: string }) {
	const home = mkdtempSync(join(tmpdir(), "jabbu-task-agy-"));
	dirs.push(home);
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => Date.parse("2026-11-26T00:00:00Z") },
	});
	const row = ledger.register({
		title: "agy 시범",
		risk: "L0",
		originKey: "discord/dm/200000000000000001",
		threadRef: "c:1",
		host: null,
		repo: join(home, "repo"),
		acceptance: [],
		runtime: options.runtime,
		...(options.workerModel === undefined
			? {}
			: { worker: { tier: "low" as const, tierReason: "기본값", model: options.workerModel } }),
	});
	mkdirSync(row.worktree, { recursive: true });
	const executable = join(home, "agy");
	writeFileSync(
		executable,
		`#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-agy-print-child.ts")}" "$@"\n`,
	);
	chmodSync(executable, 0o755);
	const blocked: Array<{ row: TaskRow; line: string }> = [];
	const warnings: string[] = [];
	const ctx = {
		options: { config: { homeDir: home, agyExecutable: executable, ompExecutable: "omp" } },
		store: { tasks: ledger },
		log: { debug() {}, info() {}, warn: (event: string) => warnings.push(event), error() {} },
		// Never settles: `noteAgyTaskLimit` must return without waiting for it.
		taskSweeper: {
			blockOnAgyLimit: (target: TaskRow, line: string) => {
				blocked.push({ row: target, line });
				return new Promise<void>(() => {});
			},
		},
	} as unknown as DaemonContext;
	return { home, row, ctx, blocked, warnings, origin: taskOriginKey(row.agent) };
}

test("AC-4: an agy [TASK] origin gets the print driver with the row's model, floors and OMP_WIKI_NOTE_DISABLE=1", async () => {
	const { home, row, ctx, origin } = context({ runtime: "headless", workerModel: "agy:gemini-4-hydrogen-high" });
	const log = join(home, "fake.log");
	writeFileSync(log, "");
	const sessionDir = join(home, "sessions", "t");
	const env = { env: { FAKE_AGY_LOG: log }, baseEnv: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" } };
	const driver = taskDriver(ctx, origin, sessionDir, env);
	expect(driver).toBeInstanceOf(AgyPrintDriver);
	await driver.start();
	const final = Promise.withResolvers<OmpFinal>();
	driver.onFinal((value) => final.resolve(value));
	await driver.prompt("시작");
	expect(await final.promise).toMatchObject({ status: "completed" });
	expect((await driver.state()).model).toBe("agy/gemini-4-hydrogen-high");
	await driver.stop();
	const entries = readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { kind: string; argv?: string[]; env?: Record<string, string>; line?: string });
	const argv = entries.find((entry) => entry.kind === "argv")?.argv ?? [];
	const secrets = join(home, "secrets");
	expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high");
	expect(argv[argv.indexOf("--settings") + 1]).toBe(agySettings([row.worktree], agySecretsDirs(secrets)));
	expect(argv[argv.indexOf("--log-file") + 1]).toStartWith(
		join(home, ".gemini", "antigravity-cli", "log", "cli-task-"),
	);
	expect(entries.find((entry) => entry.kind === "env")?.env?.OMP_WIKI_NOTE_DISABLE).toBe("1");
	const first = JSON.parse(entries.find((entry) => entry.kind === "in")?.line ?? "{}");
	expect(first.message.content).toBe(`${buildWorkerFloorsPrompt(secrets, row)}\n\n시작`);
});

test("AC-4: a non-agy [TASK] origin keeps the omp RPC driver", () => {
	const { ctx, origin } = context({ runtime: "headless" });
	expect(taskDriver(ctx, origin, "/nowhere", { env: {} })).toBeInstanceOf(RpcOmpDriver);
});

test("AC-5: a headless agy 429 turn end blocks once through the sweeper without waiting; other ends do nothing", () => {
	const limit = "agy rate limited (429): RESOURCE_EXHAUSTED (code 429): Individual quota reached.";
	const agy = context({ runtime: "headless", workerModel: "agy:gemini-4-hydrogen-high" });
	expect(noteAgyTaskLimit(agy.ctx, { originKey: agy.origin, error: limit, text: "", openDialogs: 0 })).toBeUndefined();
	expect(agy.blocked.map((call) => [call.row.taskId, call.line])).toEqual([[agy.row.taskId, limit]]);
	noteAgyTaskLimit(agy.ctx, { originKey: agy.origin, error: "model exploded", text: "", openDialogs: 0 });
	noteAgyTaskLimit(agy.ctx, { originKey: agy.origin, text: "done", openDialogs: 0 });
	const herdr = context({ runtime: "herdr", workerModel: "agy:gemini-4-hydrogen-high" });
	noteAgyTaskLimit(herdr.ctx, { originKey: herdr.origin, error: limit, text: "", openDialogs: 0 });
	const omp = context({ runtime: "headless" });
	noteAgyTaskLimit(omp.ctx, { originKey: omp.origin, error: limit, text: "", openDialogs: 0 });
	expect(agy.blocked).toHaveLength(1);
	expect(herdr.blocked).toEqual([]);
	expect(omp.blocked).toEqual([]);
});
