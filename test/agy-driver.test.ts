import { Database } from "bun:sqlite";
import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { STALL_MS } from "../src/core/types";
import { createLogger, type Logger } from "../src/log";
import { AgyOmpDriver, parseAgyModels } from "../src/omp/agy-driver";
import {
	AGY_TOOL_KEEPALIVE_EVENT,
	AGY_TOOL_KEEPALIVE_INTERVAL_MS,
	AGY_TOOL_KEEPALIVE_MAX_MS,
	AgyToolKeepalive,
	type AgyToolKeepaliveOptions,
} from "../src/omp/agy-tool-keepalive";
import { turnAnswerParts } from "../src/omp/answers";
import { OmpDriverError, type OmpEvent, type OmpExitInfo, type OmpFinal } from "../src/omp/driver";
import { redact } from "../src/redact";

const tempDirs: string[] = [];
const FAKE_SCRIPT = join(import.meta.dir, "helpers", "fake-agy.ts");
const BUN = process.execPath;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogEntry {
	dir: string;
	argv?: string[];
	frame?: { event?: string; message?: { content?: string } };
}

interface Harness {
	root: string;
	executable: string;
	workspace: string;
	sessionDir: string;
	logFile: string;
	make(options?: {
		model?: string;
		thinking?: string;
		systemPrompt?: string;
		env?: Record<string, string>;
		log?: Logger;
		toolKeepalive?: AgyToolKeepaliveOptions;
	}): AgyOmpDriver;
	readLog(): LogEntry[];
}

function makeHarness(): Harness {
	const root = tempDir("ompbot-agy-");
	const workspace = join(root, "workspace");
	const sessionDir = join(root, "sessions", "e1");
	const executable = join(root, "bin", "agy");
	mkdirSync(join(root, "bin"));
	writeFileSync(executable, `#!/bin/sh\nexec "${BUN}" "${FAKE_SCRIPT}" "$@"\n`);
	chmodSync(executable, 0o755);
	const logFile = join(root, "fake-agy.log");
	return {
		root,
		executable,
		workspace,
		sessionDir,
		logFile,
		make: (options = {}) =>
			new AgyOmpDriver({
				agyExecutable: executable,
				cwd: workspace,
				sessionDir,
				...(options.model === undefined ? {} : { model: options.model }),
				...(options.thinking === undefined ? {} : { thinking: options.thinking }),
				...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
				...(options.log === undefined ? {} : { log: options.log, originKey: "discord/ch/C1/t/T1" }),
				...(options.toolKeepalive === undefined ? {} : { toolKeepalive: options.toolKeepalive }),
				env: { FAKE_AGY_LOG: logFile, ...(options.env ?? {}) },
				baseEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				startupTimeoutMs: 10_000,
			}),
		readLog: () =>
			readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LogEntry),
	};
}

function nextFinal(driver: AgyOmpDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

function nextEvent(driver: AgyOmpDriver, match: (event: OmpEvent) => boolean): Promise<OmpEvent> {
	const { promise, resolve } = Promise.withResolvers<OmpEvent>();
	const off = driver.onEvent((event) => {
		if (!match(event)) return;
		off();
		resolve(event);
	});
	return promise;
}

/** Resolves once the fake's log holds an entry `match` accepts (a log write is the fake's event). */
function logged(harness: Harness, match: (entry: LogEntry) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = (): void => {
		const lines = readFileSync(harness.logFile, "utf8").split("\n");
		const found = lines.some((line) => {
			try {
				return match(JSON.parse(line) as LogEntry);
			} catch {
				return false; // empty tail or a line still being appended
			}
		});
		if (!found) return;
		watcher.close();
		resolve();
	};
	const watcher = watch(harness.logFile, check);
	check();
	return promise;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function spawns(harness: Harness): string[][] {
	return harness
		.readLog()
		.filter((entry) => entry.dir === "argv" && entry.argv?.[0] !== "models")
		.map((entry) => entry.argv ?? []);
}

function sentContents(harness: Harness): string[] {
	return harness
		.readLog()
		.filter((entry) => entry.dir === "in" && entry.frame?.event === "user")
		.map((entry) => entry.frame?.message?.content ?? "");
}

const BASE_ARGS = ["--input-format", "stream-json", "--output-format", "stream-json", "-p", ""];

test("start fails fast with agy_executable_missing", async () => {
	const root = tempDir("ompbot-agy-missing-");
	const driver = new AgyOmpDriver({
		agyExecutable: join(root, "no-such-agy"),
		cwd: root,
		sessionDir: join(root, "s"),
		baseEnv: { HOME: root, PATH: "/usr/bin:/bin" },
	});
	const error = await driver.start().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "agy_executable_missing" });
	expect(driver.pid).toBeUndefined();
});

test("one turn completes; entries, usage and the system prompt on the first message only", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-high", systemPrompt: "FLOORS" });
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId.length).toBeGreaterThan(0);
	expect(await driver.leafId()).toBe(null);

	const done = nextFinal(driver);
	const opRef = await driver.prompt("hello");
	expect(await done).toEqual({
		opRef,
		status: "completed",
		text: "REPLY1:hello",
		usage: { calls: 1, input: 100, cacheRead: 40, output: 7, contextTokens: 140, rotated: false },
	});

	const all = await driver.entriesSince();
	expect(all.entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant"]);
	expect(all.entries[0]?.message?.content).toBe("hello");
	expect(all.entries[1]?.message).toMatchObject({
		stopReason: "stop",
		provider: "agy",
		model: "gemini-3.8-flash-high",
		usage: { input: 100, output: 7, cacheRead: 40 },
	});
	expect(all.entries[1]?.message?.usage?.cost).toBeUndefined();
	expect(turnAnswerParts(all.entries)).toEqual(["REPLY1:hello"]);
	const leaf = await driver.leafId();
	expect(leaf).toBe(all.leafId);
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	expect(await driver.entriesSince("nope").catch((e: unknown) => e)).toMatchObject({ code: "unknown_since" });

	// Second turn: same process, conversation continues, no second system prompt.
	const second = nextFinal(driver);
	await driver.prompt("again");
	expect(await second).toMatchObject({ status: "completed", text: "REPLY2:again" });
	expect(sentContents(harness)).toEqual(["FLOORS\n\n---\n\nhello", "again"]);
	expect(spawns(harness)).toEqual([
		[...BASE_ARGS, "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"],
	]);
	expect(await driver.state()).toMatchObject({
		sessionId: opened.sessionId,
		idle: true,
		queuedMessageCount: 0,
		model: "agy/gemini-3.8-flash-high",
		thinking: "high",
	});
	await driver.stop();
});

test("an ERROR result ends the turn as error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@error");
	expect(await done).toEqual({ opRef, status: "error", text: "", error: "boom" });
	expect(await driver.state()).toMatchObject({ idle: true });
	await driver.stop();
});

test("tool steps become toolCall/toolResult entries and tool events", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const toolStart = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const done = nextFinal(driver);
	await driver.prompt("@tool run it");
	expect(await toolStart).toMatchObject({ toolName: "run_command", args: { CommandLine: "echo hi" } });
	await done;
	const { entries } = await driver.entriesSince();
	expect(entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(entries[1]?.message).toMatchObject({
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: "run_command", arguments: { CommandLine: "echo hi" } }],
	});
	expect(entries[2]?.message?.content).toEqual([{ type: "text", text: "hi" }]);
	expect(turnAnswerParts(entries)).toEqual(["REPLY1:@tool run it"]);
	await driver.stop();
});

test("a tool step without output ends with no result and an empty toolResult entry", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const toolEnd = nextEvent(driver, (event) => event.type === "tool_execution_end");
	const done = nextFinal(driver);
	await driver.prompt("@tool @nooutput");
	const end = await toolEnd;
	expect(end).toMatchObject({ toolName: "run_command" });
	expect(end.result).toBeUndefined();
	await done;
	const { entries } = await driver.entriesSince();
	expect(entries[2]?.message?.content).toEqual([{ type: "text", text: "" }]);
	await driver.stop();
});

test("openSession resumes the pointer conversation; newSession starts fresh", async () => {
	const harness = makeHarness();
	const first = harness.make();
	await first.start();
	const opened = await first.openSession();
	const pointer = join(harness.sessionDir, "agy-conversation.json");
	expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({ conversationId: opened.sessionId });
	await first.stop();

	const second = harness.make();
	await second.start();
	expect(await second.openSession()).toEqual({ resumed: true, sessionId: opened.sessionId });
	expect(spawns(harness).at(-1)).toEqual([
		...BASE_ARGS,
		"--conversation",
		opened.sessionId,
		"--dangerously-skip-permissions",
	]);

	await second.newSession();
	const fresh = await second.openSession();
	expect(fresh.resumed).toBe(false);
	expect(fresh.sessionId).not.toBe(opened.sessionId);
	expect(spawns(harness).at(-1)).toEqual([...BASE_ARGS, "--dangerously-skip-permissions"]);
	expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({ conversationId: fresh.sessionId });
	await second.stop();
});

test("a conversation agy no longer knows is not reported as resumed", async () => {
	const harness = makeHarness();
	mkdirSync(harness.sessionDir, { recursive: true });
	writeFileSync(
		join(harness.sessionDir, "agy-conversation.json"),
		`${JSON.stringify({ conversationId: "gone-1234" })}\n`,
	);
	const driver = harness.make({ env: { FAKE_AGY_UNKNOWN_CONVERSATION: "1" } });
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId).not.toBe("gone-1234");
	const pointer = JSON.parse(readFileSync(join(harness.sessionDir, "agy-conversation.json"), "utf8"));
	expect(pointer).toEqual({ conversationId: opened.sessionId });
	await driver.stop();
});

test("switchSession pins and resumes the given conversation id", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	await driver.switchSession("/somewhere/conv-abcdef12.jsonl");
	expect(await driver.openSession()).toEqual({ resumed: true, sessionId: "conv-abcdef12" });
	expect(await driver.switchSession("x").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.stop();
});

test("availableModels runs `agy models` once; setModel and setThinking respawn on the same conversation", async () => {
	expect(parseAgyModels("Fetching available models...\na-high\tA (High)\n\nb\tB\n")).toEqual(["a-high", "b"]);
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-low", thinking: "medium" });
	await driver.start();
	const { sessionId } = await driver.openSession();
	expect(spawns(harness).at(-1)).toContain("gemini-3.8-flash-medium");

	const models = await driver.availableModels();
	expect(models).toEqual([
		"agy/gemini-3.8-flash-high",
		"agy/gemini-3.8-flash-medium",
		"agy/gemini-3.8-flash-low",
		"agy/gpt-oss-120b-medium",
	]);
	expect(await driver.availableModels()).toEqual(models);

	expect(await driver.setModel("agy/nope").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setModel("claude/opus").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setModel("agy/gemini-3.8-flash-high")).toBe("agy/gemini-3.8-flash-high");
	expect(spawns(harness).at(-1)).toEqual([
		...BASE_ARGS,
		"--conversation",
		sessionId,
		"--model",
		"gemini-3.8-flash-high",
		"--dangerously-skip-permissions",
	]);

	expect(await driver.thinkingLevels()).toEqual(["low", "medium", "high"]);
	await driver.setThinking("low");
	expect(await driver.state()).toMatchObject({ sessionId, model: "agy/gemini-3.8-flash-low", thinking: "low" });
	expect(await driver.setThinking("xhigh").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });

	await driver.setModel("agy/gpt-oss-120b-medium");
	// gpt-oss has no -low variant: the thinking switch is refused instead of spawning an unknown model.
	expect(await driver.setThinking("low").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });

	const listings = harness.readLog().filter((entry) => entry.dir === "argv" && entry.argv?.[0] === "models");
	expect(listings.length).toBe(1);
	await driver.stop();
});

test("models without an effort suffix keep their id when thinking is configured", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-pro-orchestrator-neon", thinking: "high" });
	await driver.start();
	await driver.openSession();
	expect(spawns(harness).at(-1)).toContain("gemini-pro-orchestrator-neon");
	expect(spawns(harness).at(-1)).not.toContain("gemini-pro-orchestrator-neon-high");
	const state = await driver.state();
	expect(state.model).toBe("agy/gemini-pro-orchestrator-neon");
	expect(state.thinking).toBeUndefined();
	await driver.stop();
});

test("steer while a turn runs is queued and answered within the same turn", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await started;
	await driver.steer("also this");
	expect(await driver.state()).toMatchObject({ idle: false, queuedMessageCount: 1 });
	expect(sentContents(harness)).toEqual(["@hold"]);

	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGUSR1");
	// Both answers are one turn: its usage sums the steered follow-up's call too.
	expect(await done).toEqual({
		opRef,
		status: "completed",
		text: "REPLY2:also this",
		usage: { calls: 2, input: 200, cacheRead: 80, output: 14, contextTokens: 140, rotated: false },
	});
	expect(sentContents(harness)).toEqual(["@hold", "also this"]);
	expect(turnAnswerParts((await driver.entriesSince()).entries)).toEqual(["HELD-DONE", "REPLY2:also this"]);
	expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
	expect(await driver.steer("late").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.stop();
});

test("abort interrupts the child; the turn ends aborted and the next prompt resumes the conversation", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	const exits: unknown[] = [];
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const { sessionId } = await driver.openSession();
	const firstPid = driver.pid;
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await started;
	await driver.steer("dropped");
	await driver.abort();
	expect(await done).toEqual({ opRef, status: "aborted", text: "", error: "interrupted" });
	expect(driver.pid).toBeUndefined();
	expect(exits).toEqual([]);

	const next = nextFinal(driver);
	await driver.prompt("after");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY1:after" });
	expect(driver.pid).not.toBe(firstPid);
	expect(spawns(harness).at(-1)).toEqual([...BASE_ARGS, "--conversation", sessionId, "--dangerously-skip-permissions"]);
	expect(sentContents(harness)).toEqual(["@hold", "after"]);
	await driver.stop();
	expect(exits).toEqual([]);
});

test("a respawn waits for the previous child to exit; that child's late output stays out of the new one", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const lingered = nextFinal(driver);
	await driver.prompt("@linger");
	await lingered;
	const oldPid = driver.pid;
	if (oldPid === undefined) throw new Error("no child");
	try {
		const termed = logged(harness, (entry) => entry.dir === "term");
		const switched = driver.switchSession("conv-abcdef12");
		await termed;
		// The old child ignores SIGTERM until SIGUSR2: no new child may be running beside it.
		expect(driver.pid).toBeUndefined();
		expect(spawns(harness)).toHaveLength(1);
		process.kill(oldPid, "SIGUSR2");
		await switched;
	} finally {
		if (alive(oldPid)) process.kill(oldPid, "SIGKILL");
	}
	expect(driver.pid).not.toBe(oldPid);
	expect(await driver.openSession()).toEqual({ resumed: true, sessionId: "conv-abcdef12" });
	expect((await driver.entriesSince()).entries).toEqual([]);

	const exit = Promise.withResolvers<OmpExitInfo>();
	driver.onExit((info) => exit.resolve(info));
	const newPid = driver.pid;
	if (newPid === undefined) throw new Error("no child");
	process.kill(newPid, "SIGINT");
	expect((await exit.promise).stderr).not.toContain("OLD-CHILD-STDERR");
	await driver.stop();
});

test("a respawn during a turn ends that turn aborted before the new child takes prompts", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-high" });
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();

	const started = nextEvent(driver, (event) => event.type === "step_update");
	const first = await driver.prompt("@hold");
	await started;
	await driver.newSession();
	expect(finals).toEqual([{ opRef: first, status: "aborted", text: "", error: "agy restarted (new session)" }]);
	expect(await driver.state()).toMatchObject({ idle: true });

	const restarted = nextEvent(driver, (event) => event.type === "step_update");
	const second = await driver.prompt("@hold");
	await restarted;
	await driver.setModel("agy/gemini-3.8-flash-low");
	expect(finals.at(-1)).toEqual({ opRef: second, status: "aborted", text: "", error: "agy restarted (model change)" });

	const done = nextFinal(driver);
	const third = await driver.prompt("after");
	expect(await done).toEqual({
		opRef: third,
		status: "completed",
		text: "REPLY1:after",
		usage: { calls: 1, input: 100, cacheRead: 40, output: 7, contextTokens: 140, rotated: false },
	});
	expect(finals).toHaveLength(3);
	await driver.stop();
});

test("steered texts a respawn throws away are named in the aborted final (qa-l #34)", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-3.8-flash-high" });
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();

	const started = nextEvent(driver, (event) => event.type === "step_update");
	const first = await driver.prompt("@hold");
	await started;
	await driver.steer("one");
	await driver.steer("two");
	await driver.newSession();
	expect(finals).toEqual([
		{ opRef: first, status: "aborted", text: "", error: "agy restarted (new session) (steer 2건 미전달)" },
	]);
	await driver.stop();
});

test("a steered message that cannot be sent ends the turn as error", async () => {
	const harness = makeHarness();
	const realSpawn = Bun.spawn;
	// stdin of the real fake child, except that writing the steered line fails like a broken pipe.
	const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
		const proc = realSpawn(...args);
		if (proc.stdin === undefined || typeof proc.stdin === "number") return proc;
		const stdin = proc.stdin;
		return {
			pid: proc.pid,
			exited: proc.exited,
			stdout: proc.stdout,
			stderr: proc.stderr,
			kill: (signal?: NodeJS.Signals) => proc.kill(signal),
			stdin: {
				write: (data: string) => {
					if (data.includes("STEER-FAIL")) throw new Error("EPIPE: broken pipe, write");
					return stdin.write(data);
				},
			},
		};
	}) as unknown as typeof Bun.spawn);
	try {
		const driver = harness.make();
		await driver.start();
		const started = nextEvent(driver, (event) => event.type === "step_update");
		const done = nextFinal(driver);
		const opRef = await driver.prompt("@hold");
		await started;
		await driver.steer("STEER-FAIL");
		const pid = driver.pid;
		if (pid === undefined) throw new Error("no child");
		process.kill(pid, "SIGUSR1");
		expect(await done).toEqual({
			opRef,
			status: "error",
			text: "HELD-DONE",
			error: "steer 전송 실패: agy stdin is closed",
			usage: { calls: 1, input: 100, cacheRead: 40, output: 7, contextTokens: 140, rotated: false },
		});
		expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
		await driver.stop();
	} finally {
		spawnSpy.mockRestore();
	}
});

test("steered messages dropped by a failed turn are named in the error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const started = nextEvent(driver, (event) => event.type === "step_update");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold @fail");
	await started;
	await driver.steer("one");
	await driver.steer("two");
	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGUSR1");
	expect(await done).toEqual({ opRef, status: "error", text: "", error: "boom (steer 2건 미전달)" });
	expect(sentContents(harness)).toEqual(["@hold @fail"]);
	expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
	await driver.stop();
});

test("a child that dies on its own is reported through onExit", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	const exit = Promise.withResolvers<unknown>();
	driver.onExit((info) => exit.resolve(info));
	await driver.start();
	const pid = driver.pid;
	if (pid === undefined) throw new Error("no child");
	process.kill(pid, "SIGINT");
	expect(await exit.promise).toMatchObject({ code: 130, expected: false });
	expect(driver.pid).toBeUndefined();
	await driver.stop();
});

test("compact is refused with rpc_error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const error = await driver.compact().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(OmpDriverError);
	expect(error).toMatchObject({ code: "rpc_error", message: "agy 세션은 compact를 지원하지 않습니다" });
	expect(existsSync(join(harness.sessionDir, "agy-conversation.json"))).toBe(true);
	await driver.stop();
});

function capturedLog(): { log: Logger; lines: string[] } {
	const lines: string[] = [];
	return { log: createLogger({ sink: (line) => lines.push(line), clock: Date, redact: (text) => text }), lines };
}

test("a turn whose last call fills 70% of the window rotates the conversation before the next turn", async () => {
	const harness = makeHarness();
	const { log, lines } = capturedLog();
	const driver = harness.make({ log });
	await driver.start();
	const opened = await driver.openSession();
	const pointer = join(harness.sessionDir, "agy-conversation.json");

	const done = nextFinal(driver);
	await driver.prompt("big @ctx=180000");
	const final = await done;
	expect(final.usage).toEqual({
		calls: 1,
		input: 1000,
		cacheRead: 179_000,
		output: 10,
		contextTokens: 180_000,
		rotated: true,
	});
	expect(existsSync(pointer)).toBe(false);
	expect((await driver.state()).sessionId).toBe("");
	const rotated = lines.filter((line) => line.includes("event=agy_conversation_rotated"));
	expect(rotated).toHaveLength(1);
	expect(rotated[0]).toContain("origin=discord/ch/C1/t/T1");
	expect(rotated[0]).toContain(`conversationId=${opened.sessionId}`);
	expect(rotated[0]).toContain("contextTokens=180000");

	const next = nextFinal(driver);
	await driver.prompt("after");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY1:after", usage: { rotated: false } });
	expect(spawns(harness)).toEqual([
		[...BASE_ARGS, "--dangerously-skip-permissions"],
		[...BASE_ARGS, "--dangerously-skip-permissions"],
	]);
	const fresh = (await driver.state()).sessionId;
	expect(fresh).not.toBe(opened.sessionId);
	expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({ conversationId: fresh });
	await driver.stop();
});

test("a turn under 70% keeps the conversation; the next spawn resumes it", async () => {
	const harness = makeHarness();
	const { log, lines } = capturedLog();
	const driver = harness.make({ log });
	await driver.start();
	const opened = await driver.openSession();

	const done = nextFinal(driver);
	await driver.prompt("big @ctx=170000");
	expect((await done).usage).toMatchObject({ calls: 1, contextTokens: 170_000, rotated: false });
	expect(JSON.parse(readFileSync(join(harness.sessionDir, "agy-conversation.json"), "utf8"))).toEqual({
		conversationId: opened.sessionId,
	});
	expect((await driver.state()).sessionId).toBe(opened.sessionId);
	expect(lines.some((line) => line.includes("agy_conversation_rotated"))).toBe(false);
	await driver.stop();

	const restarted = harness.make({ log });
	await restarted.start();
	expect(spawns(harness).at(-1)).toEqual([
		...BASE_ARGS,
		"--conversation",
		opened.sessionId,
		"--dangerously-skip-permissions",
	]);
	await restarted.stop();
});

test("rotation reads the last call, not the turn's sum: three 70k calls stay in the conversation", async () => {
	const harness = makeHarness();
	const { log, lines } = capturedLog();
	const driver = harness.make({ log });
	await driver.start();
	const opened = await driver.openSession();

	const done = nextFinal(driver);
	await driver.prompt("tools @ctx=70000,70000,70000");
	expect((await done).usage).toEqual({
		calls: 3,
		input: 3000,
		cacheRead: 207_000,
		output: 30,
		contextTokens: 70_000,
		rotated: false,
	});
	expect((await driver.state()).sessionId).toBe(opened.sessionId);
	expect(lines.some((line) => line.includes("agy_conversation_rotated"))).toBe(false);
	await driver.stop();
});

test("stop() while a rotation's retired child still lingers leaves no new child behind (qa-z #37)", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	await driver.openSession();
	const done = nextFinal(driver);
	await driver.prompt("big @ctx=180000 @linger");
	const oldPid = driver.pid; // the rotation at the final retires this child
	await done;
	try {
		const termed = logged(harness, (entry) => entry.dir === "term");
		// The rotation retired the lingering child; this prompt waits for its exit before spawning the next one.
		const pending = driver.prompt("next").then(
			() => undefined,
			(error: unknown) => error,
		);
		await termed;
		const stopped = driver.stop();
		if (oldPid !== undefined) process.kill(oldPid, "SIGUSR2");
		await stopped;
		expect(await pending).toBeInstanceOf(OmpDriverError);
		expect(spawns(harness)).toHaveLength(1);
		expect(driver.pid).toBeUndefined();
	} finally {
		if (oldPid !== undefined && alive(oldPid)) process.kill(oldPid, "SIGKILL");
	}
});

function createFakeIntervals() {
	let nextId = 1;
	const active = new Map<number, () => void>();
	return {
		active,
		setIntervalFn: (fn: () => void, _ms: number) => {
			const id = nextId++;
			active.set(id, fn);
			return id;
		},
		clearIntervalFn: (handle: unknown) => {
			if (typeof handle === "number") active.delete(handle);
		},
		tickAll: () => {
			for (const fn of [...active.values()]) fn();
		},
	};
}

test("AgyToolKeepalive emits bounded keepalive events and clears timer on end, clear, or invalid config", () => {
	let now = 1_000_000;
	const intervals = createFakeIntervals();
	const events: OmpEvent[] = [];
	const keepalive = new AgyToolKeepalive((event) => events.push(event), {
		intervalMs: 60_000,
		maxMs: 180_000,
		now: () => now,
		setIntervalFn: intervals.setIntervalFn,
		clearIntervalFn: intervals.clearIntervalFn,
	});

	keepalive.start("c1", "run_command");
	expect(intervals.active.size).toBe(1);
	now += 60_000;
	intervals.tickAll();
	expect(events).toEqual([
		{ type: AGY_TOOL_KEEPALIVE_EVENT, toolCallId: "c1", toolName: "run_command", elapsedMs: 60_000 },
	]);

	// Parallel tool: ending c1 keeps timer for c2; oldest active tool governs elapsedMs.
	keepalive.start("c2", "read_file");
	expect(intervals.active.size).toBe(1);
	now += 60_000;
	intervals.tickAll();
	expect(events.at(-1)).toEqual({
		type: AGY_TOOL_KEEPALIVE_EVENT,
		toolCallId: "c1",
		toolName: "run_command",
		elapsedMs: 120_000,
	});

	keepalive.end("c1");
	expect(intervals.active.size).toBe(1);
	now += 60_000;
	intervals.tickAll();
	expect(events.at(-1)).toEqual({
		type: AGY_TOOL_KEEPALIVE_EVENT,
		toolCallId: "c2",
		toolName: "read_file",
		elapsedMs: 120_000,
	});

	now += 60_000;
	intervals.tickAll();
	expect(events.at(-1)).toEqual({
		type: AGY_TOOL_KEEPALIVE_EVENT,
		toolCallId: "c2",
		toolName: "read_file",
		elapsedMs: 180_000,
	});

	// Past maxMs: stops emitting and clears timer.
	const countBeforeCap = events.length;
	now += 60_000;
	intervals.tickAll();
	expect(events.length).toBe(countBeforeCap);
	expect(intervals.active.size).toBe(0);

	// clear() stops active timer immediately.
	keepalive.start("c3", "edit_file");
	expect(intervals.active.size).toBe(1);
	keepalive.clear();
	expect(intervals.active.size).toBe(0);

	// Non-positive config disables timer.
	const disabled = new AgyToolKeepalive((event) => events.push(event), {
		intervalMs: 0,
		maxMs: 60_000,
		setIntervalFn: intervals.setIntervalFn,
		clearIntervalFn: intervals.clearIntervalFn,
	});
	disabled.start("c4", "run_command");
	expect(intervals.active.size).toBe(0);
});

test("AgyOmpDriver @holdtool prevents false stall_alert up to 8 min, then alerts if still hung", async () => {
	expect(AGY_TOOL_KEEPALIVE_INTERVAL_MS).toBeLessThan(STALL_MS);
	expect(AGY_TOOL_KEEPALIVE_MAX_MS).toBe(8 * 60_000);

	const harness = makeHarness();
	const clock = { t: 1_000_000, now: () => clock.t };
	const intervals = createFakeIntervals();
	const store = openBotStore(join(harness.root, "ompbot.db"), clock, "Asia/Seoul");
	const lines: string[] = [];
	const log = createLogger({ sink: (line) => lines.push(line), clock, redact });
	const stalls: Array<{ originKey: string; threadRef: string; stalled: boolean; silentMs: number }> = [];
	const keepalives: OmpEvent[] = [];
	let driver: AgyOmpDriver | undefined;
	const toolStarted = Promise.withResolvers<void>();
	const origin = "discord/ch/C1/t/T1";

	const router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(harness.root, "sessions"),
		log,
		statusProvider: () => "status",
		onStall: (info) => stalls.push(info),
		driverFactory: () => {
			driver = harness.make({
				log,
				toolKeepalive: {
					now: () => clock.t,
					setIntervalFn: intervals.setIntervalFn,
					clearIntervalFn: intervals.clearIntervalFn,
				},
			});
			driver.onEvent((event) => {
				if (event.type === "tool_execution_start") toolStarted.resolve();
				if (event.type === AGY_TOOL_KEEPALIVE_EVENT) keepalives.push(event);
			});
			return driver;
		},
	});

	try {
		await router.route({
			platformMessageId: "m1",
			originKey: origin,
			ownerVerified: true,
			text: "@holdtool",
			threadRef: "m1",
		});
		await toolStarted.promise;
		expect(intervals.active.size).toBe(1);

		for (let minute = 1; minute <= 7; minute++) {
			clock.t += AGY_TOOL_KEEPALIVE_INTERVAL_MS;
			intervals.tickAll();
			expect(router.sweepStalls()).toBe(0);
		}
		expect(keepalives).toHaveLength(7);
		expect(stalls).toEqual([]);
		expect(lines.some((line) => line.includes("stall_alert"))).toBe(false);
		const db = new Database(join(harness.root, "ompbot.db"), { readonly: true });
		try {
			const row = db.query("SELECT last_event_at FROM inbound WHERE origin_key = ?").get(origin) as {
				last_event_at: number | null;
			} | null;
			expect(row?.last_event_at).toBe(clock.t);
		} finally {
			db.close();
		}

		// 8 min: last keepalive emitted.
		clock.t += AGY_TOOL_KEEPALIVE_INTERVAL_MS;
		intervals.tickAll();
		expect(keepalives).toHaveLength(8);
		expect(router.sweepStalls()).toBe(0);

		// 9 min: cap exceeded -> timer stops, no keepalive, 60 s silent (not stalled yet).
		clock.t += AGY_TOOL_KEEPALIVE_INTERVAL_MS;
		intervals.tickAll();
		expect(keepalives).toHaveLength(8);
		expect(intervals.active.size).toBe(0);
		expect(router.sweepStalls()).toBe(0);

		// 10 min: STALL_MS (120 s) silent since last keepalive -> stall_alert fires.
		clock.t += AGY_TOOL_KEEPALIVE_INTERVAL_MS;
		expect(router.sweepStalls()).toBe(1);
		expect(stalls).toEqual([{ originKey: origin, threadRef: "m1", stalled: true, silentMs: STALL_MS }]);
		expect(lines.some((line) => line.includes("event=stall_alert"))).toBe(true);

		const done = driver ? nextFinal(driver) : Promise.reject(new Error("no driver"));
		const pid = driver?.pid;
		if (pid === undefined) throw new Error("no child");
		process.kill(pid, "SIGUSR1");
		expect(await done).toMatchObject({ status: "completed", text: "HELD-TOOL-DONE" });
		await router.mailbox(origin).sweepIdle();
		expect(intervals.active.size).toBe(0);
	} finally {
		await router.close();
		store.close();
	}
});

test("abort() during @holdtool clears keepalive timer immediately", async () => {
	const harness = makeHarness();
	const intervals = createFakeIntervals();
	let now = 1_000_000;
	const driver = harness.make({
		toolKeepalive: {
			now: () => now,
			setIntervalFn: intervals.setIntervalFn,
			clearIntervalFn: intervals.clearIntervalFn,
		},
	});
	await driver.start();
	const started = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@holdtool");
	await started;
	expect(intervals.active.size).toBe(1);

	now += 60_000;
	intervals.tickAll();
	await driver.abort();
	expect(intervals.active.size).toBe(0);
	expect(await done).toEqual({ opRef, status: "aborted", text: "", error: "interrupted" });
	await driver.stop();
});
