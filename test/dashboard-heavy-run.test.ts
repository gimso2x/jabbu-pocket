// The top-bar test chip: read fresh from heavy-run's state files, no config needed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { buildSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { type HeavyRunState, heavyRunPaths, writeHeavyRunState } from "../src/heavy-run";

/** 2026-11-19 12:00 KST. */
const NOW = Date.parse("2026-11-19T03:00:00Z");

let home: string;
let stateDir: string;
const saved = process.env.JABBU_HEAVY_RUN_DIR;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-heavy-dash-"));
	stateDir = mkdtempSync(join(tmpdir(), "jabbu-heavy-state-"));
	process.env.JABBU_HEAVY_RUN_DIR = stateDir;
});
afterEach(() => {
	if (saved === undefined) delete process.env.JABBU_HEAVY_RUN_DIR;
	else process.env.JABBU_HEAVY_RUN_DIR = saved;
	rmSync(home, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

function deps(): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/jabbu",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		callDaemon: async () => {
			throw new Error("no daemon");
		},
		run: async () => ({ code: 0, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
	};
}

const state = (pid: number, label: string, kind: "waiting" | "running", agoMs: number): HeavyRunState => ({
	pid,
	cwd: `/srv/work/${label}`,
	argv: ["bun", "test"],
	label,
	state: kind,
	since: NOW - agoMs,
	...(kind === "running" ? { lockedPid: pid } : {}),
});

describe("heavy-run chip", () => {
	test("one running, two waiting and a dead pid: the chip reads `<label> … · 대기 2`, with no opsStatus configured", async () => {
		const paths = heavyRunPaths();
		writeHeavyRunState(paths, state(process.pid, "jabbu-t-run", "running", 125_000));
		writeHeavyRunState(paths, state(process.ppid, "jabbu-t-wait-a", "waiting", 60_000));
		writeHeavyRunState(paths, state(1, "jabbu-t-wait-b", "waiting", 30_000));
		writeHeavyRunState(paths, state(2 ** 22 + 99, "jabbu-t-dead", "waiting", 10_000));

		const snapshot = await buildSnapshot(deps());
		expect(snapshot.hostChecks).toBeUndefined();
		expect(snapshot.heavyRun?.ok && snapshot.heavyRun.waiting.map((w) => w.label)).toEqual([
			"jabbu-t-wait-a",
			"jabbu-t-wait-b",
		]);

		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "inbox" });
		expect(html).toContain("🧪 jabbu-t-run");
		expect(html).toMatch(/🧪 jabbu-t-run [^<]*· 대기 2</);
		expect(html).toContain("jabbu-t-wait-a");
		expect(html).not.toContain("jabbu-t-dead");
	});

	test("nothing running or waiting: no chip", async () => {
		const snapshot = await buildSnapshot(deps());
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "inbox" });
		expect(html).not.toContain("heavy-pop");
	});
});
