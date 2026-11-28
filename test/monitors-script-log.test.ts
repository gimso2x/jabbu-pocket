// A steady met script check must not log `monitor_script fired=true` every interval: for `fire: "edge"` with
// the state already `met`, nothing is claimed, so there is nothing to log — the same steady-state rule the code
// already applies to quiet unmet checks. A `fire: "every"` met check always claims, so it still logs each time.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	dir = mkdtempSync(join(tmpdir(), "jabbu-monitors-script-log-"));
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

async function tick(): Promise<void> {
	await scheduler.tick();
	await scheduler.idle();
}

const scriptLines = (monitorId: string): string[] =>
	logLines.filter((line) => line.includes("event=monitor_script ") && line.includes(`monitor=${monitorId} `));

describe("monitors: steady met script checks", () => {
	test("an edge check that stays met logs its first fire once and then stays quiet", async () => {
		const script = writeScript("met.sh", "#!/bin/sh\nexit 0\n");
		const monitor = store.monitors.addMonitor({
			name: "edge",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE, fire: "edge" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		store.setOwnerHome({ platform: "discord", conversationId: "123456789012345678" }); // gitleaks:allow (fake snowflake)
		for (let i = 0; i < 3; i++) {
			clock.advance(MINUTE);
			await tick();
		}
		expect(scriptLines(monitor.id)).toHaveLength(1);
		expect(scriptLines(monitor.id)[0]).toContain("fired=true");
		expect(store.monitors.listEvents()).toHaveLength(1);
	});

	test("an every check that stays met logs — and claims — on every interval", async () => {
		const script = writeScript("met.sh", "#!/bin/sh\nexit 0\n");
		const monitor = store.monitors.addMonitor({
			name: "every",
			trigger: { kind: "script", command: [script], intervalMs: MINUTE, fire: "every" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		store.setOwnerHome({ platform: "discord", conversationId: "123456789012345678" }); // gitleaks:allow (fake snowflake)
		for (let i = 0; i < 3; i++) {
			clock.advance(MINUTE);
			await tick();
		}
		expect(scriptLines(monitor.id)).toHaveLength(3);
		expect(scriptLines(monitor.id).every((line) => line.includes("fired=true"))).toBe(true);
		expect(store.monitors.listEvents()).toHaveLength(3);
	});
});
