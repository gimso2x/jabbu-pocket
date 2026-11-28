import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import type { BoardView } from "../src/dashboard/board";
import { renderItemDetail, renderTaskDetail } from "../src/dashboard/detail";
import { SCRIPT } from "../src/dashboard/html";
import { inboxEntries } from "../src/dashboard/inbox";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { resolvePeers } from "../src/dashboard/peers";
import { buildSnapshot, type DashboardSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { renderTaskWork, withoutTaskThreads } from "../src/dashboard/task-work-client";
import { taskOriginKey } from "../src/lanes/status";
import { openStore } from "../src/store/db";
import type { TaskHostOps } from "../src/tasks/host";

const NOW = Date.parse("2026-11-28T01:00:00Z");
const MIN = 60_000;
const DAY = 24 * 3_600_000;
const CH_ROOT = "1570379273099943978";
const CH_TTUNGI = "1575736191767019612";

let tempRoot: string;
let ownHome: string;
let peerHome: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "jabbu-channel-board-"));
	ownHome = join(tempRoot, "own");
	peerHome = join(tempRoot, "ttungi");
	mkdirSync(ownHome, { recursive: true });
	mkdirSync(peerHome, { recursive: true });
});

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

const stubHostOps = (): TaskHostOps =>
	({
		pathExists: async () => ({ ok: true, value: false }),
		readFile: async () => ({ ok: true, value: undefined }),
		readText: async () => ({ ok: true, value: undefined }),
	}) as unknown as TaskHostOps;

const makeDeps = (extra: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
	homeDir: ownHome,
	repoDir: "/srv/jabbu-pocket",
	timezone: "Asia/Seoul",
	config: {
		dashboard: {
			channelNames: { [CH_ROOT]: "#루트", [CH_TTUNGI]: "#뚱기" },
			peerHomes: [{ name: "뚱기", home: peerHome }],
		},
	} as unknown as JabbuConfig,
	peers: resolvePeers({ port: 1, peerHomes: [{ name: "뚱기", home: peerHome }] }, "Asia/Seoul"),
	now: () => NOW,
	callDaemon: async () => {
		throw new Error("no daemon");
	},
	run: async () => ({ code: 1, stdout: "", timedOut: false }),
	ompVersion: async () => "omp-stub 0.0.0",
	hostOps: stubHostOps,
	collectGates: () => [],
	...extra,
});

function withDb(dir: string, fn: (db: Database) => void): void {
	const path = join(dir, "jabbu.db");
	openStore({ timezone: "Asia/Seoul", path, clock: { now: () => NOW }, redact: (s) => s }).close();
	const db = new Database(path, { strict: true });
	try {
		fn(db);
	} finally {
		db.close();
	}
}

function addInbound(
	db: Database,
	dir: string,
	id: string,
	origin: string,
	text: string,
	state: string,
	createdAt: number,
	threadRef: string,
): void {
	db.run("INSERT OR IGNORE INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
		origin,
		join(dir, "sessions", encodeURIComponent(origin)),
		NOW,
	]);
	db.run(
		`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, thread_ref)
		 VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
		[id, origin, text, state, createdAt, state === "dispatched" ? createdAt : null, threadRef],
	);
}

function addLane(
	db: Database,
	dir: string,
	name: string,
	title: string,
	status: string,
	cwd: string,
	updatedAt: number,
	meta: unknown = {},
): void {
	const origin = `jabbu/work/${name}`;
	db.run("INSERT OR IGNORE INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
		origin,
		join(dir, "sessions", encodeURIComponent(origin)),
		NOW,
	]);
	db.run(
		`INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, status, history, meta, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
		[
			name,
			title,
			`111111111111111111:${name}`,
			origin,
			cwd,
			join(dir, "sessions", encodeURIComponent(origin)),
			status,
			JSON.stringify(meta),
			updatedAt - 10 * MIN,
			updatedAt,
		],
	);
}

function registerTask(dir: string, title: string, ch: string, threadRef: string, repo: string, headless = true) {
	const store = openStore({
		timezone: "Asia/Seoul",
		path: join(dir, "jabbu.db"),
		clock: { now: () => NOW },
		redact: (s) => s,
	});
	try {
		return store.tasks.register({
			title,
			risk: "L2",
			originKey: `discord/ch/${ch}`,
			threadRef,
			host: null,
			repo,
			acceptance: [{ id: "AC-1", text: "ok" }],
			...(headless ? { runtime: "headless" as const } : {}),
		});
	} finally {
		store.close();
	}
}

describe("channel strip and lane-aware work board", () => {
	test("separates channel mains into top strip without bottom duplication and updates inbox active cards", async () => {
		withDb(ownHome, (db) => {
			addInbound(
				db,
				ownHome,
				"m1",
				`discord/ch/${CH_ROOT}`,
				"이전 요청 1",
				"answered",
				NOW - 20 * MIN,
				`${CH_ROOT}:1001`,
			);
			addInbound(
				db,
				ownHome,
				"m2",
				`discord/ch/${CH_ROOT}`,
				"현재 채널 최신 요청",
				"dispatched",
				NOW - 2 * MIN,
				`${CH_ROOT}:1002`,
			);
			addLane(
				db,
				ownHome,
				"L-20261128-01",
				"대시보드 개편",
				"working",
				"/home/ubuntu/work/wt/seopak-dash",
				NOW - 3 * MIN,
				{
					repo: "/home/ubuntu/work/jabbu-pocket",
				},
			);
			addInbound(
				db,
				ownHome,
				"m3",
				"jabbu/work/L-20261128-01",
				"긴 초기 지시문 프롬프트 본문",
				"dispatched",
				NOW - 3 * MIN,
				`${CH_ROOT}:1003`,
			);
		});
		withDb(peerHome, (db) => {
			addInbound(
				db,
				peerHome,
				"p1",
				`discord/ch/${CH_TTUNGI}`,
				"뚱기 채널 최신 요청",
				"answered",
				NOW - 5 * MIN,
				`${CH_TTUNGI}:1004`,
			);
		});

		const snap = await buildSnapshot(makeDeps());
		const turnsHtml = renderDashboardMain(snap, undefined, NOW, { view: "turns" });

		expect(turnsHtml).toContain('class="ch-strip"');
		expect(turnsHtml).toContain('<p class="card-title">#루트</p>');
		expect(turnsHtml).toContain('<p class="card-title">뚱기 · #뚱기</p>');
		expect(turnsHtml).toContain("현재 채널 최신 요청");
		expect(turnsHtml).toContain('<p class="ch-recent">이전: 이전 요청 1</p>');

		const inboxSplit = turnsHtml.split('<div class="inbox">');
		expect(inboxSplit.length).toBe(2);
		expect(inboxSplit[1]).not.toContain(`data-row="discord/ch/${CH_ROOT}"`);
		expect(inboxSplit[1]).not.toContain(`data-row="뚱기:discord/ch/${CH_TTUNGI}"`);
		expect(inboxSplit[1]).toContain("레인 · 본체 · jabbu-pocket");
		expect(inboxSplit[1]).toContain('<p class="card-title">대시보드 개편</p>');

		const inboxHtml = renderDashboardMain(snap, undefined, NOW, { view: "inbox" });
		expect(inboxHtml).toContain('<p class="active-title">현재 채널 최신 요청</p>');
		expect(inboxHtml).toContain('<p class="active-title">대시보드 개편</p>');
		expect(inboxHtml).toContain("레인 · jabbu-pocket");
	});

	test("includes peer and closed landing lanes, routes aged pending lanes to 확인 필요, and hides peer CLI", async () => {
		withDb(ownHome, (db) => {
			addLane(
				db,
				ownHome,
				"L-20261125-01",
				"오래된 머지 대기 레인",
				"closed",
				"/home/ubuntu/work/wt/kencrew-old",
				NOW - 3 * DAY,
				{
					repo: "gimso2x/kencrew",
					land: { state: "pending", prLand: { url: "https://github.com/gimso2x/kencrew/pull/42" } },
				},
			);
			addLane(
				db,
				ownHome,
				"L-20261125-02",
				"완전 종료 레인",
				"closed",
				"/home/ubuntu/work/wt/kencrew-done",
				NOW - 3 * DAY,
				{
					land: { state: "merged" },
				},
			);
		});
		withDb(peerHome, (db) => {
			addLane(
				db,
				peerHome,
				"L-20261128-09",
				"뚱기 PR 열린 레인",
				"closed",
				"/home/ubuntu/work/wt/ttungi-pr",
				NOW - 30 * MIN,
				{
					repo: "/home/ubuntu/work/jabbu-pocket",
					land: { state: "pr-open", prLand: { url: "https://github.com/gimso2x/jabbu-pocket/pull/9" } },
				},
			);
		});

		const snap = await buildSnapshot(makeDeps());
		expect(snap.lanes.ok).toBe(true);
		if (snap.lanes.ok) {
			const names = snap.lanes.items.map((l) => l.name);
			expect(names).toContain("L-20261125-01");
			expect(names).toContain("뚱기:L-20261128-09");
			expect(names).not.toContain("L-20261125-02");
			const peerLane = snap.lanes.items.find((l) => l.name === "뚱기:L-20261128-09");
			expect(peerLane?.install).toBe("뚱기");
			expect(peerLane?.landState).toBe("pr-open");
			expect(peerLane?.repo).toBe("jabbu-pocket");
		}

		const turnsHtml = renderDashboardMain(snap, undefined, NOW, { view: "turns" });
		const colAttention = turnsHtml.split('id="col-attention"')[1]?.split('id="col-working"')[0] ?? "";
		const colWorking = turnsHtml.split('id="col-working"')[1]?.split('id="col-done"')[0] ?? "";
		expect(colAttention).toContain('data-row="lane:L-20261125-01"');
		expect(colAttention).toContain("머지 대기");
		expect(colAttention).toContain("https://github.com/gimso2x/kencrew/pull/42");
		expect(colWorking).toContain('data-row="lane:뚱기:L-20261128-09"');
		expect(colWorking).toContain("PR 열림");

		const lanesHtml = renderDashboardMain(snap, undefined, NOW, { view: "lanes" });
		expect(lanesHtml).toContain("kencrew");
		expect(lanesHtml).toContain("머지 대기");
		expect(lanesHtml).toContain("뚱기");

		const peerDetail = renderItemDetail(snap, "lanes", "뚱기:L-20261128-09");
		expect(peerDetail).toContain("PR 열기");
		expect(peerDetail).not.toContain("lanes watch");
	});

	test("integrates peer headless TASKs and flow chains without ID collision, orphan false alarm, or form", async () => {
		const ownRow = registerTask(ownHome, "본체 작업", CH_ROOT, `${CH_ROOT}:200000000000000001`, "/srv/jabbu-pocket");
		const peerRow = registerTask(peerHome, "뚱기 작업", CH_TTUNGI, `${CH_TTUNGI}:200000000000000002`, "/srv/kencrew");
		withDb(peerHome, (db) => {
			addInbound(
				db,
				peerHome,
				"tw1",
				taskOriginKey(peerRow.agent),
				"워커 스레드",
				"dispatched",
				NOW - MIN,
				`${CH_TTUNGI}:2099`,
			);
			addInbound(
				db,
				peerHome,
				"tw0",
				`discord/ch/${CH_TTUNGI}/t/200000000000000002`,
				"요청 원문",
				"answered",
				NOW - 5 * MIN,
				`${CH_TTUNGI}:200000000000000002`,
			);
		});

		const snap = await buildSnapshot(makeDeps());
		expect(snap.tasks.ok).toBe(true);
		const peerTask = snap.tasks.ok ? snap.tasks.items.find((t) => t.taskId === `뚱기:${peerRow.taskId}`) : undefined;
		expect(peerTask?.install).toBe("뚱기");
		expect(peerTask?.rawTaskId).toBe(ownRow.taskId);

		const filtered = withoutTaskThreads({
			ok: true,
			items: [],
			threads: [
				{
					originKey: `뚱기:${taskOriginKey(peerRow.agent)}`,
					threadRef: null,
					kind: "message",
					title: "w",
					column: "working",
					latest: {
						inboundId: 1,
						state: "dispatched",
						createdAt: "",
						preview: null,
						ageMs: 0,
						silentMs: 0,
						stalled: false,
						waitReason: null,
					},
					turnCount: 1,
					openCount: 1,
					runCount: 1,
					pendingCount: 0,
					stalledCount: 0,
					updatedAt: "",
					recent: [],
				},
			],
		});
		expect(filtered.ok && filtered.threads.length).toBe(0);

		const liveBoard: BoardView = {
			ok: true,
			generatedAt: NOW,
			machines: [{ id: "local", name: "oci", connected: true }],
			cards: [],
		};
		const peerEntry = inboxEntries(snap, liveBoard).find((e) => e.taskId === `뚱기:${peerRow.taskId}`);
		expect(peerEntry?.orphan).toBeUndefined();

		expect(peerTask).toBeDefined();
		const workHtml = peerTask ? renderTaskWork(peerTask) : "";
		expect(workHtml).toContain(encodeURIComponent(`뚱기:${taskOriginKey(peerRow.agent)}`));
		expect(workHtml).not.toContain("data-task-work-form");

		expect(snap.flows?.ok).toBe(true);
		const peerChain = snap.flows?.ok ? snap.flows.items.find((c) => c.here === `뚱기:${peerRow.taskId}`) : undefined;
		expect(peerChain?.tasks[0]?.taskId).toBe(`뚱기:${peerRow.taskId}`);

		const flowDetail = renderItemDetail(snap, "flow", `뚱기:${peerRow.taskId}`);
		expect(flowDetail).not.toContain("lanes watch");
	});

	test("keeps SSR and shipped client SCRIPT identical across views and ui.bot filter", async () => {
		registerTask(ownHome, "본체 작업", CH_ROOT, `${CH_ROOT}:300000000000000001`, "/srv/jabbu-pocket", false);
		const pt = registerTask(peerHome, "뚱기 작업", CH_TTUNGI, `${CH_TTUNGI}:300000000000000002`, "/srv/kencrew");
		withDb(peerHome, (db) => {
			addLane(
				db,
				peerHome,
				"L-20261128-11",
				"뚱기 작업 레인",
				"working",
				"/home/ubuntu/work/wt/ttungi-work",
				NOW - MIN,
			);
			addInbound(
				db,
				peerHome,
				"p1",
				`discord/ch/${CH_TTUNGI}`,
				"뚱기 채널 최신",
				"answered",
				NOW - 2 * MIN,
				`${CH_TTUNGI}:1005`,
			);
		});

		const snap: DashboardSnapshot = await buildSnapshot(makeDeps());
		const client = new Function(
			"document",
			"setInterval",
			`${SCRIPT}\nreturn { renderDashboardMain, renderItemDetail, renderTaskDetail };`,
		)({ getElementById: () => ({}) }, () => 0) as {
			renderDashboardMain: typeof renderDashboardMain;
			renderItemDetail: typeof renderItemDetail;
			renderTaskDetail: typeof renderTaskDetail;
		};

		for (const ui of [
			{ view: "inbox" },
			{ view: "turns" },
			{ view: "turns", layout: "list" },
			{ view: "turns", bot: "뚱기" },
			{ view: "lanes" },
			{ view: "flow" },
		]) {
			expect(client.renderDashboardMain(snap, undefined, NOW, ui)).toBe(renderDashboardMain(snap, undefined, NOW, ui));
		}
		expect(renderDashboardMain(snap, undefined, NOW, { view: "turns", bot: "뚱기" })).toContain(
			'data-turn-bot="뚱기" aria-pressed="true"',
		);
		expect(client.renderItemDetail(snap, "lanes", "뚱기:L-20261128-11")).toBe(
			renderItemDetail(snap, "lanes", "뚱기:L-20261128-11"),
		);
		const peerTask = snap.tasks.ok ? snap.tasks.items.find((t) => t.install === "뚱기") : undefined;
		expect(client.renderTaskDetail(`뚱기:${pt.taskId}`, peerTask)).toBe(
			renderTaskDetail(`뚱기:${pt.taskId}`, peerTask),
		);
	});
});
