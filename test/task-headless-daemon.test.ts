import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { CONTINUE_PROMPT } from "../src/daemon/recovery";
import { DiscordCallError } from "../src/discord/transport";
import { isTaskOrigin, taskOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { clearFreeze, writeFreeze } from "../src/ops/freeze";
import { redact } from "../src/redact";
import type { TaskRow } from "../src/tasks/ledger";
import { discordBinding, makeHome, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";
import { git, makeRepo } from "./helpers/git-fixtures";

/** The owner's DM origin and the thread (starter message) the [TASK] cards land in. */
const DM = `discord/dm/${OWNER_DM}`;
const THREAD = `${OWNER_DM}:400000000000000001`;
const SPEC = {
	title: "로그 회전",
	risk: "L1",
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다"],
	background: "배경",
};
const signal = new AbortController().signal;

/** A fake worker child that wakes the rig's waiters on every prompt, steer and final. */
class NotifyingDriver extends FakeOmpDriver {
	constructor(
		private readonly checks: ReadonlySet<() => void>,
		options: ConstructorParameters<typeof FakeOmpDriver>[0],
	) {
		super(options);
		this.onFinal(() => this.#wake());
	}
	/** How many times the daemon stopped this child (`stopWhenIdle` ends a closed task's worker). */
	stops = 0;
	override async stop(): Promise<void> {
		this.stops += 1;
		await super.stop();
		this.#wake();
	}
	override async abort(): Promise<void> {
		await super.abort();
		this.#wake();
	}
	#wake(): void {
		for (const check of [...this.checks]) check();
	}
	override prompt(...args: Parameters<FakeOmpDriver["prompt"]>): ReturnType<FakeOmpDriver["prompt"]> {
		const opRef = super.prompt(...args);
		void opRef.then(() => this.#wake());
		return opRef;
	}
	override async steer(text: string): Promise<void> {
		await super.steer(text);
		this.#wake();
	}
}

interface Rig {
	daemon: Daemon;
	/** Every argv the daemon handed to its herdr runner (the runner throws: any entry is a violation). */
	herdrCalls: string[][];
	/** The latest fake omp child per origin key. */
	drivers: Map<string, NotifyingDriver>;
	/** Moves the daemon's clock (sweeper ages, pending-retry ages) forward without waiting. */
	advance(ms: number): void;
	/** How many drivers the factory built per origin key. */
	built: Map<string, number>;
	lines: string[];
	transport: WaitingDiscordTransport;
	repo: string;
	/** Registers a local [TASK] through the daemon's own `jabbu_dispatch` tool. */
	register(task?: string): Promise<TaskRow>;
	/** One `jabbu_dispatch` call of the owner's DM session; resolves with the tool's reply text. */
	dispatch(args: Record<string, unknown>): Promise<string>;
	/** Resolves once `done()` holds, re-checked at every daemon log line and fake-driver call (bounded, no polling). */
	until(done: () => boolean, timeoutMs?: number): Promise<void>;
}

describe("headless [TASK] workers in a daemon without herdr", () => {
	let home: TestHome;
	const repos: string[] = [];
	const daemons: Daemon[] = [];
	const held: FakeOmpDriver[] = [];
	const sessions = new FakeSessionStore();

	beforeEach(() => {
		home = makeHome("jabbu-task-headless-");
	});
	afterEach(async () => {
		for (const driver of held.splice(0)) driver.release(); // a held turn would keep `stop()` waiting
		for (const daemon of daemons.splice(0)) await daemon.stop();
		for (const repo of repos.splice(0)) {
			for (const sibling of [repo, `${repo}-t-`]) rmSync(sibling, { recursive: true, force: true });
		}
		home.remove();
	});

	/** A daemon on `home` with no herdr config; `respond` is what a fake worker turn answers. */
	async function boot(
		options: { respond?: (prompt: string) => string; hold?: boolean; config?: Partial<TestHome["config"]> } = {},
	): Promise<Rig> {
		const lines: string[] = [];
		const herdrCalls: string[][] = [];
		const drivers = new Map<string, NotifyingDriver>();
		const built = new Map<string, number>();
		const transport = new WaitingDiscordTransport();
		const checks = new Set<() => void>();
		let skew = 0;
		const clock = { now: () => Date.now() + skew };
		const daemon = new Daemon({
			...daemonTestOptions(),
			herdrRun: async (cmd) => {
				herdrCalls.push(cmd);
				throw new Error(`herdr must not run: ${cmd.join(" ")}`);
			},
			config: { ...home.config, ...options.config },
			channels: [discordBinding(transport)],
			clock,
			log: createLogger({
				sink: (line) => {
					lines.push(line);
					for (const check of [...checks]) check();
				},
				clock,
				redact,
			}),
			ompVersion: "omp-test 0",
			bootId: "boot-task-headless",
			// The [TASK] start gate (memory·disk) never depends on this machine: CI runners refuse on their own numbers.
			taskSweepMs: 0,
			gateSweepMs: 0,
			pendingRetryMs: 1,
			stopDrainMs: 250, // a held fake turn must not outwait `stop()` (the restart tests stop a daemon mid-turn)
			sweepMs: 3_600_000, // sweeps are driven by the test
			driverFactory: (origin, sessionDir) => {
				const driver = new NotifyingDriver(checks, {
					sessionDir,
					store: sessions,
					...(options.respond === undefined ? {} : { respond: options.respond }),
					...(options.hold === true ? { holdTurns: true } : {}),
				});
				drivers.set(origin, driver);
				held.push(driver);
				built.set(origin, (built.get(origin) ?? 0) + 1);
				return driver;
			},
		});
		daemons.push(daemon);
		await daemon.start();
		const repo = makeRepo(repos);
		// The daemon's own git commits the task docs in the worktree with the host's config; a CI runner has no identity,
		// so the repository carries one (worktrees share it).
		git(repo, "config", "user.name", "jabbu fixture");
		git(repo, "config", "user.email", "fixture@jabbu.invalid");
		const rig: Rig = {
			daemon,
			herdrCalls,
			drivers,
			advance: (ms) => {
				skew += ms;
			},
			built,
			lines,
			transport,
			repo,
			until(done, timeoutMs = 10_000) {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				const check = () => {
					if (!done()) return;
					clearTimeout(timer);
					checks.delete(check);
					resolve();
				};
				const timer = setTimeout(() => {
					checks.delete(check);
					reject(new Error(`timed out; log so far:\n${lines.join("\n")}`));
				}, timeoutMs);
				checks.add(check);
				check();
				return promise;
			},
			async register(task = "회전을 구현해") {
				const store = daemon.store;
				store.ensureOrigin(DM, join(home.dir, "sessions", "dm"));
				store.recordInbound({ originKey: DM, platformMessageId: "dm:1", textRef: "요청", threadRef: THREAD });
				const reply = await rig.dispatch({ taskSpec: { ...SPEC, repo }, task });
				const row = store.tasks.list().at(-1);
				if (row === undefined) throw new Error(`no task registered: ${reply}`);
				return row;
			},
			dispatch(args) {
				const tool = daemon.hostToolsFor(DM).find((t) => t.name === "jabbu_dispatch");
				if (tool === undefined) throw new Error("no jabbu_dispatch tool");
				return tool.execute(args, { signal });
			},
		};
		return rig;
	}

	test("AC-1: a daemon without herdr registers a local taskSpec as a headless row on jabbu/task/<agent> and sends the start prompt once — herdr runs zero times", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		expect(row.runtime).toBe("headless");
		const origin = taskOriginKey(row.agent);
		expect(origin).toBe(`jabbu/task/${row.agent}`);
		expect(isTaskOrigin(origin)).toBe(true);
		expect(rig.daemon.store.getOrigin(origin)).toBeDefined();
		// The start prompt is one inbound row of the task origin, and the worker child got it as its only turn.
		await rig.until(() => rig.drivers.get(origin)?.calls.some((c) => c.startsWith("prompt:")) === true);
		const inbound = rig.daemon.store.listInbound({}).filter((r) => r.originKey === origin);
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.platformMessageId).toStartWith(`task:${row.agent}:start:`);
		expect(inbound[0]?.threadRef).toBe(`task:${row.taskId}`);
		expect(rig.drivers.get(origin)?.calls.filter((c) => c.startsWith("prompt:"))).toHaveLength(1);
		expect(rig.drivers.get(origin)?.calls.find((c) => c.startsWith("prompt:"))).toContain(
			`너는 ${row.taskId} 담당이다`,
		);
		expect(rig.herdrCalls).toEqual([]);
		// The worker runs in the task's own worktree, not the bot workspace.
		expect(rig.daemon.cwdFor(origin)).toBe(row.worktree);
		expect(existsSync(row.worktree)).toBe(true);
	});

	test("AC-3: a task origin has no jabbu host tools and no dialog answerer — its child can neither dispatch nor ask the owner", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		expect(rig.daemon.hostToolsFor(DM).map((t) => t.name)).toContain("jabbu_dispatch"); // the owner's own session has them
		expect(rig.daemon.hostToolsFor(origin)).toEqual([]);
		expect(rig.daemon.answerDialogsFor(origin)).toBeUndefined();
		expect(rig.daemon.cwdFor(origin)).toBe(row.worktree);
	});

	/** The prompts and steers the worker child of `origin` received, in order. */
	const received = (rig: Rig, origin: string): string[] =>
		(rig.drivers.get(origin)?.calls ?? []).filter((c) => c.startsWith("prompt:") || c.startsWith("steer:"));
	const inboundOf = (rig: Rig, origin: string) =>
		rig.daemon.store.listInbound({}).filter((r) => r.originKey === origin);
	/** Resolves once the start turn of a non-held worker has ended (its answer row closed, nothing left running). */
	const startTurnEnded = (rig: Rig, origin: string) =>
		rig.until(
			() =>
				rig.lines.some((l) => l.includes("event=task_turn_output_dropped")) &&
				inboundOf(rig, origin).every((r) => r.state === "answered"),
		);
	const sweepLines = (rig: Rig, event: string) => rig.lines.filter((l) => l.includes(`event=${event} `));

	test("AC-2 sweeper status: a worker in a turn is working — the 30-minute reminder is deferred and nothing reaches the child", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await rig.until(() => received(rig, origin).length === 1);
		rig.advance(31 * 60_000);
		await rig.daemon.sweepTasks();
		expect(sweepLines(rig, "task_remind_deferred")).toHaveLength(1);
		expect(sweepLines(rig, "task_remind_deferred")[0]).toContain(`task=${row.taskId}`);
		expect(sweepLines(rig, "task_remind_deferred")[0]).toContain("agentStatus=working");
		expect(received(rig, origin)).toHaveLength(1); // the start prompt only: a working child is not interrupted
		expect(inboundOf(rig, origin)).toHaveLength(1);
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 sweeper status: an idle worker gets the 30-minute reminder as a follow-up row on the same origin", async () => {
		const rig = await boot({ respond: () => "단계를 진행했습니다" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		rig.advance(31 * 60_000);
		await rig.daemon.sweepTasks();
		await rig.until(() => received(rig, origin).length === 2);
		expect(received(rig, origin)[1]).toContain("PROGRESS.md");
		const rows = inboundOf(rig, origin);
		expect(rows).toHaveLength(2);
		expect(rows[1]?.platformMessageId).toStartWith(`task:${row.agent}:followup:`);
		expect(rows[1]?.threadRef).toBe(`task:${row.taskId}`);
		expect(rig.built.get(origin)).toBe(1); // the same child, not a new one
		expect(sweepLines(rig, "task_remind_deferred")).toEqual([]);
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 sweeper status: an origin that is gone is LOST — one notice, no reminder to any child", async () => {
		const rig = await boot({ respond: () => "끝" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		const db = new Database(join(home.dir, "jabbu.db"));
		try {
			db.run("DELETE FROM inbound WHERE origin_key = ?", [origin]);
			db.run("DELETE FROM origins WHERE origin_key = ?", [origin]);
		} finally {
			db.close();
		}
		rig.advance(31 * 60_000);
		await rig.daemon.sweepTasks();
		await rig.transport.waitForPosts((text) => text.includes("에이전트 없음"));
		expect(received(rig, origin)).toHaveLength(1);
		expect(rig.daemon.store.tasks.require(row.taskId).status).toBe("working"); // LOST is a notice, not a transition
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 sweeper status: PROGRESS.md status blocked moves the headless task to blocked", async () => {
		const rig = await boot({ respond: () => "막혔습니다" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		const progress = join(row.docsDir, "PROGRESS.md");
		const text = readFileSync(progress, "utf8");
		expect(text).toContain("status: working");
		// `needs_owner: yes` skips the one retry prompt a plain block gets first: the block is the owner's to decide.
		writeFileSync(
			progress,
			text
				.replace("status: working", "status: blocked")
				.replace(/blocked_reason:.*/, "blocked_reason: 승인 필요")
				.replace(/needs_owner:.*/, "needs_owner: yes"),
		);
		await rig.daemon.sweepTasks();
		expect(rig.daemon.store.tasks.require(row.taskId).status).toBe("blocked");
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 follow-up: taskSpec:{id} resumes the task as one more row on the same origin and the same child", async () => {
		const rig = await boot({ respond: () => "받았습니다" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		const reply = await rig.dispatch({ taskSpec: { id: row.taskId }, task: "AC-2부터 이어서 해" });
		expect(reply).toContain("재개 프롬프트를 보냈습니다");
		await rig.until(() => received(rig, origin).length === 2);
		expect(received(rig, origin)[1]).toContain("AC-2부터 이어서 해");
		const rows = inboundOf(rig, origin);
		expect(rows.map((r) => r.platformMessageId.split(":")[2])).toEqual(["start", "followup"]);
		expect(rows[1]?.originKey).toBe(origin);
		expect(rig.built.get(origin)).toBe(1);
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 follow-up and progress: {mode:'worker', name, task} steers the child; {mode:'worker', name} returns the session's last answer and the ▸ T-… summary line", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await rig.until(() => received(rig, origin).length === 1);
		// A turn is running: the follow-up becomes a steer of that turn, on the same origin.
		const sent = await rig.dispatch({ mode: "worker", name: row.agent, task: "테스트도 추가해" });
		expect(sent).toContain(`진행 확인: jabbu_dispatch {mode:"worker", name:"${row.agent}"}`);
		await rig.until(() => received(rig, origin).length === 2);
		expect(received(rig, origin)[1]).toBe("steer:테스트도 추가해");
		expect(inboundOf(rig, origin).map((r) => r.platformMessageId.split(":")[2])).toEqual(["start", "followup"]);
		// The progress read: the origin's session file (what omp writes) and the judged PROGRESS.md line.
		const dir = rig.daemon.store.getOrigin(origin)?.sessionDir ?? "";
		mkdirSync(dir, { recursive: true });
		const answer = `회전 로직을 ${"x".repeat(5)} 구현했습니다`;
		writeFileSync(
			join(dir, "s1.jsonl"),
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } })}\n`,
		);
		const read = await rig.dispatch({ mode: "worker", name: row.agent });
		expect(read).toStartWith(`▸ ${row.agent} 최근 출력:\n${answer}`);
		expect(read).toMatch(new RegExp(`\\n▸ ${row.taskId} AC \\d+/\\d+ `));
		expect(read).toContain(" · working · ");
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 owner stop: pause aborts the child's turn and holds queued rows; resume releases them", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await rig.until(() => received(rig, origin).length === 1);
		const driver = rig.drivers.get(origin);
		const paused = await rig.daemon.controlTask(row.taskId, "pause");
		expect(paused.ok).toBe(true);
		expect(driver?.calls).toContain("abort");
		expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(true);
		expect(sweepLines(rig, "task_interrupt")[0]).toContain("confirmed=true");
		// A row that arrives for the paused task waits: not even the pending-retry sweep starts it.
		rig.daemon.store.recordInbound({
			originKey: origin,
			platformMessageId: `task:${row.agent}:followup:held`,
			textRef: "멈춘 사이 온 후속",
			threadRef: `task:${row.taskId}`,
		});
		// Past `PENDING_ALERT_AFTER` sweeps: a retry of the held row would count as a failed one and alert the owner.
		for (let sweep = 0; sweep < 6; sweep++) {
			rig.advance(60_000);
			await rig.daemon.sweep();
		}
		expect(rig.lines.filter((l) => l.includes("event=pending_dispatch_notified"))).toEqual([]);
		expect(rig.transport.posts((text) => text.includes(origin))).toEqual([]);
		expect(rig.daemon.store.getInbound(`task:${row.agent}:followup:held`)?.state).toBe("pending");
		expect(received(rig, origin)).toHaveLength(1);
		const resumed = await rig.daemon.controlTask(row.taskId, "resume");
		expect(resumed.ok).toBe(true);
		await rig.until(() => received(rig, origin).some((c) => c.includes("멈춘 사이 온 후속")));
		expect(rig.daemon.store.getInbound(`task:${row.agent}:followup:held`)?.state).not.toBe("pending");
		expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(false);
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 close: `tasks close` (IPC tasks_sync) stops an idle worker once, herdr never runs", async () => {
		const rig = await boot({ respond: () => "끝" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		const driver = rig.drivers.get(origin);
		expect(driver?.stops).toBe(0);
		rig.daemon.store.tasks.transition(row.taskId, "done", "human", "close");
		expect(await callDaemon(rig.daemon.socketPath, { op: "tasks_sync", id: row.taskId })).toMatchObject({ ok: true });
		await rig.until(() => (driver?.stops ?? 0) >= 1);
		expect(driver?.stops).toBe(1);
		expect(rig.herdrCalls).toEqual([]);
	});

	test("AC-2 close: closing a worker that is mid-turn does not cut the turn; the child stops when the turn ends", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await rig.until(() => received(rig, origin).length === 1);
		const driver = rig.drivers.get(origin);
		rig.daemon.store.tasks.transition(row.taskId, "cancelled", "human", "close");
		expect(await callDaemon(rig.daemon.socketPath, { op: "tasks_sync", id: row.taskId })).toMatchObject({ ok: true });
		expect(driver?.stops).toBe(0);
		expect(driver?.calls).not.toContain("abort");
		driver?.release();
		await rig.until(() => (driver?.stops ?? 0) >= 1);
		expect(driver?.stops).toBe(1);
		expect(rig.herdrCalls).toEqual([]);
	});

	/** The user turns the fake session of `sessionDir` recorded, in order (what the worker's omp saw). */
	const userTurns = (sessionDir: string): string[] =>
		(sessions.sessions.get(sessionDir)?.entries ?? [])
			.filter((e) => e.message?.role === "user")
			.map((e) => JSON.stringify(e.message?.content));

	/**
	 * The planned restart of a daemon whose worker is mid-turn: drain, record the cut turns (restart-cut.json), stop.
	 * `before` runs while the turn still runs (a test closes the task there).
	 */
	async function cutAndStop(rig: Rig, before?: () => void): Promise<void> {
		await rig.until(() => rig.daemon.store.listInbound({ state: "dispatched" }).length > 0); // the turn is recorded
		before?.();
		rig.daemon.setDraining(true);
		expect(await rig.daemon.drainCut("20261125-000000")).toMatchObject({ ok: true, opRefs: 1 });
		await rig.daemon.stop();
	}

	test("AC-4: a worker cut mid-turn by a planned restart resumes in the same session file, with one cut- row and the continue prompt once", async () => {
		const first = await boot({ hold: true });
		const row = await first.register();
		const origin = taskOriginKey(row.agent);
		await first.until(() => received(first, origin).length === 1);
		const sessionDir = first.daemon.store.getOrigin(origin)?.sessionDir ?? "";
		const sessionId = sessions.sessions.get(sessionDir)?.sessionId;
		expect(sessionId).toBeDefined();
		const started = inboundOf(first, origin)[0];
		await cutAndStop(first);

		const second = await boot({ respond: () => "이어서 했습니다" });
		await second.until(() => second.lines.some((l) => l.includes("event=recovery_continued")));
		await second.until(() => second.lines.some((l) => l.includes("event=task_turn_output_dropped")));
		const cut = inboundOf(second, origin).filter((r) => r.platformMessageId.startsWith("cut-"));
		expect(cut.map((r) => r.platformMessageId)).toEqual([`cut-${started?.platformMessageId}`]);
		expect(cut[0]?.textRef).toStartWith(CONTINUE_PROMPT);
		expect(cut[0]?.threadRef).toBe(`task:${row.taskId}`);
		// The new process's child opened the same session (same dir, same session id) and got the prompt once.
		expect(second.drivers.get(origin)?.calls).toContain("openSession");
		expect(sessions.sessions.get(sessionDir)?.sessionId).toBe(sessionId);
		const resumePrompts = received(second, origin).filter((c) => c.startsWith(`prompt:${CONTINUE_PROMPT}`));
		expect(resumePrompts).toHaveLength(1);
		expect(received(second, origin)).toHaveLength(1);
		expect(userTurns(sessionDir)).toHaveLength(2); // the start prompt and the resume prompt: one session
		expect(second.lines.filter((l) => l.includes("event=recovery_continued"))).toHaveLength(1);
		expect(second.herdrCalls).toEqual([]);
	});

	for (const closed of ["done", "cancelled"] as const) {
		test(`AC-4: a ${closed} task's cut turn is not resumed — no cut- row, no child, no notice`, async () => {
			const first = await boot({ hold: true });
			const row = await first.register();
			const origin = taskOriginKey(row.agent);
			await first.until(() => received(first, origin).length === 1);
			await cutAndStop(first, () => first.daemon.store.tasks.transition(row.taskId, closed, "human", "close"));

			const second = await boot({ respond: () => "이어서" });
			await second.until(() => second.lines.some((l) => l.includes("event=recovery_interrupted")));
			expect(second.lines.filter((l) => l.includes("event=recovery_continued"))).toEqual([]);
			expect(inboundOf(second, origin).filter((r) => r.platformMessageId.startsWith("cut-"))).toEqual([]);
			expect(inboundOf(second, origin)[0]?.state).toBe("failed_notified");
			// Recovery's own reader child may exist, but no turn starts and no prompt goes to any child.
			expect(second.lines.filter((l) => l.includes(`event=turn_start origin=${origin} `))).toEqual([]);
			expect(received(second, origin)).toEqual([]);
			expect(second.daemon.store.listDeliveries({ originKey: origin })).toEqual([]);
			expect(second.herdrCalls).toEqual([]);
		});
	}

	test("AC-4: a frozen bot holds the resume prompt; the first sweep after the unfreeze sends it once", async () => {
		const first = await boot({ hold: true });
		const row = await first.register();
		const origin = taskOriginKey(row.agent);
		await first.until(() => received(first, origin).length === 1);
		await cutAndStop(first);

		const realNow = Date.now;
		let probeNow = realNow();
		Date.now = () => probeNow; // the freeze probe captures Date.now at construction: a fake crosses its cache window
		try {
			writeFreeze(home.dir, { reason: "hold", by: "cli", now: probeNow });
			const second = await boot({ respond: () => "이어서 했습니다" });
			await second.until(() => second.lines.some((l) => l.includes("event=recovery_continued")));
			second.advance(60_000);
			await second.daemon.sweep();
			// Pause and resume run on the origin's serial chain, behind every dispatch attempt made so far (the boot's, the
			// sweep's): once they settle, a row that was not held would have started its turn. The resume's own drain is held too.
			expect((await second.daemon.controlTask(row.taskId, "pause")).ok).toBe(true);
			expect((await second.daemon.controlTask(row.taskId, "resume")).ok).toBe(true);
			const cut = inboundOf(second, origin).filter((r) => r.platformMessageId.startsWith("cut-"));
			expect(cut).toHaveLength(1);
			expect(cut[0]?.state).toBe("pending");
			expect(received(second, origin)).toEqual([]);
			expect(second.lines.filter((l) => l.includes(`event=turn_start origin=${origin} `))).toEqual([]);

			clearFreeze(home.dir);
			probeNow += 3_000;
			second.advance(3_000);
			await second.daemon.sweep();
			await second.until(() => received(second, origin).length === 1);
			expect(received(second, origin)[0]).toStartWith(`prompt:${CONTINUE_PROMPT}`);
			await second.until(() => inboundOf(second, origin).every((r) => r.state !== "pending"));
			expect(received(second, origin)).toHaveLength(1);
		} finally {
			Date.now = realNow;
		}
	});

	test("AC-4: the answer of a task turn leaves no delivery row — the text is dropped with one log line", async () => {
		const rig = await boot({ respond: () => "구현 결과를 길게 설명하는 답" });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await startTurnEnded(rig, origin);
		expect(inboundOf(rig, origin)[0]?.state).toBe("answered");
		expect(rig.daemon.store.listDeliveries({ originKey: origin })).toEqual([]);
		expect(rig.lines.filter((l) => l.includes("event=task_turn_output_dropped"))).toHaveLength(1);
		expect(rig.transport.posts((text) => text.includes("구현 결과"))).toEqual([]);
	});

	test("AC-4: a failed task turn leaves no delivery row and no failure notice in any chat", async () => {
		const rig = await boot({ hold: true });
		const row = await rig.register();
		const origin = taskOriginKey(row.agent);
		await rig.until(() => received(rig, origin).length === 1);
		rig.drivers.get(origin)?.crash(1);
		await rig.until(() => rig.lines.some((l) => l.includes("event=turn_failed")));
		expect(inboundOf(rig, origin)[0]?.state).toBe("failed_notified");
		expect(rig.daemon.store.listDeliveries({ originKey: origin })).toEqual([]);
		expect(rig.transport.posts((text) => text.includes("[turn failed]"))).toEqual([]);
		expect(rig.herdrCalls).toEqual([]);
	});

	describe("dashboard 작업 내역 (IPC task_followup · tasks_pause/resume source web)", () => {
		type Answer = { ok: boolean; text?: string; error?: string; paused?: boolean };
		const ipc = (rig: Rig, request: Record<string, unknown>) =>
			callDaemon(rig.daemon.socketPath, request) as Promise<Answer>;
		/** The newest kept prompt preview of `agent` (`herdr_prompts`, what the dashboard's 마지막 지시 shows). */
		const lastPreview = (agent: string): string | undefined => {
			const db = new Database(join(home.dir, "jabbu.db"), { readonly: true });
			try {
				return db
					.query<{ preview: string }, [string]>(
						"SELECT preview FROM herdr_prompts WHERE agent = ? ORDER BY id DESC LIMIT 1",
					)
					.get(agent)?.preview;
			} finally {
				db.close();
			}
		};

		test("AC-2·AC-4: a web follow-up mid-turn steers the child through followupTask; the record preview starts '[웹] ' and the thread gets the redacted first 80 characters", async () => {
			const rig = await boot({ hold: true });
			const row = await rig.register();
			const origin = taskOriginKey(row.agent);
			await rig.until(() => received(rig, origin).length === 1);
			const text = `토큰 xoxb-TEST-0 은 빼고\n${"가".repeat(100)}`;
			const answer = await ipc(rig, { op: "task_followup", id: row.taskId, text });
			expect(answer.ok).toBe(true);
			expect(answer.text).toContain(`후속 지시를 ${row.agent}에 전달했습니다`);
			await rig.until(() => received(rig, origin).length === 2);
			expect(received(rig, origin)[1]).toStartWith("steer:토큰");
			expect(inboundOf(rig, origin).map((r) => r.platformMessageId.split(":")[2])).toEqual(["start", "followup"]);
			expect(sweepLines(rig, "dispatch_prompted").at(-1)).toContain("source=web");
			expect(lastPreview(row.agent)).toStartWith("[웹] ");
			const lead = `🌐 웹에서 ${row.taskId} 지시 넣음: `;
			await rig.transport.waitForPosts((t) => t.startsWith(lead));
			const [notice] = rig.transport.posts((t) => t.startsWith(lead));
			const quoted = (notice?.content ?? "").slice(lead.length);
			expect(quoted).toBe(redact(text).replace(/\s+/g, " ").trim().slice(0, 80));
			expect(quoted).not.toContain("xoxb-TEST-0");
			expect(rig.herdrCalls).toEqual([]);
		});

		test("AC-2·AC-3·AC-4: a web pause holds the task (source=web logged, thread told); a web follow-up then lifts the hold and goes in", async () => {
			const rig = await boot({ hold: true });
			const row = await rig.register();
			const origin = taskOriginKey(row.agent);
			await rig.until(() => received(rig, origin).length === 1);
			const paused = await ipc(rig, { op: "tasks_pause", id: row.taskId, source: "web" });
			expect(paused.ok).toBe(true);
			expect(paused.paused).toBe(true);
			expect(paused.text).toStartWith(`⏸ ${row.taskId} 멈췄습니다`);
			expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(true);
			expect(sweepLines(rig, "task_paused")[0]).toContain("source=web");
			expect(sweepLines(rig, "task_interrupt")[0]).toContain("confirmed=true");
			expect(sweepLines(rig, "task_interrupt")[0]).toContain("source=web");
			await rig.transport.waitForPosts((t) => t === `🌐 웹에서 ${row.taskId} 멈춤`);
			const sent = await ipc(rig, { op: "task_followup", id: row.taskId, text: "멈춘 뒤 이어서 해" });
			expect(sent.ok).toBe(true);
			expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(false);
			await rig.until(() => received(rig, origin).some((c) => c.includes("멈춘 뒤 이어서 해")));
		});

		test("AC-3·AC-4: a web resume goes through controlTask (hold lifted, source=web, thread told); a chat pause logs no source", async () => {
			const rig = await boot({ respond: () => "받았습니다" });
			const row = await rig.register();
			const origin = taskOriginKey(row.agent);
			await startTurnEnded(rig, origin);
			// The idle worker: the pause's answer still says the turn was stopped (nothing ran), not a bare sweep hold.
			const paused = await ipc(rig, { op: "tasks_pause", id: row.taskId });
			expect(paused.text).toStartWith(`⏸ ${row.taskId} 멈췄습니다`);
			expect(paused.text).toContain("턴을 멈췄습니다(헤드리스)");
			expect(sweepLines(rig, "task_paused")[0]).not.toContain("source=");
			const resumed = await ipc(rig, { op: "tasks_resume", id: row.taskId, source: "web" });
			expect(resumed).toMatchObject({ ok: true, paused: false });
			expect(resumed.text).toStartWith(`▶ ${row.taskId} 재개했습니다`);
			expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(false);
			expect(sweepLines(rig, "task_resumed")[0]).toContain("source=web");
			await rig.transport.waitForPosts((t) => t === `🌐 웹에서 ${row.taskId} 재개`);
			// A second resume changes nothing: answered, but the thread is not told again.
			expect((await ipc(rig, { op: "tasks_resume", id: row.taskId, source: "web" })).text).toContain(
				"멈춘 상태가 아닙니다",
			);
			expect(rig.transport.posts((t) => t === `🌐 웹에서 ${row.taskId} 재개`)).toHaveLength(1);
		});

		test("AC-3: a web pause of a task that is not working or blocked is refused; nothing is held or told", async () => {
			const rig = await boot({ respond: () => "받았습니다" });
			const row = await rig.register();
			await startTurnEnded(rig, taskOriginKey(row.agent));
			rig.daemon.store.tasks.transition(row.taskId, "review", "bot");
			const answer = await ipc(rig, { op: "tasks_pause", id: row.taskId, source: "web" });
			expect(answer).toMatchObject({ ok: false, error: "task_control_refused" });
			expect(answer.text).toContain("working·blocked만 멈춥니다");
			expect(rig.daemon.store.tasks.isPaused(rig.daemon.store.tasks.require(row.taskId))).toBe(false);
			expect(rig.transport.posts((t) => t.startsWith("🌐"))).toEqual([]);
		});

		test("AC-2: empty, blank, control-character, over-64KB, unknown, closed and herdr follow-ups are refused before any row", async () => {
			const rig = await boot({ respond: () => "받았습니다" });
			const row = await rig.register();
			const origin = taskOriginKey(row.agent);
			await startTurnEnded(rig, origin);
			const refuse = async (request: Record<string, unknown>, error: string) =>
				expect(await ipc(rig, { op: "task_followup", ...request })).toMatchObject({ ok: false, error });
			await refuse({ id: row.taskId, text: "" }, "empty_text");
			await refuse({ id: row.taskId, text: " \n\t " }, "empty_text");
			await refuse({ id: row.taskId }, "empty_text");
			await refuse({ id: row.taskId, text: "하나\u0007둘" }, "control_chars");
			await refuse({ id: row.taskId, text: "하나\r\n둘" }, "control_chars");
			await refuse({ id: row.taskId, text: "x".repeat(64 * 1024 + 1) }, "text_too_long");
			await refuse({ id: "T-20990101-01", text: "이어서" }, "task_not_found");
			const herdr = rig.daemon.store.tasks.register({
				title: "herdr 작업",
				risk: "L1",
				originKey: DM,
				threadRef: THREAD,
				host: null,
				repo: rig.repo,
				acceptance: [],
			});
			await refuse({ id: herdr.taskId, text: "이어서" }, "herdr_task");
			expect(await ipc(rig, { op: "tasks_pause", id: herdr.taskId, source: "web" })).toMatchObject({
				ok: false,
				error: "herdr_task",
			});
			rig.daemon.store.tasks.transition(row.taskId, "done", "human", "close");
			await refuse({ id: row.taskId, text: "이어서" }, "task_closed");
			expect(inboundOf(rig, origin)).toHaveLength(1);
			expect(rig.transport.posts((t) => t.startsWith("🌐"))).toEqual([]);
			expect(rig.herdrCalls).toEqual([]);
		});

		test("AC-4: a failed thread notice changes neither the answer nor the follow-up", async () => {
			const rig = await boot({ hold: true });
			const row = await rig.register();
			const origin = taskOriginKey(row.agent);
			await rig.until(() => received(rig, origin).length === 1);
			rig.transport.failNext.createMessage = [new DiscordCallError("definitive", "discord_http_403", 403, 50001)];
			const answer = await ipc(rig, { op: "task_followup", id: row.taskId, text: "알림 실패여도 넣어" });
			expect(answer.ok).toBe(true);
			expect(answer.text).toContain(`후속 지시를 ${row.agent}에 전달했습니다`);
			await rig.until(() => sweepLines(rig, "task_web_notice_failed").length === 1);
			await rig.until(() => received(rig, origin).length === 2);
			expect(received(rig, origin)[1]).toBe("steer:알림 실패여도 넣어");
		});

		test("AC-2: while frozen a web follow-up is kept pending and the answer says it waits", async () => {
			const realNow = Date.now;
			let probeNow = realNow();
			Date.now = () => probeNow; // the freeze probe captures Date.now at construction: a fake crosses its cache window
			try {
				const rig = await boot({ respond: () => "받았습니다" });
				const row = await rig.register();
				const origin = taskOriginKey(row.agent);
				await startTurnEnded(rig, origin);
				writeFreeze(home.dir, { reason: "hold", by: "cli", now: probeNow });
				probeNow += 3_000;
				const answer = await ipc(rig, { op: "task_followup", id: row.taskId, text: "동결 중 지시" });
				expect(answer.ok).toBe(true);
				expect(answer.text).toContain("동결 중이라 대기합니다");
				const followup = inboundOf(rig, origin).find((r) => r.platformMessageId.includes(":followup:"));
				expect(followup?.state).toBe("pending");
				expect(received(rig, origin)).toHaveLength(1);
				clearFreeze(home.dir);
			} finally {
				Date.now = realNow;
			}
		});
	});
});
