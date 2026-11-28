// A one-shot `at` monitor held by a freeze must fire once after unfreeze even when the daemon was down while the
// freeze was lifted: the in-memory hold (`#heldAt`) does not survive a restart, so the `<home>/unfrozen-at` lift
// stamp is the durable evidence. A slot that came due before the lift effectively came due at the lift, so the
// 24h catch-up age runs from the lift — but only for a day after it, after which the fire is stale like any other.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "../src/log";
import { MonitorScheduler } from "../src/monitors/scheduler";
import { clearFreeze, writeFreeze } from "../src/ops/freeze";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class FakeClock {
	t = T0;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

let dir: string;
let clock: FakeClock;
let store: Store;
let scheduler: MonitorScheduler;
let log: Logger;
let logLines: string[];

function makeScheduler(): MonitorScheduler {
	const fresh = new MonitorScheduler({
		store,
		router: { route: async () => {}, newEpochIfIdle: async () => false },
		clock,
		log,
		scriptsRoot: join(dir, "scripts"),
		workspaceDir: join(dir, "workspace"),
		homeDir: dir,
	});
	fresh.start();
	return fresh;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-monitors-frozen-hold-"));
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "workspace"));
	clock = new FakeClock();
	logLines = [];
	log = createLogger({ sink: (line) => logLines.push(line), clock, redact });
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock, redact });
	scheduler = makeScheduler();
});

afterEach(async () => {
	await scheduler.idle();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function addDueOneShot() {
	return store.monitors.addMonitor({
		name: "once",
		trigger: { kind: "at", at: new Date(T0 + MINUTE).toISOString() },
		instruction: "do it",
		overlap: "queue",
		enabled: true,
	});
}

describe("monitors: frozen one-shot hold across an unfreeze-while-down restart", () => {
	test("a slot due during the freeze fires once after the lift, even though the daemon was down", async () => {
		const monitor = addDueOneShot();
		writeFreeze(dir, { by: "cli", now: T0 });
		// The daemon is down: no tick runs while the slot comes due and the freeze is lifted.
		clock.advance(25 * HOUR);
		expect(clearFreeze(dir, clock.now())).toBe(true);
		// A home to report to, so the claimed fire can dispatch (claiming is what this test pins).
		store.setOwnerHome({ platform: "discord", conversationId: "123456789012345678" }); // gitleaks:allow (fake snowflake)
		scheduler = makeScheduler(); // restart: a fresh process with an empty in-memory hold set
		const summary = await scheduler.tick();
		await scheduler.idle();
		expect(summary.claimed).toBe(1);
		expect(summary.skippedCatchUp).toBe(0);
		expect(summary.dispatched).toBe(1);
		expect(store.monitors.listEvents().map((event) => event.stage)).toEqual(["dispatched"]);
		expect(store.monitors.listSlots(monitor.id).filter((slot) => slot.reason === "catchup_age")).toEqual([]);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
		expect(logLines.filter((line) => line.includes("event=monitor_slots_skipped"))).toEqual([]);
	});

	test("the hold only lasts a day past the lift: a restart later than that still skips the stale slot", async () => {
		const monitor = addDueOneShot();
		writeFreeze(dir, { by: "cli", now: T0 });
		clock.advance(25 * HOUR);
		expect(clearFreeze(dir, clock.now())).toBe(true);
		clock.advance(25 * HOUR); // the lift itself is now more than a day old
		scheduler = makeScheduler();
		const summary = await scheduler.tick();
		await scheduler.idle();
		expect(summary.claimed).toBe(0);
		expect(summary.skippedCatchUp).toBe(1);
		expect(store.monitors.listEvents()).toEqual([]);
		expect(store.monitors.listSlots(monitor.id).filter((slot) => slot.reason === "catchup_age")).toHaveLength(1);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
	});

	test("a slot that came due after the lift was never held, so it still skips as stale", async () => {
		const monitor = addDueOneShot();
		writeFreeze(dir, { by: "cli", now: T0 });
		expect(clearFreeze(dir, clock.now())).toBe(true); // lifted at T0, before the slot came due
		clock.advance(25 * HOUR);
		scheduler = makeScheduler();
		const summary = await scheduler.tick();
		await scheduler.idle();
		expect(summary.claimed).toBe(0);
		expect(summary.skippedCatchUp).toBe(1);
		expect(store.monitors.listEvents()).toEqual([]);
		expect(store.monitors.listSlots(monitor.id).filter((slot) => slot.reason === "catchup_age")).toHaveLength(1);
		expect(store.monitors.getMonitor(monitor.id)?.enabled).toBe(false);
	});
});
