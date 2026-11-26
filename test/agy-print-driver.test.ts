import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_LAST_ANSWER_FILE, AgyPrintDriver, type AgyPrintDriverOptions } from "../src/omp/agy-print-driver";
import { OmpDriverError, type OmpEvent, type OmpExitInfo, type OmpFinal } from "../src/omp/driver";
import { agySettings } from "../src/tasks/worker-tier";

const tempDirs: string[] = [];
const FAKE_SCRIPT = join(import.meta.dir, "fixtures", "fake-agy-print-child.ts");
const FLOORS = "FLOORS-TEST";
const SETTINGS = agySettings(["/w/tree", "/w/docs"], ["/w/secrets"]);

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogEntry {
	kind: "argv" | "env" | "in" | "exit" | "grand";
	pid?: number;
	argv?: string[];
	env?: Record<string, string | undefined>;
	line?: string;
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "jabbu-agy-print-"));
	tempDirs.push(root);
	const executable = join(root, "bin", "agy");
	mkdirSync(join(root, "bin"));
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SCRIPT}" "$@"\n`);
	chmodSync(executable, 0o755);
	const logFile = join(root, "fake.log");
	writeFileSync(logFile, "");
	const sessionDir = join(root, "sessions", "e1");
	const logDir = join(root, "agy-log");
	const make = (overrides: Partial<AgyPrintDriverOptions> = {}) =>
		new AgyPrintDriver({
			agyExecutable: executable,
			cwd: root,
			sessionDir,
			model: "gemini-test",
			settings: SETTINGS,
			addDirs: ["/w/docs"],
			workerFloors: FLOORS,
			logName: "t-1",
			logDir,
			env: { FAKE_AGY_LOG: logFile, OMP_WIKI_NOTE_DISABLE: "1" },
			baseEnv: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", SLACK_BOT_TOKEN: "xoxb-TEST-0" },
			startupTimeoutMs: 10_000,
			...overrides,
		});
	const entries = (): LogEntry[] =>
		readFileSync(logFile, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as LogEntry);
	const spawns = () => entries().filter((entry) => entry.kind === "argv");
	/** The `content` of every stdin line, in order. */
	const inputs = () =>
		entries()
			.filter((entry) => entry.kind === "in")
			.map((entry) => (JSON.parse(entry.line ?? "{}") as { message: { content: string } }).message.content);
	const lastPid = (): number => {
		const pid = spawns().at(-1)?.pid;
		if (pid === undefined) throw new Error("no agy child");
		return pid;
	};
	return { root, sessionDir, logDir, make, entries, spawns, inputs, lastPid };
}

function nextFinal(driver: AgyPrintDriver): Promise<OmpFinal> {
	const { promise, resolve } = Promise.withResolvers<OmpFinal>();
	const off = driver.onFinal((final) => {
		off();
		resolve(final);
	});
	return promise;
}

/** A bounded hop-by-hop wait (one macrotask per hop, no fixed delay) until `ready` holds. */
async function until(ready: () => boolean, what: string, hops = 2000): Promise<void> {
	for (let hop = 0; hop < hops; hop += 1) {
		if (ready()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	}
	throw new Error(`never happened: ${what}`);
}

/** Prompts `text` and resolves with that turn's final (subscribed before the prompt goes out). */
async function started(driver: AgyPrintDriver, text: string): Promise<OmpFinal> {
	const final = nextFinal(driver);
	await driver.prompt(text);
	return final;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const flagOf = (argv: string[] | undefined, name: string): string | undefined => {
	const at = argv?.indexOf(name) ?? -1;
	return at === -1 ? undefined : argv?.[at + 1];
};

test("two turns on one child: floors on the first only, --settings, env, log file, last answer each turn", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(opened.sessionId).toStartWith("fake-");
	const first = await started(driver, "first task");
	expect(first).toMatchObject({ status: "completed", text: "REPLY1:first task" });
	expect(first.usage).toMatchObject({ calls: 1, input: 100, cacheRead: 40, output: 7, contextTokens: 140 });
	expect(readFileSync(join(h.sessionDir, AGY_LAST_ANSWER_FILE), "utf8")).toBe("REPLY1:first task");
	const second = await started(driver, "second");
	expect(second).toMatchObject({ status: "completed", text: "REPLY2:second" });
	expect(readFileSync(join(h.sessionDir, AGY_LAST_ANSWER_FILE), "utf8")).toBe("REPLY2:second");

	expect(h.spawns()).toHaveLength(1);
	expect(h.inputs()).toEqual([`${FLOORS}\n\nfirst task`, "second"]);
	const argv = h.spawns()[0]?.argv;
	expect(flagOf(argv, "--settings")).toBe(SETTINGS);
	expect(flagOf(argv, "--model")).toBe("gemini-test");
	expect(flagOf(argv, "--add-dir")).toBe("/w/docs");
	expect(argv).toContain("--disable-slash-commands");
	expect(argv).toContain("--dangerously-skip-permissions");
	expect(argv).not.toContain("--conversation");
	expect(flagOf(argv, "--log-file")).toStartWith(join(h.logDir, "cli-task-t-1-"));
	expect(h.entries().find((entry) => entry.kind === "env")?.env).toEqual({
		AGY_CLI_DISABLE_AUTO_UPDATE: "1",
		SSH_TTY: "jabbu-agy-file-auth",
		OMP_WIKI_NOTE_DISABLE: "1",
	});
	await driver.stop();
});

test("a steer mid-turn waits for the turn's result and goes as the next line of the same opRef", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	const events: OmpEvent[] = [];
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => {
		events.push(event);
		if (event.type === "message_update") working.resolve();
	});
	const final = nextFinal(driver);
	const opRef = await driver.prompt("@hold");
	await working.promise;
	await driver.steer("steered");
	expect(h.inputs()).toHaveLength(1);
	expect((await driver.state()).queuedMessageCount).toBe(1);
	process.kill(h.lastPid(), "SIGUSR1");
	expect(await final).toMatchObject({ opRef, status: "completed", text: "REPLY2:steered" });
	expect(h.inputs()).toEqual([`${FLOORS}\n\n@hold`, "steered"]);
	await driver.stop();
});

test("stream and tool events reach onEvent; an unknown step kind is logged, not dropped", async () => {
	const h = harness();
	const lines: string[] = [];
	const driver = new AgyPrintDriver({
		...{ agyExecutable: join(h.root, "bin", "agy"), cwd: h.root, sessionDir: h.sessionDir, model: "m" },
		...{ settings: SETTINGS, workerFloors: FLOORS, logName: "t-1", logDir: h.logDir, startupTimeoutMs: 10_000 },
		env: { FAKE_AGY_LOG: join(h.root, "fake.log") },
		baseEnv: { HOME: h.root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		log: { debug: () => {}, info: (event) => lines.push(event), warn: () => {}, error: () => {} },
	});
	await driver.start();
	const types: string[] = [];
	driver.onEvent((event) => types.push(event.type));
	expect(await started(driver, "@tool")).toMatchObject({ status: "completed", text: "REPLY1:@tool" });
	expect(types).toEqual(["tool_execution_start", "tool_execution_end", "message_update", "message_update"]);
	const denied = await started(driver, "@denied");
	expect(denied.status).toBe("completed");
	const { entries } = await driver.entriesSince();
	const results = entries.filter((entry) => entry.message?.role === "toolResult");
	expect(JSON.stringify(results.at(-1))).toContain("Matches user-configured deny rule");
	expect(lines).toContain("agy.print.unknown_event");
	await driver.stop();
});

test("an error turn ends `error` and the child goes on to the next turn", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	expect(await started(driver, "@error")).toMatchObject({ status: "error", error: "model exploded" });
	expect(await started(driver, "after")).toMatchObject({ status: "completed", text: "REPLY2:after" });
	expect(h.spawns()).toHaveLength(1);
	await driver.stop();
});

test("a stdin failure ends the turn after prompt() resolves, never inside it", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	await driver.openSession();
	expect(await started(driver, "first @close-stdin")).toMatchObject({ status: "completed" });
	// The mailbox creates its turn only after prompt() resolves, so a final delivered inside prompt() is ignored
	// (final_ignored) and the turn hangs: record whether the final arrives before prompt() returns.
	let promptReturned = false;
	let deliveredBeforeReturn = false;
	const finalPromise = new Promise<OmpFinal>((resolve) => {
		const off = driver.onFinal((final) => {
			off();
			if (!promptReturned) deliveredBeforeReturn = true;
			resolve(final);
		});
	});
	const opRef = await driver.prompt("second");
	promptReturned = true;
	const final = await finalPromise;
	expect(final.opRef).toBe(opRef);
	expect(final).toMatchObject({ status: "error" });
	expect(final.error).toContain("agy stdin closed");
	expect(deliveredBeforeReturn).toBe(false);
	await driver.stop();
});

test("a quota error ends `agy rate limited (429)` and the driver ends the child itself; the next prompt resumes", async () => {
	const h = harness();
	const driver = h.make();
	const exits: OmpExitInfo[] = [];
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const quota = await started(driver, "@quota");
	expect(quota.status).toBe("error");
	expect(quota.error).toStartWith("agy rate limited (429): ");
	expect(quota.error).toContain("RESOURCE_EXHAUSTED (code 429): Individual quota reached");
	const first = h.lastPid();
	expect(await started(driver, "after")).toMatchObject({ status: "completed", text: "REPLY1:after" });
	expect(alive(first)).toBe(false);
	expect(h.spawns()).toHaveLength(2);
	expect(flagOf(h.spawns()[1]?.argv, "--conversation")).toStartWith("fake-");
	expect(h.inputs().at(-1)).toBe("after"); // same conversation: no floors again
	const notice = await started(driver, "@notice");
	expect(notice.error).toStartWith("agy rate limited (429): RESOURCE_EXHAUSTED (code 429)");
	expect(exits).toEqual([]);
	await driver.stop();
});

test("a replacement child's first tool call emits its start and end (tool state resets on spawn)", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	const types: string[] = [];
	driver.onEvent((event) => types.push(event.type));
	expect(await started(driver, "@tool")).toMatchObject({ status: "completed" });
	expect(types).toContain("tool_execution_start");
	expect(types).toContain("tool_execution_end");
	expect((await started(driver, "@quota")).status).toBe("error");
	types.length = 0;
	expect(await started(driver, "@tool")).toMatchObject({ status: "completed", text: "REPLY1:@tool" });
	expect(h.spawns()).toHaveLength(2);
	expect(types).toContain("tool_execution_start");
	expect(types).toContain("tool_execution_end");
	await driver.stop();
});

test("stop during a retire: a parked prompt rejects instead of spawning a child under the stopped driver", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	await driver.prompt("@hold");
	const aborting = driver.abort();
	const parked = driver.prompt("next");
	const stopping = driver.stop();
	await expect(parked).rejects.toThrow("driver not started");
	await stopping;
	await aborting;
	expect(h.spawns()).toHaveLength(1);
});

test("the conversation id is kept and a new driver resumes it with --conversation, without floors", async () => {
	const h = harness();
	const one = h.make();
	await one.start();
	await started(one, "hello");
	const id = (await one.state()).sessionId;
	await one.stop();
	const pointer = JSON.parse(readFileSync(join(h.sessionDir, "agy-conversation.json"), "utf8"));
	expect(pointer).toEqual({ conversationId: id });
	const two = h.make();
	await two.start();
	expect(await two.openSession()).toEqual({ resumed: true, sessionId: id });
	await started(two, "again");
	expect(flagOf(h.spawns()[1]?.argv, "--conversation")).toBe(id);
	expect(h.inputs()).toEqual([`${FLOORS}\n\nhello`, "again"]);
	const logs = h.spawns().map((spawn) => flagOf(spawn.argv, "--log-file"));
	expect(new Set(logs).size).toBe(2);
	await two.stop();
});

test("an unknown conversation: the pointer goes and one new child starts a new conversation with floors", async () => {
	const h = harness();
	mkdirSync(h.sessionDir, { recursive: true });
	writeFileSync(join(h.sessionDir, "agy-conversation.json"), `${JSON.stringify({ conversationId: "lost-123" })}\n`);
	const driver = h.make();
	await driver.start();
	const opened = await driver.openSession();
	expect(opened.resumed).toBe(false);
	expect(h.spawns().map((spawn) => flagOf(spawn.argv, "--conversation"))).toEqual(["lost-123", undefined]);
	expect(await started(driver, "go")).toMatchObject({ status: "completed" });
	expect(h.inputs()).toEqual([`${FLOORS}\n\ngo`]);
	const pointer = JSON.parse(readFileSync(join(h.sessionDir, "agy-conversation.json"), "utf8"));
	expect(pointer.conversationId).toBe(opened.sessionId);
	await driver.stop();
});

test("abort ends the turn `aborted` once without a crash; the next prompt restarts on the same conversation", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	const exits: OmpExitInfo[] = [];
	driver.onFinal((final) => finals.push(final));
	driver.onExit((info) => exits.push(info));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold");
	await working.promise;
	const held = h.lastPid();
	await driver.abort();
	expect(finals.map((final) => final.status)).toEqual(["aborted"]);
	expect(finals[0]?.error).toBe("cancelled"); // nothing queued: no 미전달 suffix
	expect(finals[0]?.droppedSteers).toBeUndefined();
	expect(alive(held)).toBe(false);
	expect((await driver.state()).idle).toBe(true);
	expect(await started(driver, "next")).toMatchObject({ status: "completed", text: "REPLY1:next" });
	expect(finals.map((final) => final.status)).toEqual(["aborted", "completed"]);
	expect(flagOf(h.spawns()[1]?.argv, "--conversation")).toStartWith("fake-");
	expect(h.inputs().at(-1)).toBe("next");
	expect(exits).toEqual([]);
	await driver.stop();
});

test("newSession mid-turn ends the turn `aborted` with cancelled=true and the next prompt runs", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold");
	await working.promise;
	const held = h.lastPid();
	expect(await driver.newSession()).toEqual({ cancelled: true });
	expect(finals.map((final) => [final.status, final.error])).toEqual([["aborted", "cancelled"]]);
	expect(alive(held)).toBe(false);
	expect((await driver.state()).idle).toBe(true);
	expect(await started(driver, "next")).toMatchObject({ status: "completed", text: "REPLY1:next" });
	await driver.stop();
});

test("abort returns while a detached descendant still holds stdout: exit settles on the code, not EOF", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold-stdout");
	await working.promise;
	// The delta can reach the driver while the grandchild spawn is still in flight: wait for the fake's
	// log to prove the detached sleeper exists before aborting, or the test passes vacuously.
	await until(() => h.entries().some((entry) => entry.kind === "grand"), "the detached sleeper");
	const held = h.lastPid();
	await driver.abort();
	expect(finals.map((final) => final.status)).toEqual(["aborted"]);
	expect(finals[0]?.error).toBe("cancelled");
	expect(alive(held)).toBe(false);
	expect((await driver.state()).idle).toBe(true);
	expect(await started(driver, "next")).toMatchObject({ status: "completed", text: "REPLY1:next" });
	await driver.stop();
	// The detached sleeper outlives the group kill: end it so its pipe does not outlive the test file.
	const grand = h.entries().find((entry) => entry.kind === "grand")?.pid;
	if (grand !== undefined) {
		try {
			process.kill(grand, "SIGKILL");
		} catch {
			// already gone
		}
	}
});

test("switchSession mid-turn ends the turn `aborted` with cancelled=true and resumes the given conversation", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold");
	await working.promise;
	const held = h.lastPid();
	expect(await driver.switchSession("/x/resumed-conversation.jsonl")).toEqual({ cancelled: true });
	expect(finals.map((final) => [final.status, final.error])).toEqual([["aborted", "cancelled"]]);
	expect(alive(held)).toBe(false);
	expect((await driver.state()).idle).toBe(true);
	expect(await started(driver, "next")).toMatchObject({ status: "completed", text: "REPLY1:next" });
	expect(flagOf(h.spawns()[1]?.argv, "--conversation")).toBe("resumed-conversation");
	expect(finals).toHaveLength(2);
	await driver.stop();
});

test("an idle newSession is cancelled=false, kills the idle child, and the next prompt starts a fresh conversation", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	await driver.openSession();
	expect(await driver.newSession()).toEqual({ cancelled: false });
	expect(await driver.newSession()).toEqual({ cancelled: false });
	expect(finals).toEqual([]);
	expect(await started(driver, "fresh")).toMatchObject({ status: "completed", text: "REPLY1:fresh" });
	expect(h.spawns()).toHaveLength(2);
	expect(flagOf(h.spawns()[1]?.argv, "--conversation")).toBeUndefined();
	expect(h.inputs()).toEqual([`${FLOORS}\n\nfresh`]);
	await driver.stop();
});

test("a prompt started while a mid-turn newSession settles is not cancelled by it", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold");
	await working.promise;
	const rebound = driver.newSession();
	const survivor = started(driver, "survivor");
	expect(await rebound).toEqual({ cancelled: true });
	expect(await survivor).toMatchObject({ status: "completed", text: "REPLY1:survivor" });
	expect(finals.map((final) => final.status)).toEqual(["aborted", "completed"]);
	expect(h.inputs()).toEqual([`${FLOORS}\n\n@hold`, `${FLOORS}\n\nsurvivor`]);
	await driver.stop();
});

test("the model list is the fixed model the state reports; another model and unknown cursors are refused", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	expect(await driver.availableModels()).toEqual(["agy/gemini-test"]);
	expect((await driver.state()).model).toBe("agy/gemini-test");
	expect(await driver.setModel("agy/gemini-test")).toBe("agy/gemini-test");
	expect(driver.setModel("agy/other")).rejects.toBeInstanceOf(OmpDriverError);
	expect(driver.entriesSince("no-such")).rejects.toMatchObject({ code: "unknown_since" });
	await started(driver, "one");
	const { entries, leafId } = await driver.entriesSince();
	expect(leafId).toBe(entries.at(-1)?.id ?? null);
	const after = await driver.entriesSince(entries[0]?.id);
	expect(after.entries).toHaveLength(entries.length - 1);
	await driver.stop();
	expect(existsSync(join(h.sessionDir, AGY_LAST_ANSWER_FILE))).toBe(true);
});

test("pre-init crash rejects openSession with OmpDriverError and emits 0 onExit events", async () => {
	const h = harness();
	const driver = h.make({ model: "@crash-init" });
	const exits: OmpExitInfo[] = [];
	driver.onExit((info) => exits.push(info));
	await driver.start();
	await expect(driver.openSession()).rejects.toBeInstanceOf(OmpDriverError);
	await driver.stop();
	expect(exits).toEqual([]);
});

test("an empty result.response preserves streamed text in final and agy-last-answer.txt", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	const final = await started(driver, "@empty-res");
	expect(final).toMatchObject({ status: "completed", text: "STREAMED-OK" });
	expect(readFileSync(join(h.sessionDir, AGY_LAST_ANSWER_FILE), "utf8")).toBe("STREAMED-OK");
	await driver.stop();
});

test("abort with a steer queued ends the turn `aborted` and says the steer was not delivered", async () => {
	const h = harness();
	const driver = h.make();
	const finals: OmpFinal[] = [];
	driver.onFinal((final) => finals.push(final));
	await driver.start();
	const working = Promise.withResolvers<void>();
	driver.onEvent((event) => event.type === "message_update" && working.resolve());
	await driver.prompt("@hold");
	await working.promise;
	await driver.steer("steered");
	await driver.steer("more");
	expect((await driver.state()).queuedMessageCount).toBe(2);
	await driver.abort();
	expect(finals.map((final) => [final.status, final.error])).toEqual([["aborted", "cancelled (steer 2건 미전달)"]]);
	expect(finals[0]?.droppedSteers).toBe(2);
	expect((await driver.state()).queuedMessageCount).toBe(0);
	expect(await started(driver, "next")).toMatchObject({ status: "completed", text: "REPLY1:next" });
	await driver.stop();
});

test("a SUCCESS result ending with agy's standalone quota line turns into a 429 error and retires the child", async () => {
	const h = harness();
	const driver = h.make();
	await driver.start();
	const quota = await started(driver, "@end-quota");
	const firstPid = h.lastPid();
	expect(quota.status).toBe("error");
	expect(quota.error).toBe(
		"agy rate limited (429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.",
	);
	expect(await started(driver, "after")).toMatchObject({ status: "completed", text: "REPLY1:after" });
	expect(alive(firstPid)).toBe(false);
	expect(h.spawns()).toHaveLength(2);
	await driver.stop();
});
