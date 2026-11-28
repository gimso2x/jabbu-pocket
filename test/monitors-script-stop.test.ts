// `stop()` must abort an in-flight script check like it aborts cron commands: otherwise the daemon's shutdown
// waits on `idle()` for up to the 60s script timeout, and a check that finishes during the drain still claims and
// dispatches into a router that has stopped accepting. After `stop()` no new check may start either.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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

/** Resolves when `idle()` does; rejects after the bound, so a shutdown that waits out the script fails fast. */
async function idleBefore(ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			scheduler.idle(),
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => reject(new Error("idle timed out")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-monitors-script-stop-"));
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "workspace"));
	clock = new FakeClock();
	logLines = [];
	const log = createLogger({ sink: (line) => logLines.push(line), clock, redact });
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

function writeScript(name: string, body: string): string {
	const path = join(dir, "scripts", name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

const marker = () => join(dir, "started.txt");
const starts = (): number => {
	try {
		return readFileSync(marker(), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line !== "").length;
	} catch {
		return 0;
	}
};

/** Resolves once the slow script has started `n` times: the marker file is the event, the timer only bounds the wait. */
const START_BOUND_MS = 10_000;
async function waitForStarts(n: number): Promise<void> {
	if (starts() >= n) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`slow script did not start ${n} time(s)`));
		}, START_BOUND_MS);
		const watcher = watch(dir, () => {
			if (starts() < n) return;
			clearTimeout(timer);
			watcher.close();
			resolve();
		});
		// The marker may have landed between the check above and the watch: re-check after attaching.
		if (starts() >= n) {
			clearTimeout(timer);
			watcher.close();
			resolve();
		}
	});
}

function addSlowScriptMonitor() {
	// Marks its start, then sleeps far past the idle bound: without an abort the shutdown waits it out.
	const script = writeScript("slow.sh", `#!/bin/sh\necho started >> "${marker()}"\nsleep 30\n`);
	return store.monitors.addMonitor({
		name: "slow",
		trigger: { kind: "script", command: [script], intervalMs: MINUTE },
		instruction: "check the thing",
		overlap: "queue",
		enabled: true,
	});
}

describe("monitors: script checks on stop()", () => {
	test("stop() aborts an in-flight check: idle resolves at once and nothing is claimed", async () => {
		const monitor = addSlowScriptMonitor();
		clock.advance(MINUTE);
		await scheduler.tick(); // the check starts; the tick itself does not wait for it
		await waitForStarts(1);

		scheduler.stop();
		await idleBefore(3000);
		expect(starts()).toBe(1);
		expect(store.monitors.listEvents()).toEqual([]);
		expect(store.monitors.getMonitor(monitor.id)?.lastScriptState).toBeNull();
		expect(store.monitors.getMonitor(monitor.id)?.checkErrorStreak).toBe(0);
		expect(logLines.filter((line) => line.includes("event=monitor_script_aborted"))).toHaveLength(1);
		expect(logLines.filter((line) => line.includes("event=monitor_script "))).toEqual([]);
	});

	test("no new check starts after stop(), even once the interval has passed", async () => {
		const monitor = addSlowScriptMonitor();
		clock.advance(MINUTE);
		await scheduler.tick();
		await waitForStarts(1);
		const cursorBefore = store.monitors.getMonitor(monitor.id)?.cursorAt;

		scheduler.stop();
		await idleBefore(3000);
		clock.advance(MINUTE);
		await scheduler.tick();
		await scheduler.idle();
		expect(starts()).toBe(1);
		expect(store.monitors.getMonitor(monitor.id)?.cursorAt).toBe(cursorBefore);
		expect(store.monitors.listEvents()).toEqual([]);
	});
});
