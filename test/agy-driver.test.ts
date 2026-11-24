import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgyMcpServer, agyMcpServersOf } from "../src/config-agy";
import { ConfigError } from "../src/config-validate";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { STALL_MS } from "../src/core/types";
import { LIVE_FIELDS } from "../src/daemon/reload";
import { createLogger, type Logger } from "../src/log";
import { AGY_ACP_ARGS } from "../src/omp/agy-acp-client";
import { AgyOmpDriver } from "../src/omp/agy-driver";
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
	pid?: number;
	message?: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
}

interface MakeOptions {
	model?: string;
	thinking?: string;
	systemPrompt?: string;
	env?: Record<string, string>;
	log?: Logger;
	toolKeepalive?: AgyToolKeepaliveOptions;
	mcpServers?: () => AgyMcpServer[];
	cancelTimeoutMs?: number;
}

interface Harness {
	root: string;
	sessionDir: string;
	logFile: string;
	make(options?: MakeOptions): AgyOmpDriver;
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
	writeFileSync(logFile, "");
	return {
		root,
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
				...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
				...(options.cancelTimeoutMs === undefined ? {} : { cancelTimeoutMs: options.cancelTimeoutMs }),
				env: { FAKE_AGY_LOG: logFile, ...(options.env ?? {}) },
				baseEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
				startupTimeoutMs: 10_000,
			}),
		readLog: () =>
			readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter((line) => line !== "")
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

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The live child's pid; a test that signals must never signal a missing pid (`-1` is every process). */
function childPid(driver: AgyOmpDriver): number {
	const pid = driver.pid;
	if (pid === undefined) throw new Error("no agy child");
	return pid;
}

const spawns = (harness: Harness): string[][] =>
	harness
		.readLog()
		.filter((entry) => entry.dir === "argv")
		.map((entry) => entry.argv ?? []);

/** Requests the driver sent with `method`, in order. */
const sent = (harness: Harness, method: string): Array<Record<string, unknown>> =>
	harness
		.readLog()
		.filter((entry) => entry.dir === "in" && entry.message?.method === method)
		.map((entry) => entry.message?.params ?? {});

const configCalls = (harness: Harness): string[] =>
	sent(harness, "session/set_config_option").map((params) => `${params.configId}=${params.value}`);

function captureLog(): { log: Logger; lines: string[] } {
	const lines: string[] = [];
	const clock = { now: () => Date.now() };
	return { log: createLogger({ sink: (line) => lines.push(line), clock, redact }), lines };
}

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

test("the child runs `agy acp`, never `-p`; one turn streams an accumulated message_update and ends with usage", async () => {
	const harness = makeHarness();
	const { log, lines } = captureLog();
	const driver = harness.make({ model: "gemini-4-neon", systemPrompt: "FLOORS", log });
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId).toStartWith("fake-");
	expect(await driver.leafId()).toBe(null);
	expect(spawns(harness)).toEqual([[...AGY_ACP_ARGS]]);
	expect(spawns(harness)[0]).toContain("acp");
	expect(spawns(harness)[0]).not.toContain("-p");
	expect(lines.some((line) => line.includes("event=agy.acp.started") && line.includes("resumed=false"))).toBe(true);

	const updates: OmpEvent[] = [];
	driver.onEvent((event) => {
		if (event.type === "message_update") updates.push(event);
	});
	const done = nextFinal(driver);
	const opRef = await driver.prompt("hello");
	expect(await done).toEqual({
		opRef,
		status: "completed",
		text: "REPLY1:hello",
		usage: { calls: 1, input: 100, cacheRead: 40, output: 7, contextTokens: 100, rotated: false },
	});
	// Each chunk extends the same message (LiveTurn shows `message.content` as a whole); thinking chunks are dropped.
	expect(updates).toEqual(
		["REPLY1:", "REPLY1:hello"].map((text) => ({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text }] },
		})),
	);

	const all = await driver.entriesSince();
	expect(all.entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant"]);
	expect(all.entries[0]?.message?.content).toBe("hello");
	expect(all.entries[1]?.message).toMatchObject({
		stopReason: "stop",
		provider: "agy",
		model: "gemini-4-neon",
		usage: { input: 100, output: 7, cacheRead: 40, cacheWrite: 2 },
	});
	expect(all.entries[1]?.message?.usage?.cost).toBeUndefined();
	expect(turnAnswerParts(all.entries)).toEqual(["REPLY1:hello"]);
	const leaf = await driver.leafId();
	expect(leaf).toBe(all.leafId);
	expect((await driver.entriesSince(leaf ?? undefined)).entries).toEqual([]);
	expect(await driver.entriesSince("nope").catch((e: unknown) => e)).toMatchObject({ code: "unknown_since" });

	// Second turn: same process and session; the system prompt went once, as agy's appended system prompt.
	const second = nextFinal(driver);
	await driver.prompt("again");
	expect(await second).toMatchObject({ status: "completed", text: "REPLY2:again" });
	expect(spawns(harness)).toHaveLength(1);
	const prompts = sent(harness, "session/prompt");
	expect(prompts.map((params) => params.prompt)).toEqual([
		[{ type: "text", text: "hello" }],
		[{ type: "text", text: "again" }],
	]);
	expect(prompts.every((params) => params.sessionId === opened.sessionId)).toBe(true);
	expect(sent(harness, "session/new")).toEqual([
		{
			cwd: join(harness.root, "workspace"),
			mcpServers: [],
			_meta: { antigravity: { systemPrompt: { append: "FLOORS" } } },
		},
	]);
	// An update kind the driver does not know is logged once, at debug.
	expect(lines.filter((line) => line.includes("kind=brand_new_kind"))).toHaveLength(1);
	expect(await driver.state()).toMatchObject({
		sessionId: opened.sessionId,
		idle: true,
		queuedMessageCount: 0,
		model: "agy/gemini-4-neon",
		thinking: "high",
	});
	await driver.stop();
});

test("a stopReason other than end_turn or cancelled ends the turn as error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@refuse");
	expect(await done).toMatchObject({
		opRef,
		status: "error",
		text: "",
		error: "agy turn ended with stopReason refusal",
	});
	expect(await driver.state()).toMatchObject({ idle: true });
	await driver.stop();
});

test("tool calls become toolCall/toolResult entries and tool start/end events", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const toolStart = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const toolEnd = nextEvent(driver, (event) => event.type === "tool_execution_end");
	const done = nextFinal(driver);
	await driver.prompt("@tool run it");
	expect(await toolStart).toMatchObject({
		toolCallId: "call_1",
		toolName: "run_command",
		args: { CommandLine: "echo hi" },
	});
	expect(await toolEnd).toEqual({
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "run_command",
		result: "hi\n",
	});
	expect(await done).toMatchObject({ status: "completed", text: "REPLY1:@tool run it" });
	const entries = (await driver.entriesSince()).entries;
	expect(entries.map((entry) => entry.message?.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(entries[1]?.message).toMatchObject({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "call_1", name: "run_command", arguments: { CommandLine: "echo hi" } }],
	});
	expect(entries[2]).toMatchObject({ toolCallId: "call_1", message: { content: [{ type: "text", text: "hi\n" }] } });

	// No output: no `result`; a failed tool says so.
	const quiet = nextEvent(driver, (event) => event.type === "tool_execution_end");
	const quietDone = nextFinal(driver);
	await driver.prompt("@tool @nooutput");
	expect(await quiet).toEqual({ type: "tool_execution_end", toolCallId: "call_2", toolName: "run_command" });
	await quietDone;
	const failed = nextEvent(driver, (event) => event.type === "tool_execution_end");
	const failedDone = nextFinal(driver);
	await driver.prompt("@tool @failtool");
	expect(await failed).toMatchObject({ toolCallId: "call_3", isError: true, result: "hi\n" });
	await failedDone;
	await driver.stop();
});

test("a permission request is answered cancelled (as omp does) and logged", async () => {
	const harness = makeHarness();
	const { log, lines } = captureLog();
	const driver = harness.make({ log });
	await driver.start();
	const done = nextFinal(driver);
	await driver.prompt("@ask");
	expect(await done).toMatchObject({ status: "completed", text: "ASKED" });
	const answer = harness.readLog().find((entry) => entry.dir === "in" && entry.message?.id === "perm-1");
	expect(answer?.message?.result).toEqual({ outcome: { outcome: "cancelled" } });
	expect(lines.some((line) => line.includes("event=agy.acp.agent_request"))).toBe(true);
	await driver.stop();
});

test("abort sends session/cancel: the turn ends aborted, the child lives on and takes the next prompt", async () => {
	const harness = makeHarness();
	const exits: OmpExitInfo[] = [];
	const driver = harness.make();
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const pid = driver.pid;
	const done = nextFinal(driver);
	const started = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const opRef = await driver.prompt("@holdtool");
	await started;
	await driver.steer("dropped by the abort");
	await driver.abort();
	expect(await done).toEqual({
		opRef,
		status: "aborted",
		text: "",
		error: "cancelled",
		usage: { calls: 1, input: 100, cacheRead: 40, output: 7, rotated: false },
	});
	expect(await driver.state()).toMatchObject({ idle: true, queuedMessageCount: 0 });
	expect(driver.pid).toBe(pid);
	expect(sent(harness, "session/cancel")).toHaveLength(1);

	const next = nextFinal(driver);
	await driver.prompt("after");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY2:after" });
	expect(spawns(harness)).toHaveLength(1);
	expect(exits).toEqual([]);
	await driver.stop();
});

test("a cancel agy never answers kills the process group: no onExit, no turn left when abort returns", async () => {
	const harness = makeHarness();
	const { log, lines } = captureLog();
	const exits: OmpExitInfo[] = [];
	// The fake's grandchild connects here and stays connected until it dies.
	const grandConnected = Promise.withResolvers<void>();
	const grandGone = Promise.withResolvers<void>();
	const sock = join(harness.root, "grand.sock");
	const server = Bun.listen({
		unix: sock,
		socket: { open: () => grandConnected.resolve(), close: () => grandGone.resolve(), data: () => {} },
	});
	const driver = harness.make({ log, cancelTimeoutMs: 50, env: { FAKE_AGY_GRAND_SOCK: sock } });
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const session = (await driver.openSession()).sessionId;
	const pid = childPid(driver);
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	const started = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const opRef = await driver.prompt("@deaf");
	await Promise.all([started, grandConnected.promise]);
	await driver.abort();
	// Returned: the turn is over and its final out; the child and its grandchild got the group's SIGTERM.
	expect(finals).toEqual([{ opRef, status: "aborted", text: "", error: "cancel unanswered; agy killed" }]);
	expect(await driver.state()).toMatchObject({ idle: true });
	expect(driver.pid).toBeUndefined();
	expect(alive(pid)).toBe(false);
	await grandGone.promise;
	server.stop(true);
	expect(exits).toEqual([]);
	expect(lines.some((line) => line.includes("event=agy.acp.abort_killed"))).toBe(true);

	// The next prompt starts a new child on the same session.
	const next = nextFinal(driver);
	await driver.prompt("back");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY1:back" });
	expect(spawns(harness)).toHaveLength(2);
	expect(sent(harness, "session/load").map((params) => params.sessionId)).toEqual([session]);
	expect(finals).toHaveLength(2);
	await driver.stop();
});

test("a resumed session is reused without session/new; one agy cannot read falls back to session/new", async () => {
	const harness = makeHarness();
	const first = harness.make();
	await first.start();
	const { sessionId } = await first.openSession();
	await first.stop();
	expect(JSON.parse(readFileSync(join(harness.sessionDir, "agy-conversation.json"), "utf8"))).toEqual({
		conversationId: sessionId,
	});

	const { log, lines } = captureLog();
	const second = harness.make({ log });
	const replayed: OmpEvent[] = [];
	second.onEvent((event) => replayed.push(event));
	await second.start();
	expect(await second.openSession()).toEqual({ resumed: true, sessionId });
	expect(sent(harness, "session/new")).toHaveLength(1);
	expect(lines.some((line) => line.includes("event=agy.acp.started") && line.includes("resumed=true"))).toBe(true);
	// session/load replays the conversation; none of it is this driver's turn, entries or context size.
	expect(replayed).toEqual([]);
	expect((await second.entriesSince()).entries).toEqual([]);
	const done = nextFinal(second);
	await second.prompt("after load");
	expect((await done).usage).toMatchObject({ contextTokens: 100, rotated: false });
	await second.stop();

	const third = harness.make({ log, env: { FAKE_AGY_UNKNOWN_SESSION: "1" } });
	await third.start();
	const opened = await third.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId).not.toBe(sessionId);
	expect(sent(harness, "session/new")).toHaveLength(2);
	expect(lines.some((line) => line.includes("event=agy.acp.load_failed"))).toBe(true);
	await third.stop();
});

test("agy's quota retry notice cancels the turn and ends it as a 429 error; a half-written notice is never shown", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const pid = driver.pid;
	const shown: OmpEvent[] = [];
	driver.onEvent((event) => {
		if (event.type === "message_update") shown.push(event);
	});
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@quota");
	expect(await done).toMatchObject({
		opRef,
		status: "error",
		error: "agy rate limited (429): RESOURCE_EXHAUSTED (code 429): out",
	});
	expect(shown).toEqual([
		{ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Working\n" }] } },
	]);
	expect(sent(harness, "session/cancel")).toHaveLength(1);
	expect(driver.pid).toBe(pid);
	await driver.stop();
});

test("a pointer the -p driver left (not an ACP session) is tried, then replaced by a new session", async () => {
	const harness = makeHarness();
	mkdirSync(harness.sessionDir, { recursive: true });
	writeFileSync(
		join(harness.sessionDir, "agy-conversation.json"),
		`${JSON.stringify({ conversationId: "conv-old-1234" })}\n`,
	);
	const driver = harness.make();
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(sent(harness, "session/load").map((params) => params.sessionId)).toEqual(["conv-old-1234"]);
	expect(JSON.parse(readFileSync(join(harness.sessionDir, "agy-conversation.json"), "utf8")).conversationId).toBe(
		opened.sessionId,
	);
	await driver.stop();
});

test("start sets model and thought_level and checks them; a refused value fails the start", async () => {
	const neon = makeHarness();
	const driver = neon.make({ model: "gemini-4-neon", thinking: "low" });
	await driver.start();
	expect(configCalls(neon)).toEqual(["model=gemini-4-neon", "thought_level=low"]);
	expect(await driver.state()).toMatchObject({ model: "agy/gemini-4-neon", thinking: "low" });
	await driver.stop();

	// An effort suffix the model options lack is cut and becomes the level.
	const suffixed = makeHarness();
	const flash = suffixed.make({ model: "gemini-3.8-flash-medium" });
	await flash.start();
	expect(configCalls(suffixed)).toEqual(["model=gemini-3.8-flash", "thought_level=medium"]);
	await flash.stop();

	// A model without thought_level (the orchestrators) runs without one.
	const orchestrator = makeHarness();
	const { log, lines } = captureLog();
	const orch = orchestrator.make({ model: "gemini-pro-orchestrator-neon", thinking: "high", log });
	await orch.start();
	expect(configCalls(orchestrator)).toEqual(["model=gemini-pro-orchestrator-neon"]);
	expect(lines.some((line) => line.includes("event=agy.acp.thinking_unsupported"))).toBe(true);
	expect(await orch.state()).toMatchObject({ model: "agy/gemini-pro-orchestrator-neon" });
	expect((await orch.state()).thinking).toBeUndefined();
	expect(await orch.thinkingLevels()).toEqual([]);
	await orch.stop();

	// Refused by agy (unknown model), or acknowledged without taking effect: the start fails, no child is left.
	for (const [model, env] of [
		["no-such-model", {}],
		["gemini-3.8-flash", { FAKE_AGY_DEAF_CONFIG: "1" }],
	] as const) {
		const refused = makeHarness();
		const bad = refused.make({ model, env });
		const error = await bad.start().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OmpDriverError);
		expect(error).toMatchObject({ code: "rpc_error" });
		expect(String((error as Error).message)).toContain("agy acp start failed");
		expect(bad.pid).toBeUndefined();
		await bad.stop();
	}
});

test("setModel and setThinking change the live session without a restart", async () => {
	const harness = makeHarness();
	const driver = harness.make({ model: "gemini-4-neon", thinking: "low" });
	await driver.start();
	const pid = driver.pid;
	const sessionId = (await driver.openSession()).sessionId;
	expect(await driver.availableModels()).toEqual([
		"agy/gemini-4-neon",
		"agy/gemini-pro-orchestrator-neon",
		"agy/gemini-3.8-flash",
	]);
	expect(await driver.thinkingLevels()).toEqual(["low", "medium", "high", "xhigh"]);

	expect(await driver.setModel("agy/gemini-3.8-flash")).toBe("agy/gemini-3.8-flash");
	await driver.setThinking("xhigh");
	expect(await driver.state()).toMatchObject({ model: "agy/gemini-3.8-flash", thinking: "xhigh", sessionId });
	expect(await driver.setModel("agy/nope").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setModel("other/gemini-3.8-flash").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(await driver.setThinking("ultra").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });

	// The orchestrator offers no thought_level: setThinking is refused, the chosen level is not lost for later models.
	await driver.setModel("agy/gemini-pro-orchestrator-neon");
	expect(await driver.setThinking("low").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.setModel("agy/gemini-4-neon");
	expect(await driver.state()).toMatchObject({ model: "agy/gemini-4-neon", thinking: "xhigh" });

	const done = nextFinal(driver);
	await driver.prompt("after the switch");
	expect(await done).toMatchObject({ status: "completed" });
	expect(driver.pid).toBe(pid);
	expect(spawns(harness)).toHaveLength(1);
	expect(sent(harness, "session/new")).toHaveLength(1);
	await driver.stop();
});

test("a turn that ends at 70% of usage_update size rotates the session before the next turn", async () => {
	const harness = makeHarness();
	const { log, lines } = captureLog();
	const driver = harness.make({ log });
	await driver.start();
	const first = (await driver.openSession()).sessionId;

	const half = nextFinal(driver);
	await driver.prompt("@half");
	expect((await half).usage).toMatchObject({ contextTokens: 500, rotated: false });
	expect(existsSync(join(harness.sessionDir, "agy-conversation.json"))).toBe(true);

	const full = nextFinal(driver);
	await driver.prompt("@full");
	expect((await full).usage).toMatchObject({ contextTokens: 800, rotated: true });
	expect(existsSync(join(harness.sessionDir, "agy-conversation.json"))).toBe(false);
	expect(lines.some((line) => line.includes("event=agy_conversation_rotated"))).toBe(true);

	const next = nextFinal(driver);
	await driver.prompt("fresh");
	expect(await next).toMatchObject({ status: "completed", text: "REPLY1:fresh" });
	const second = (await driver.state()).sessionId;
	expect(second).not.toBe(first);
	expect(spawns(harness)).toHaveLength(2);
	expect(sent(harness, "session/load")).toEqual([]);
	await driver.stop();
});

test("agyMcpServers reach session/new and session/load; a reload's new list applies from the next start", async () => {
	const harness = makeHarness();
	let servers = [
		{ name: "wiki", command: "/usr/bin/wiki-mcp", args: ["--stdio"], env: [{ name: "WIKI_HOME", value: "/w" }] },
	];
	const driver = harness.make({ mcpServers: () => servers });
	await driver.start();
	await driver.stop();
	servers = [];
	const resumed = harness.make({ mcpServers: () => servers });
	await resumed.start();
	expect(await resumed.openSession()).toMatchObject({ resumed: true });
	await resumed.stop();
	expect(sent(harness, "session/new").map((params) => params.mcpServers)).toEqual([
		[{ name: "wiki", command: "/usr/bin/wiki-mcp", args: ["--stdio"], env: [{ name: "WIKI_HOME", value: "/w" }] }],
	]);
	expect(sent(harness, "session/load").map((params) => params.mcpServers)).toEqual([[]]);
	expect(LIVE_FIELDS as readonly string[]).toContain("agyMcpServers");
});

test("agyMcpServers config: defaults filled, reserved env prefixes and malformed entries refused", () => {
	expect(agyMcpServersOf("/c.json", undefined)).toBeUndefined();
	expect(agyMcpServersOf("/c.json", [{ name: "w", command: "wiki" }])).toEqual([
		{ name: "w", command: "wiki", args: [], env: [] },
	]);
	for (const prefix of ["SLACK_", "OMPBOT_", "LD_", "DYLD_"]) {
		const bad = [{ name: "w", command: "wiki", env: [{ name: `${prefix}X`, value: "1" }] }];
		expect(() => agyMcpServersOf("/c.json", bad)).toThrow(ConfigError);
	}
	for (const bad of [
		{},
		[{ command: "wiki" }],
		[{ name: "w", command: "" }],
		[{ name: "w", command: "wiki", args: [1] }],
		[{ name: "w", command: "wiki", env: { A: "1" } }],
		[{ name: "w", command: "wiki", extra: true }],
	]) {
		expect(() => agyMcpServersOf("/c.json", bad)).toThrow(ConfigError);
	}
});

test("steer while a turn runs is sent as the next session/prompt within the same turn", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	const started = nextEvent(driver, (event) => event.type === "tool_execution_start");
	const opRef = await driver.prompt("@holdtool");
	await started;
	await driver.steer("one");
	await driver.steer("two");
	expect(await driver.state()).toMatchObject({ idle: false, queuedMessageCount: 2 });
	const done = Promise.withResolvers<void>();
	driver.onFinal(() => done.resolve());
	process.kill(childPid(driver), "SIGUSR1");
	await done.promise;
	expect(finals).toEqual([
		{
			opRef,
			status: "completed",
			text: "REPLY2:two",
			usage: { calls: 2, input: 200, cacheRead: 80, output: 14, contextTokens: 100, rotated: false },
		},
	]);
	expect(turnAnswerParts((await driver.entriesSince()).entries)).toEqual(["HELD-TOOL-DONE", "REPLY2:two"]);
	expect(sent(harness, "session/prompt").map((params) => params.prompt)).toEqual([
		[{ type: "text", text: "@holdtool" }],
		[{ type: "text", text: "one\n\ntwo" }],
	]);
	await driver.stop();
});

test("newSession during a turn ends it aborted and starts a new session; switchSession resumes the given id", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const first = (await driver.openSession()).sessionId;
	const done = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await driver.steer("lost");
	expect(await driver.newSession()).toEqual({ cancelled: false });
	expect(await done).toEqual({
		opRef,
		status: "aborted",
		text: "",
		error: "agy restarted (new session) (steer 1건 미전달)",
	});
	const second = (await driver.state()).sessionId;
	expect(second).not.toBe(first);
	expect(await driver.state()).toMatchObject({ idle: true });

	await driver.switchSession(`/x/${first}.jsonl`);
	expect(await driver.openSession()).toEqual({ resumed: true, sessionId: first });
	expect(await driver.switchSession("bad id").catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	expect(spawns(harness)).toHaveLength(3);
	await driver.stop();
});

test("a child that dies on its own is reported through onExit", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	const exited = Promise.withResolvers<OmpExitInfo>();
	driver.onExit((info) => exited.resolve(info));
	await driver.prompt("@die");
	expect(await exited.promise).toMatchObject({ code: 3, expected: false });
	expect(await driver.state()).toMatchObject({ idle: true });
	expect(driver.pid).toBeUndefined();
	await driver.stop();
});

test("compact is refused with rpc_error", async () => {
	const harness = makeHarness();
	const driver = harness.make();
	await driver.start();
	expect(await driver.compact().catch((e: unknown) => e)).toMatchObject({ code: "rpc_error" });
	await driver.stop();
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
	expect(await done).toMatchObject({ opRef, status: "aborted", text: "", error: "cancelled" });
	await driver.stop();
});
