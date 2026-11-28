// A recurring cron monitor with nowhere to report to (no channel, no owner home yet) must not queue an
// admitted backlog that replays every stale fire once the owner writes: its due slots are recorded as skipped
// instead, and the monitor fires again at its next slot once routable. One-shot `at` monitors still wait
// (AC-A3 in test/owner-home.test.ts); only the recurring path skips.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { MonitorScheduler } from "../src/monitors/scheduler";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
const MINUTE = 60_000;

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
let logLines: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-monitors-unroutable-"));
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "workspace"));
	clock = new FakeClock();
	logLines = [];
	const log = createLogger({ sink: (line) => logLines.push(line), clock, redact });
	// No owner home: no DM origin, no inbound row, no `!home` — `ownerHome()` is undefined.
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock, redact });
	scheduler = new MonitorScheduler({
		store,
		router: { route: async () => {}, newEpochIfIdle: async () => false },
		clock,
		log,
		scriptsRoot: join(dir, "scripts"),
		workspaceDir: join(dir, "workspace"),
		homeDir: dir,
	});
	scheduler.start();
});

afterEach(async () => {
	await scheduler.idle();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const unroutableSkipped = (): string[] => logLines.filter((line) => line.includes("reason=unroutable"));

describe("monitors: unroutable recurring monitor", () => {
	test("due cron slots are skipped, not queued, while there is nowhere to report to", async () => {
		const monitor = store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "check the thing",
			overlap: "queue",
			enabled: true,
		});
		clock.advance(3 * MINUTE);
		const first = await scheduler.tick();
		await scheduler.idle();
		expect(first.claimed).toBe(0);
		expect(first.skippedCatchUp).toBe(3);
		expect(first.dispatched).toBe(0);
		expect(store.monitors.listEvents()).toEqual([]);
		expect(store.monitors.listSlots(monitor.id).filter((slot) => slot.reason === "unroutable")).toHaveLength(3);
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(clock.now());
		expect(unroutableSkipped()).toHaveLength(1);
		expect(logLines.filter((line) => line.includes("event=owner_notice_unroutable"))).toEqual([]);

		// A second tick keeps skipping without warning again.
		clock.advance(MINUTE);
		const second = await scheduler.tick();
		await scheduler.idle();
		expect(second.claimed).toBe(0);
		expect(second.skippedCatchUp).toBe(1);
		expect(store.monitors.listEvents()).toEqual([]);
		expect(unroutableSkipped()).toHaveLength(1);

		// Once the owner has a home, the next slot claims and dispatches; the skipped slots never replay.
		store.setOwnerHome({ platform: "discord", conversationId: "123456789012345678" }); // gitleaks:allow (fake snowflake)
		clock.advance(MINUTE);
		const third = await scheduler.tick();
		await scheduler.idle();
		expect(third.claimed).toBe(1);
		expect(third.dispatched).toBe(1);
		expect(store.monitors.listEvents()).toHaveLength(1);
	});

	test("a channelled cron monitor still claims while there is no owner home", async () => {
		const monitor = store.monitors.addMonitor({
			name: "watch",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "check the thing",
			overlap: "queue",
			enabled: true,
			channel: "300000000000000002",
		});
		clock.advance(MINUTE);
		const summary = await scheduler.tick();
		await scheduler.idle();
		expect(summary.claimed).toBe(1);
		expect(store.monitors.listEvents().map((event) => event.stage)).toEqual(["dispatched"]);
		expect(store.monitors.listSlots(monitor.id).filter((slot) => slot.reason === "unroutable")).toEqual([]);
		expect(unroutableSkipped()).toEqual([]);
	});
});
