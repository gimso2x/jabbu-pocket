import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { taskMailboxPort } from "../src/daemon/daemon-task-resume";
import { buildDispatchTool } from "../src/dispatch/tool";
import { isTaskOrigin, taskOriginKey } from "../src/lanes/status";
import { AGY_LAST_ANSWER_FILE } from "../src/omp/agy-print-driver";
import { TaskLedger } from "../src/tasks/ledger";
import { TASK_SCHEMA } from "../src/tasks/ledger-schema";
import { headlessRuntime, runtimeFor } from "../src/tasks/runtime";
import { fakeMailbox, type LocalTask, localTask } from "./helpers/local-task";

const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tasks.runtime column (AC-5)", () => {
	test("a ledger from before the column opens with every row read as herdr; a new row can be headless", () => {
		const db = new Database(":memory:", { strict: true });
		// The tasks table exactly as the code before `runtime` created it.
		db.run(TASK_SCHEMA.replace(",\n\truntime TEXT NOT NULL DEFAULT 'herdr'", ""));
		expect((db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain(
			"runtime",
		);
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at) VALUES ('T-20261001-01', 't', 'L1', 'o', 'c:1', NULL, '/r', '/r-t', 'task/T-20261001-01',
				't-20261001-01', 'working', '[]', 1, 1)`,
		);
		const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => 5 } });
		expect(ledger.require("T-20261001-01").runtime).toBe("herdr");
		const fresh = ledger.register({
			title: "n",
			risk: "L1",
			originKey: "o",
			threadRef: "c:1",
			host: null,
			repo: "/r",
			acceptance: [],
			runtime: "headless",
		});
		expect(ledger.require(fresh.taskId).runtime).toBe("headless");
	});
});

describe("jabbu_dispatch tool contract (AC-7)", () => {
	const build = (tasks?: LocalTask["tasks"]) =>
		buildDispatchTool({
			originKey: "discord/dm/200000000000000001",
			ompExecutable: "omp",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run: async () => {
				throw new Error("nothing may run");
			},
			...(tasks === undefined ? {} : { tasks }),
		});

	test("the mode enum is simple|worker, and a headless port alone (no herdr) opens the worker parameters", () => {
		const tool = build(localTask("headless", fakeMailbox().port).tasks);
		const properties = (tool.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
		expect(properties.mode?.enum).toEqual(["simple", "worker"]);
		expect(Object.keys(properties)).toEqual(expect.arrayContaining(["name", "host", "cwd", "taskSpec"]));
	});

	test("a local worker start without taskSpec is an error; the old mode name is not accepted; a host still needs herdr", async () => {
		const { row, tasks } = localTask("headless", fakeMailbox().port);
		const tool = build(tasks);
		await expect(tool.execute({ mode: "worker", name: "x", task: "y" }, { signal })).rejects.toThrow(
			"등록된 로컬 작업이 아닙니다",
		);
		await expect(
			tool.execute({ mode: "worker", name: row.agent.replace("01", "09"), task: "y" }, { signal }),
		).rejects.toThrow("taskSpec으로 등록");
		await expect(tool.execute({ mode: "herdr", name: row.agent }, { signal })).rejects.toThrow("simple 또는 worker");
		await expect(tool.execute({ host: "wsl", name: "x", task: "y" }, { signal })).rejects.toThrow("herdr가 꺼져 있어");
	});

	test("with neither herdr nor a headless port the tool is simple-only", () => {
		const tool = build();
		expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["task"]);
	});
});

describe("headlessRuntime (AC-2)", () => {
	const { row } = localTask("headless");
	const origin = taskOriginKey(row.agent);

	test("TASK origins are told apart from lane origins by the prefix", () => {
		expect(origin).toBe("jabbu/task/t-20261112-01");
		expect(isTaskOrigin(origin)).toBe(true);
		expect(isTaskOrigin("jabbu/work/x")).toBe(false);
	});

	test("status: no origin is gone, a turn in progress is working, otherwise idle with the session file", async () => {
		const mailbox = fakeMailbox();
		const runtime = headlessRuntime(mailbox.port);
		expect(await runtime.status(row)).toEqual({ ok: true, status: "gone" });
		expect(await runtime.exists(row)).toEqual({ ok: true, exists: false });
		mailbox.origins.add(origin);
		expect(await runtime.status(row)).toEqual({ ok: true, status: "idle" });
		mailbox.busy.add(origin);
		mailbox.files.set(origin, "/s/a.jsonl");
		expect(await runtime.status(row)).toEqual({ ok: true, status: "working", sessionPath: "/s/a.jsonl" });
		expect(await runtime.exists(row)).toEqual({ ok: true, exists: true });
	});

	test("start opens the origin and routes the prompt; prompt routes a follow-up; neither waits for the turn", async () => {
		const mailbox = fakeMailbox();
		const runtime = headlessRuntime(mailbox.port);
		expect(await runtime.start(row, "시작해")).toEqual({ ok: true, paneId: "" });
		expect(await runtime.prompt(row, "재촉")).toEqual({ ok: true });
		expect(mailbox.calls.ensured).toEqual([[origin, `/sessions/${origin}`]]);
		expect(mailbox.calls.routed.map((r) => [r.originKey, r.text, r.ownerVerified, r.threadRef])).toEqual([
			[origin, "시작해", true, `task:${row.taskId}`],
			[origin, "재촉", true, `task:${row.taskId}`],
		]);
		expect(new Set(mailbox.calls.routed.map((r) => r.platformMessageId)).size).toBe(2);
	});

	test("a failed route is logged, not thrown, and the call still reports delivery", async () => {
		const mailbox = fakeMailbox();
		mailbox.calls.failRoute = new Error("mailbox closed");
		const warned: string[] = [];
		const runtime = headlessRuntime(mailbox.port, (event) => warned.push(event));
		expect(await runtime.prompt(row, "재촉")).toEqual({ ok: true });
		for (let tick = 0; tick < 3; tick++) await Promise.resolve(); // let the rejected route reach its catch
		expect(warned).toEqual(["task_send_failed"]);
	});

	test("read: the last assistant answer of the session file, redacted; no file or session reads as empty", async () => {
		const mailbox = fakeMailbox();
		const runtime = headlessRuntime(mailbox.port);
		expect(await runtime.read(row)).toEqual({ ok: true, output: "" });
		mailbox.files.set(origin, join(tmpdir(), "jabbu-no-such-session.jsonl"));
		expect(await runtime.read(row)).toEqual({ ok: true, output: "" });
		const dir = mkdtempSync(join(tmpdir(), "jabbu-headless-"));
		dirs.push(dir);
		const file = join(dir, "s.jsonl");
		const token = ["xox", "b-TEST-0-fakefake"].join("");
		const line = (role: string, text: string) =>
			JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
		writeFileSync(
			file,
			`${[line("assistant", "첫 답"), line("user", "다음"), line("assistant", `끝 답 ${token}`)].join("\n")}\n`,
		);
		mailbox.files.set(origin, file);
		const read = await runtime.read(row);
		expect(read.ok).toBe(true);
		expect(read.output).toContain("끝 답");
		expect(read.output).not.toContain("첫 답");
		expect(read.output).not.toContain(token);
	});

	test("AC-6: an agy row reads the print driver's last answer from the session dir, with no driver alive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-headless-agy-"));
		dirs.push(dir);
		const token = ["xox", "b-TEST-0-fakefake"].join("");
		writeFileSync(join(dir, AGY_LAST_ANSWER_FILE), `PROGRESS S2 끝 ${token}`);
		// The daemon's real port: the store's origin row only, no router (an idle-stopped origin has no driver).
		const origins = new Map([[origin, { sessionDir: dir }]]);
		const ctx = { store: { getOrigin: (key: string) => origins.get(key) } } as unknown as DaemonContext;
		const port = taskMailboxPort(ctx);
		const agyRow = { ...row, workerModel: "agy:gemini-4-hydrogen-high" };
		const read = await headlessRuntime(port).read(agyRow);
		expect(read.ok).toBe(true);
		expect(read.output).toContain("PROGRESS S2 끝");
		expect(read.output).not.toContain(token);
		origins.set(origin, { sessionDir: join(dir, "empty") });
		expect(await headlessRuntime(port).read(agyRow)).toEqual({ ok: true, output: "" });
	});

	test("interrupt pauses the turn and says whether it stopped; close lets the child end without cutting the turn", async () => {
		const mailbox = fakeMailbox();
		const runtime = headlessRuntime(mailbox.port);
		mailbox.busy.add(origin);
		const stopped = await runtime.interrupt(row);
		expect(stopped).toMatchObject({ confirmed: true, status: "idle" });
		expect(mailbox.calls.paused).toEqual([origin]);
		mailbox.calls.pauseBusy = true;
		expect(await runtime.interrupt(row)).toMatchObject({ confirmed: false, status: "working" });
		expect(await runtime.close(row)).toEqual({ ok: true });
		expect(mailbox.calls.stopped).toEqual([origin]);
	});

	test("runtimeFor picks by the row: headless needs the port, herdr rows never touch it", () => {
		const mailbox = fakeMailbox();
		const options = { herdr: () => ({}) };
		expect(() => runtimeFor(row, options)).toThrow("Mailbox 포트가 없습니다");
		const headless = runtimeFor(row, { ...options, headless: mailbox.port });
		expect(headless).toBeDefined();
		const herdrRow = { ...row, runtime: "herdr" as const };
		expect(runtimeFor(herdrRow, options)).toBeDefined();
	});

	test("AC-7: a herdr agy row's status, follow-up and close go to herdr even with the headless port", async () => {
		const mailbox = fakeMailbox();
		const calls: string[] = [];
		const run = async (cmd: string[]) => {
			calls.push(cmd.slice(1, 3).join(" "));
			return {
				code: 0,
				stdout: JSON.stringify({ result: { agents: [{ name: row.agent, status: "idle" }] } }),
				timedOut: false,
			};
		};
		const agyRow = { ...row, runtime: "herdr" as const, workerModel: "agy:gemini-4-hydrogen-high" };
		const runtime = runtimeFor(agyRow, { herdr: () => ({ run }), headless: mailbox.port });
		await runtime.status(agyRow);
		await runtime.prompt(agyRow, "다음");
		await runtime.close(agyRow);
		expect(calls.some((call) => call.startsWith("agent"))).toBe(true);
		expect(calls.length).toBeGreaterThanOrEqual(3);
		expect(mailbox.calls.routed).toEqual([]);
		expect(mailbox.calls.stopped).toEqual([]);
		expect(mailbox.calls.ensured).toEqual([]);
	});
});
