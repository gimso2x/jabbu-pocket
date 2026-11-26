import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTaskDetail } from "../src/dashboard/detail";
import { buildSnapshot, type SnapshotDeps, type TaskInfo } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-26T00:00:00Z");
const TASK_ID = "T-20261126-01";

const task = (extra: Partial<TaskInfo> = {}): TaskInfo => ({
	taskId: TASK_ID,
	title: "멈춤 표시",
	risk: "L1",
	status: "working",
	host: "local",
	agent: "t-20261126-01",
	runtime: "headless",
	branch: `task/${TASK_ID}`,
	open: true,
	updatedAt: "2026-11-26T09:00:00+09:00",
	acTotal: 1,
	...extra,
});

describe("a paused TASK shows it in the detail panel", () => {
	test("the status badge stays 진행 중; a separate 멈춤 중 badge appears only while paused", () => {
		const paused = renderTaskDetail(TASK_ID, task({ pausedAt: NOW }));
		expect(paused).toContain('<span class="badge is-info">진행 중</span><span class="badge is-warning" title=');
		expect(paused).toContain(">멈춤 중</span>");
		const running = renderTaskDetail(TASK_ID, task());
		expect(running).toContain("진행 중");
		expect(running).not.toContain("멈춤 중");
	});
});

describe("snapshot pausedAt follows the ledger's pause and unpause marks", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "jabbu-task-paused-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	test("unset, then set after a pause, unset again after a resume; status is never changed", async () => {
		let now = NOW;
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(home, "jabbu.db"),
			clock: { now: () => now },
			redact: (text) => text,
		});
		const row = store.tasks.register({
			title: "멈춤",
			risk: "L1",
			originKey: "discord/ch/300000000000000001/t/100000000000000001",
			threadRef: "300000000000000001:100000000000000001",
			host: null,
			repo: "/r/repo",
			acceptance: [],
			runtime: "headless",
		});
		const deps: SnapshotDeps = {
			homeDir: home,
			repoDir: "/srv/jabbu",
			timezone: "Asia/Seoul",
			config: undefined,
			now: () => now,
			callDaemon: async () => {
				throw new Error("no daemon");
			},
			run: async () => ({ code: 1, stdout: "", timedOut: false }),
			ompVersion: async () => "omp-stub 0.0.0",
			hostOps: () => {
				throw new Error("no hosts");
			},
			collectGates: () => [],
		};
		const read = async () => {
			const snapshot = await buildSnapshot(deps);
			if (!snapshot.tasks.ok) throw new Error("tasks section missing");
			const found = snapshot.tasks.items.find((t) => t.taskId === row.taskId);
			if (found === undefined) throw new Error("task missing");
			return found;
		};
		expect((await read()).pausedAt).toBeUndefined();
		now += 60_000;
		store.tasks.pauseTask(row.taskId);
		now += 60 * 60_000;
		const paused = await read();
		expect(paused.pausedAt).toBe(NOW + 60_000);
		expect(paused.status).toBe("working");
		store.tasks.unpauseTask(row.taskId);
		const resumed = await read();
		expect(resumed.pausedAt).toBeUndefined();
		expect(resumed.status).toBe("working");
		store.close();
	});
});
