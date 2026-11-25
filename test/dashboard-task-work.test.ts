import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderItemDetail, renderTaskDetail, renderTaskWork } from "../src/dashboard/detail";
import { renderDashboardPage, SCRIPT } from "../src/dashboard/html";
import {
	buildSnapshot,
	type DashboardSnapshot,
	type FlowChainInfo,
	type SnapshotDeps,
	type TaskInfo,
} from "../src/dashboard/snapshot";
import { taskOriginKey } from "../src/lanes/status";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-26T00:00:00Z");
const TASK_ID = "T-20261126-01";
const AGENT = "t-20261126-01";

const task = (extra: Partial<TaskInfo> = {}): TaskInfo => ({
	taskId: TASK_ID,
	title: "작업 내역",
	risk: "L3",
	status: "working",
	host: "local",
	agent: AGENT,
	runtime: "headless",
	branch: `task/${TASK_ID}`,
	open: true,
	updatedAt: "2026-11-26T09:00:00+09:00",
	acTotal: 8,
	herdr: { ok: true, status: "working" },
	...extra,
});

/** The panel's read addresses for `agent`'s session origin. */
const addresses = (agent: string) => {
	const origin = encodeURIComponent(taskOriginKey(agent));
	return {
		conversation: `data-conversation="api/thread/conversation?origin=${origin}"`,
		live: `data-live="api/thread/live/events?origin=${origin}"`,
	};
};

const flowChain = (): FlowChainInfo => ({
	threadRef: "300000000000000001:100000000000000001",
	originKey: "",
	place: null,
	title: "요청",
	requestedAt: null,
	updatedAt: "2026-11-26T09:00:00+09:00",
	done: 0,
	total: 1,
	here: null,
	now: "진행 중",
	discordHref: "",
	tasks: [
		{
			taskId: TASK_ID,
			title: "작업 내역",
			status: "working",
			risk: "L3",
			host: "local",
			branch: `task/${TASK_ID}`,
			createdAt: "2026-11-26T08:00:00+09:00",
			acTotal: 8,
			stage: { label: "작업", msg: "", tone: "run" },
		},
	],
});

const snapshotWith = (info: TaskInfo): DashboardSnapshot => ({
	generatedAt: "2026-11-26T09:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: { ok: false, error: "daemon_down" },
	turns: { ok: true, items: [], threads: [] },
	tasks: { ok: true, items: [info] },
	flows: { ok: true, items: [flowChain()] },
	lanes: { ok: false, error: "no_db" },
	herdr: { ok: false, error: "off" },
	approvals: { ok: false, error: "no_db" },
	monitors: { ok: false, error: "no_db" },
	alerts: { ok: false, error: "no_db" },
	gates: { ok: false, error: "no_db" },
	backup: { ok: false, error: "no_db" },
	jobs: { ok: false, error: "no_db" },
});

describe("AC-1: 작업 내역 panel", () => {
	test("a headless TASK's detail carries the panel on its own origin's conversation and live addresses, with the write form hidden until signed in", () => {
		const html = renderTaskDetail(TASK_ID, task());
		const { conversation, live } = addresses(AGENT);
		expect(html).toContain(`aria-label="작업 내역" data-task-work="${TASK_ID}"`);
		expect(html).toContain(conversation);
		expect(html).toContain(live);
		expect(html).toContain('data-running="1"');
		expect(html).toContain('<form class="task-work-form" data-task-work-form hidden>');
		expect(html).toContain('data-task-work-control="pause"');
		expect(html).toContain('data-task-work-control="resume"');
	});

	test("the flow view's item uses the same panel; a herdr TASK has none in either place", () => {
		const headless = task();
		expect(renderItemDetail(snapshotWith(headless), "flow", TASK_ID)).toContain(renderTaskWork(headless));
		const herdr = task({ runtime: "herdr" });
		expect(renderTaskWork(herdr)).toBe("");
		expect(renderTaskDetail(TASK_ID, herdr)).not.toContain("data-task-work");
		expect(renderItemDetail(snapshotWith(herdr), "flow", TASK_ID)).not.toContain("data-task-work");
	});

	test("a closed headless TASK keeps its conversation read-only (no form); an idle one opens no live stream", () => {
		const closed = renderTaskWork(task({ status: "done", open: false, herdr: { ok: true, status: "idle" } }));
		expect(closed).toContain(addresses(AGENT).conversation);
		expect(closed).not.toContain("data-task-work-form");
		expect(closed).toContain('data-running=""');
	});

	test("the page ships the panel (server render = client render) and its script compiles", () => {
		const page = renderDashboardPage(snapshotWith(task()), { task: TASK_ID });
		expect(page).toContain(renderTaskWork(task()));
		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn { renderTaskWork, renderTaskDetail };`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as { renderTaskWork: typeof renderTaskWork };
		expect(client.renderTaskWork(task())).toBe(renderTaskWork(task()));
		// The read-only wording the page shows when the web chat sign-in is missing (AC-5's 강등).
		expect(SCRIPT).toContain("개입은 웹 대화 인증이 필요합니다(디스코드로 가능)");
		expect(SCRIPT).toContain('fetch("api/web/conversations"');
	});
});

describe("AC-1: snapshot", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "jabbu-task-work-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	test("TaskInfo.runtime is the row's runtime, and turns.threads carries no jabbu/task/ origin", async () => {
		const store = openStore({
			timezone: "Asia/Seoul",
			path: join(home, "jabbu.db"),
			clock: { now: () => NOW },
			redact: (text) => text,
		});
		const chat = "discord/ch/300000000000000001/t/100000000000000001";
		const registered = (title: string, runtime: "herdr" | "headless") =>
			store.tasks.register({
				title,
				risk: "L1",
				originKey: chat,
				threadRef: "300000000000000001:100000000000000001",
				host: null,
				repo: "/r/repo",
				acceptance: [],
				runtime,
			});
		const headless = registered("헤드리스", "headless");
		const herdr = registered("herdr", "herdr");
		for (const [origin, id] of [
			[chat, "m1"],
			[taskOriginKey(headless.agent), `task:${headless.agent}:start:1`],
		] as const) {
			store.ensureOrigin(origin, join(home, "sessions", encodeURIComponent(origin)));
			store.recordInbound({ originKey: origin, platformMessageId: id, textRef: "요청", threadRef: "ch:1" });
		}
		store.close();
		const deps: SnapshotDeps = {
			homeDir: home,
			repoDir: "/srv/jabbu",
			timezone: "Asia/Seoul",
			config: undefined,
			now: () => NOW,
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
		const snapshot = await buildSnapshot(deps);
		if (!snapshot.tasks.ok || !snapshot.turns.ok) throw new Error("sections missing");
		const runtimeOf = (id: string) => snapshot.tasks.ok && snapshot.tasks.items.find((t) => t.taskId === id)?.runtime;
		expect(runtimeOf(headless.taskId)).toBe("headless");
		expect(runtimeOf(herdr.taskId)).toBe("herdr");
		const origins = snapshot.turns.threads.map((thread) => thread.originKey);
		expect(origins).toContain(chat);
		expect(origins.filter((origin) => origin.includes("jabbu/task/"))).toEqual([]);
	});
});
