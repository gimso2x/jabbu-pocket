// T-20261124-02 (doc/plans/idle-keep-resident.md): a resting conversation child stays unless the host is under session
// or memory pressure (the router's call); `idleKeepResident: false`, monitors and lanes keep the plain idle stop; one
// failing `state()` never stops the other origins' judgment; a refused lane start asks for a sweep at once.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdleHostPressure } from "../src/core/idle-keep";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { IDLE_STOP_MS, type InboundRecord, MONITOR_IDLE_STOP_MS } from "../src/core/types";
import { LaneInputError } from "../src/lanes/manager-constants";
import { laneOriginKey } from "../src/lanes/status";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
import type { OmpState } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const MIN = 60_000;
const chat = (n: number) => `discord/dm/20000000000000000${n}`;

let dir: string;
let now: number;
let store: Store;
let router: OriginRouter;
let logs: string[];
let percents: Map<string, number | "throws">;
let pressure: () => IdleHostPressure;
let keepResident: boolean;
/** Origins whose fake turn never finishes. */
let held: Set<string>;
let pressureCalls: number;

class PercentDriver extends FakeOmpDriver {
	readonly #origin: string;
	constructor(origin: string, options: ConstructorParameters<typeof FakeOmpDriver>[0]) {
		super(options);
		this.#origin = origin;
	}
	override async state(): Promise<OmpState> {
		const percent = percents.get(this.#origin);
		if (percent === "throws") throw new Error("state timeout");
		const base = await super.state();
		return percent === undefined ? base : { ...base, context: { tokens: null, window: 1000, percent } };
	}
}

function buildRouter(): OriginRouter {
	const sessions = new FakeSessionStore();
	const clock = { now: () => now };
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		idleKeep: {
			keepResident,
			hostPressure: () => {
				pressureCalls += 1;
				return pressure();
			},
		},
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		statusProvider: () => "status: ok",
		driverFactory: (origin, sessionDir) =>
			new PercentDriver(origin, { sessionDir, store: sessions, ...(held.has(origin) ? { holdTurns: true } : {}) }),
	});
}

let counter = 0;
const msg = (originKey: string): InboundRecord => {
	const id = `k${++counter}`;
	return { platformMessageId: id, originKey, ownerVerified: true, text: "hi", threadRef: id };
};

/** One finished turn on `origin` (the sweep queues behind the turn's final handler). */
async function work(origin: string): Promise<void> {
	await router.route(msg(origin));
	await router.mailbox(origin).sweepIdle();
}

const running = (origin: string) => router.mailbox(origin).state.driverRunning;
const reasons = () => logs.filter((l) => l.includes("event=idle_stop")).map((l) => /reason=(\w+)/.exec(l)?.[1]);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-idlekeep-"));
	now = 1_000_000;
	store = openBotStore(join(dir, "ompbot.db"), { now: () => now }, "Asia/Seoul");
	logs = [];
	percents = new Map();
	keepResident = true;
	held = new Set();
	pressureCalls = 0;
	pressure = () => ({ sessionFull: false, memoryLow: false });
	router = buildRouter();
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("host pressure releases resting conversation children", () => {
	test("a full session count releases due children, longest rested first, and stops below the ceiling", async () => {
		const origins = [1, 2, 3, 4].map(chat);
		for (const n of [1, 2, 3]) {
			await work(chat(n));
			now += MIN;
		}
		now += IDLE_STOP_MS;
		await work(chat(4)); // activity now: not due
		const external = 3;
		const ceiling = 6;
		pressure = () => ({
			sessionFull: external + origins.filter(running).length >= ceiling,
			memoryLow: false,
		});
		expect(await router.sweepIdle()).toBe(2);
		expect(origins.map(running)).toEqual([false, false, true, true]);
		expect(reasons()).toEqual(["host_pressure", "host_pressure"]);
	});

	test("a child with a turn in flight is never released, whatever the pressure", async () => {
		await work(chat(1));
		held.add(chat(5));
		await router.route(msg(chat(5))); // its turn never finishes
		now += 2 * IDLE_STOP_MS;
		pressure = () => ({ sessionFull: true, memoryLow: true });
		expect(router.mailbox(chat(5)).state.busy).toBe(true);
		expect(await router.sweepIdle()).toBe(1); // chat(1) only; the sweep asks for no more once none is due
		expect([running(chat(1)), running(chat(5))]).toEqual([false, true]);
		expect(router.mailbox(chat(5)).state.busy).toBe(true);
	});

	test("memory pressure releases one child per sweep, the longest rested", async () => {
		for (const n of [1, 2, 3]) {
			await work(chat(n));
			now += MIN;
		}
		now += IDLE_STOP_MS;
		pressure = () => ({ sessionFull: false, memoryLow: true });
		expect(await router.sweepIdle()).toBe(1);
		expect([1, 2, 3].map((n) => running(chat(n)))).toEqual([false, true, true]);
		expect(await router.sweepIdle()).toBe(1);
		expect([1, 2, 3].map((n) => running(chat(n)))).toEqual([false, false, true]);
	});

	test("a child released for the session ceiling defers the memory judgment to the next sweep", async () => {
		for (const n of [1, 2, 3]) {
			await work(chat(n));
			now += MIN;
		}
		now += IDLE_STOP_MS;
		// Full while all three run; one release brings the count below the ceiling.
		pressure = () => ({ sessionFull: [1, 2, 3].every((n) => running(chat(n))), memoryLow: true });
		expect(await router.sweepIdle()).toBe(1);
		expect([1, 2, 3].map((n) => running(chat(n)))).toEqual([false, true, true]);
		expect(await router.sweepIdle()).toBe(1); // the next sweep: memory releases one more
		expect([1, 2, 3].map((n) => running(chat(n)))).toEqual([false, false, true]);
	});

	test("unreadable pressure (undefined) releases nothing", async () => {
		await work(chat(1));
		now += IDLE_STOP_MS;
		pressure = () => ({ sessionFull: undefined, memoryLow: undefined });
		expect(await router.sweepIdle()).toBe(0);
		expect(running(chat(1))).toBe(true);
	});

	test("no resting child means the host is not even read", async () => {
		await work(chat(1));
		expect(await router.sweepIdle()).toBe(0);
		expect(pressureCalls).toBe(0);
	});

	test("a child that is not due yet is not a pressure candidate", async () => {
		await work(chat(1));
		now += IDLE_STOP_MS - 1;
		pressure = () => ({ sessionFull: true, memoryLow: true });
		expect(await router.sweepIdle()).toBe(0);
		expect(running(chat(1))).toBe(true);
	});
});

describe("legacy and other origin kinds", () => {
	const monitorId = () =>
		store.monitors.addMonitor({
			name: "retro",
			trigger: { kind: "cron", schedule: "0 23 * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		}).id;

	test("idleKeepResident=false stops a due conversation child with reason=legacy", async () => {
		keepResident = false;
		await router.close();
		router = buildRouter();
		await work(chat(1));
		now += IDLE_STOP_MS - 1;
		expect(await router.sweepIdle()).toBe(0);
		now += 1;
		expect(await router.sweepIdle()).toBe(1);
		expect(running(chat(1))).toBe(false);
		expect(reasons()).toEqual(["legacy"]);
	});

	test("with the default on, monitors stop after 2 minutes and lanes after 30, both as legacy", async () => {
		const monitor = monitorOrigin(monitorId());
		const lane = laneOriginKey("work");
		await work(monitor);
		await work(lane);
		now += MONITOR_IDLE_STOP_MS;
		expect(await router.sweepIdle()).toBe(1);
		expect([running(monitor), running(lane)]).toEqual([false, true]);
		now += IDLE_STOP_MS - MONITOR_IDLE_STOP_MS;
		expect(await router.sweepIdle()).toBe(1);
		expect(running(lane)).toBe(false);
		expect(reasons()).toEqual(["legacy", "legacy"]);
	});

	test("a failing state() keeps its own child and does not stop other origins' judgment", async () => {
		await work(chat(1));
		await work(chat(2));
		await work(chat(3));
		percents.set(chat(1), "throws");
		percents.set(chat(2), 80);
		percents.set(chat(3), 10);
		now += IDLE_STOP_MS;
		expect(await router.sweepIdle()).toBe(1);
		expect([1, 2, 3].map((n) => running(chat(n)))).toEqual([true, false, true]);
		expect(reasons()).toEqual(["context"]);
		expect(logs.filter((l) => l.includes("event=idle_state_failed"))).toHaveLength(1);
	});
});

describe("a lane start under pressure asks for a sweep", () => {
	let home: TestHome;
	let repos: string[];
	beforeEach(() => {
		home = makeHome("ompbot-idlekeep-home-");
		repos = [];
	});
	afterEach(() => {
		home.remove();
		for (const repo of repos) removeRepoAndWorktrees(repo);
	});

	test("a refusal at the session ceiling asks once; a roomy host does not ask", async () => {
		const repo = makeRepo(repos);
		let requests = 0;
		const onPressure = () => {
			requests += 1;
		};
		const full = laneHarness(home.dir, {
			hostSessions: { ceiling: 1, list: () => [["omp", "--mode", "rpc"]], onPressure },
		});
		const refused = await full.manager
			.start({ title: "full", cwd: repo, channel: CHANNEL })
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(requests).toBe(1);
		full.close();

		const roomy = laneHarness(home.dir, { hostSessions: { ceiling: 5, list: () => [], onPressure } });
		await roomy.manager.start({ title: "roomy", cwd: repo, channel: CHANNEL });
		await roomy.settle();
		expect(requests).toBe(1);
		roomy.close();
	});
});
