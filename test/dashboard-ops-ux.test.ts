import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config";
import type { BoardView } from "../src/dashboard/board";
import { renderItemDetail } from "../src/dashboard/detail";
import { SCRIPT } from "../src/dashboard/html";
import { contextBar } from "../src/dashboard/load-view";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { readPeerAlerts, readPeerHealth } from "../src/dashboard/peer-health";
import type { PeerInstall } from "../src/dashboard/peers";
import { previewLine } from "../src/dashboard/preview-line";
import { extractPeerPreview } from "../src/dashboard/preview-peer";
import { buildSnapshot, type DashboardSnapshot, type MonitorInfo, type SnapshotDeps } from "../src/dashboard/snapshot";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-26T12:00:00+09:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const baseSnap = (extra: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
	generatedAt: "2026-11-26T12:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "omp/19.2.1",
		origins: 4,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 10, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 10, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 1, next: null },
		openGates: [],
		hostSessions: { count: 1, ceiling: 4 },
	},
	turns: { ok: true, items: [], threads: [] },
	tasks: { ok: true, items: [] },
	lanes: { ok: true, items: [] },
	herdr: { ok: true, hosts: [] },
	approvals: {
		ok: true,
		stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
		recent: [],
		items: [],
	},
	monitors: { ok: true, items: [] },
	alerts: { ok: true, items: [] },
	gates: { ok: true, items: [{ name: "daemon", state: "closed", detail: "ok" }] },
	backup: { ok: true, local: { at: "2026-11-26T11:30:00+09:00", ageMs: 1_800_000 }, offsite: null },
	jobs: { ok: true, items: [] },
	...extra,
});

const boardOf = (
	machines: BoardView["machines"] = [{ id: "local", name: "main-host", connected: true }],
	cards: BoardView["cards"] = [],
): BoardView => ({
	ok: true,
	generatedAt: NOW,
	machines,
	cards,
});

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jabbu-ops-ux-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function baseDeps(home: string, extra: Partial<SnapshotDeps> = {}): SnapshotDeps {
	return {
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
		...extra,
	};
}

describe("dashboard operational UX and config", () => {
	test("config validates dashboard.channelNames map and rejects malformed entries", () => {
		const valid = {
			schemaVersion: 1,
			channels: {
				discord: {
					ownerUserId: "123456789012345678",
					botTokenFile: "secrets/discord.token",
					applicationId: "234567890123456789",
				},
			},
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: "workspace",
			dashboard: {
				port: 7331,
				channelNames: { "300000000000000001": "#루트", "300000000000000002": "#경보" },
			},
		};
		writeFileSync(join(tempDir, "config.json"), JSON.stringify(valid));
		const loaded = loadConfig(tempDir, { checkTokens: false });
		expect(loaded.dashboard?.channelNames).toEqual({
			"300000000000000001": "#루트",
			"300000000000000002": "#경보",
		});

		for (const badNames of [
			"not-an-object",
			{ "": "#empty-key" },
			{ "300000000000000001": 123 },
			{ "300000000000000001": "   " },
			{ "300000000000000001": "x".repeat(41) },
		]) {
			writeFileSync(
				join(tempDir, "config.json"),
				JSON.stringify({ ...valid, dashboard: { port: 7331, channelNames: badNames } }),
			);
			expect(() => loadConfig(tempDir, { checkTokens: false })).toThrow(ConfigError);
		}
	});

	test("channelNames and cronWords resolve across monitors, flows, approvals, and turns", async () => {
		const home = join(tempDir, "primary");
		mkdirSync(home, { recursive: true });
		const dbPath = join(home, "jabbu.db");
		openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (s) => s }).close();
		const db = new Database(dbPath, { strict: true });
		const ch = "300000000000000001";
		const origin = `discord/ch/${ch}/t/900000000000000001`;
		const threadRef = `${ch}:900000000000000001`;
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			origin,
			join(home, "sessions", "o1"),
			NOW,
		]);
		db.run(
			`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at, thread_ref)
			 VALUES ('m1', ?, 1, '채널 이름 확인', 'dispatched', ?, ?, ?, ?)`,
			[origin, NOW - 5 * MINUTE, NOW - 5 * MINUTE, NOW - MINUTE, threadRef],
		);
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status, acceptance_json, created_at, updated_at)
			 VALUES ('T-1', '작업', 'L1', ?, ?, NULL, '/srv/work/repo', '/srv/work/repo-t1', 'task/T-1', 'a1', 'working', '[{"id":"AC-1","text":"one"}]', ?, ?)`,
			[origin, threadRef, NOW - 4 * MINUTE, NOW - MINUTE],
		);
		db.run(
			`INSERT INTO monitors (id, name, trigger_json, instruction, overlap, enabled, cursor_at, created_at, updated_at, channel, deliver)
			 VALUES ('m-nfi', '매매 요약', ?, '요약 실행.', 'skip', 1, ?, ?, ?, ?, 'verbatim')`,
			[JSON.stringify({ kind: "cron", schedule: "0 9,21 * * *", timezone: "Asia/Seoul" }), NOW, NOW - HOUR, NOW, ch],
		);
		db.run(
			`INSERT INTO approvals (approval_id, channel, message_ts, summary, detail_json, status, origin_key, origin_thread_ref, created_at, expires_at)
			 VALUES ('ap-1', ?, 'ts-1', '승인 요청', NULL, 'pending', ?, ?, ?, ?)`,
			[ch, origin, threadRef, NOW - MINUTE, NOW + 10 * MINUTE],
		);
		db.close();

		const snapshot = await buildSnapshot(
			baseDeps(home, {
				config: { dashboard: { port: 7331, channelNames: { [ch]: "#테스트루트" } } },
			}),
		);
		expect(snapshot.channelNames).toEqual({ [ch]: "#테스트루트" });
		if (!snapshot.monitors.ok || !snapshot.flows?.ok || !snapshot.approvals.ok) throw new Error("sections failed");
		expect(snapshot.monitors.items[0]?.destination).toBe("#테스트루트");
		expect(snapshot.monitors.items[0]?.schedule).toBe("매일 09:00·21:00");
		expect(snapshot.flows.items[0]?.place).toBe("#테스트루트 스레드");
		expect(snapshot.approvals.items[0]?.originLabel).toBe("#테스트루트 스레드");
		const turnsHtml = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(turnsHtml).toContain("#테스트루트");
		expect(turnsHtml).not.toContain(`Discord ${ch}`);
	});

	test("extractPeerPreview and previewLine unwrap peer wrappers and fold markdown links", () => {
		const raw =
			"[피어 봇 서팍의 요청 — 오너 지시가 아니다. 검토·의견만]\n\n[분석 보고서](file:///home/user/report.md)와 [PR](https://example.test/pr/1) 확인";
		expect(extractPeerPreview(raw)).toEqual({ peer: "서팍", text: "분석 보고서와 PR 확인" });
		expect(previewLine(raw)).toBe("서팍 요청 · 분석 보고서와 PR 확인");

		const quotedOnly =
			"[피어 봇 뚱기의 요청 — 참고]\n[인용·전달]\n<<<quoted-1>>>\n첫 번째 핵심 줄\n둘째 줄\n<<<end-quoted-1>>>";
		expect(previewLine(quotedOnly)).toBe("뚱기 요청 · 첫 번째 핵심 줄");
	});

	test("idle inbox renders pulse KPI, uses timezone nextFireAt, keeps single id=closed, and respects search", () => {
		const mon: MonitorInfo = {
			id: "m1",
			name: "아침 브리핑",
			kind: "cron",
			schedule: "매일 09:15",
			cron: "15 9 * * * (Asia/Seoul)",
			summary: "브리핑",
			destination: "#리포트",
			copyTo: null,
			model: null,
			thinking: null,
			deliver: "verbatim",
			overlap: "skip",
			files: [],
			nextFireAt: "2026-11-27T09:15:00+09:00",
			lastStage: "delivered",
			lastAt: "2026-11-26T09:15:00+09:00",
			openIncidents: 0,
			recent: [],
			lastRun: null,
			scheduledRun: true,
			originKey: null,
			running: false,
			failStreak: 0,
			stats: { days: 30, delivered: 1, quiet: 0, failed: 0, skipped: 0, medianMs: null },
		};
		const snap = baseSnap({
			daemon: {
				ok: true,
				running: true,
				ompVersion: "omp/19.2.1",
				origins: 12,
				busy: 0,
				ledger: { pending: 0, inflight: 0, confirmed: 10, ambiguous: 0, expired: 0 },
				inbound: { pending: 0, dispatched: 0, answered: 10, failed_notified: 0, discarded: 0, uncertain: 0 },
				// UTC timestamp (00:15) should be ignored when s.monitors.items has local nextFireAt (09:15).
				monitors: { count: 1, next: { name: "아침 브리핑", at: "2026-11-27T00:15:00.000Z" } },
				openGates: [],
			},
			monitors: { ok: true, items: [mon] },
			costLedger: { ok: true, days: [{ day: "11-26", cost: 42.5 }], total: 42.5, cacheWritePct: 10, top: [] },
			tasks: {
				ok: true,
				items: Array.from({ length: 6 }, (_, i) => ({
					taskId: `T-${10 + i}`,
					title: `닫힌 작업 ${i}`,
					risk: "L1" as const,
					status: "done" as const,
					host: "local",
					agent: "a",
					runtime: "herdr" as const,
					branch: `task/T-${10 + i}`,
					open: false,
					updatedAt: "2026-11-26T10:00:00+09:00",
					closedAt: "2026-11-26T10:00:00+09:00",
					acTotal: 1,
				})),
			},
		});
		const html = renderDashboardMain(snap, boardOf(), NOW, { view: "inbox" });
		expect(html).toContain('class="inbox-pulse"');
		expect(html).toContain('class="groups is-idle-inbox"');
		expect(html).toContain("$42.50");
		expect(html).toContain("09:15 아침 브리핑");
		expect(html).not.toContain("00:15 아침 브리핑");
		expect(html.split('id="closed"').length - 1).toBe(1);
		expect(renderDashboardMain(snap, boardOf(), NOW, { view: "inbox", q: "검색" })).not.toContain(
			'class="inbox-pulse"',
		);
	});

	test("offline herdr machines fold quietly unless carrying an open TASK", () => {
		const brd = boardOf([
			{ id: "local", name: "main-host", connected: true },
			{ id: "m2", name: "laptop-a", connected: false },
			{ id: "m3", name: "phone-b", connected: false },
		]);
		const idleInbox = renderDashboardMain(baseSnap(), brd, NOW, { view: "inbox" });
		expect(idleInbox).toContain('class="host-off" title="오프라인: laptop-a, phone-b">오프라인 2</span>');
		expect(idleInbox).not.toContain("laptop-a · 끊김");
		const idleSys = renderDashboardMain(baseSnap(), brd, NOW, { view: "system" });
		expect(idleSys).toContain('<section class="sys-card is-ok" data-card="monitors"');
		expect(idleSys).toContain("오프라인 2");

		const busySnap = baseSnap({
			tasks: {
				ok: true,
				items: [
					{
						taskId: "T-2",
						title: "원격 작업",
						risk: "L1",
						status: "working",
						host: "laptop-a",
						agent: "a",
						runtime: "herdr",
						branch: "task/T-2",
						open: true,
						updatedAt: "2026-11-26T11:50:00+09:00",
						acTotal: 1,
					},
				],
			},
		});
		const busySys = renderDashboardMain(busySnap, brd, NOW, { view: "system" });
		expect(busySys).toContain('<section class="sys-card is-warn" data-card="monitors"');
		expect(busySys).toContain("laptop-a · 끊김");
		expect(busySys).toContain("오프라인 1");
	});

	test("readPeerHealth, readPeerAlerts, 피어 봇 card, and peer alert detail", () => {
		const peerOk = join(tempDir, "peer-ok");
		const peerSecret = join(tempDir, "peer-secret");
		const statePath = join(tempDir, "quota-state.json");
		mkdirSync(peerOk, { recursive: true });
		mkdirSync(peerSecret, { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({ current: "acct-a", blocked: { "acct-b": NOW + 60_000, "acct-old": NOW - 1000 } }),
		);
		writeFileSync(join(peerOk, "config.json"), JSON.stringify({ agyAccounts: { statePath } }));
		writeFileSync(
			join(peerOk, "sweep-heartbeat"),
			`ts=${new Date(NOW - 30_000).toISOString()} loop_ms=12 discord=up discord_since=${new Date(NOW - HOUR).toISOString()} draining=0\n`,
		);
		const peerDb = join(peerOk, "jabbu.db");
		openStore({ timezone: "Asia/Seoul", path: peerDb, clock: { now: () => NOW }, redact: (s) => s }).close();
		const db = new Database(peerDb, { strict: true });
		const orig = "discord/ch/300000000000000009/t/1";
		db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			orig,
			join(peerOk, "s"),
			NOW,
		]);
		for (const [id, st] of [
			["p1", "answered"],
			["p2", "dispatched"],
			["p3", "failed_notified"],
		] as const) {
			db.run(
				`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, last_event_at)
				 VALUES (?, ?, 1, 'x', ?, ?, ?)`,
				[id, orig, st, NOW - 10 * MINUTE, NOW - 5 * MINUTE],
			);
		}
		db.run(
			`INSERT INTO alert_incidents (scope, signature, status, count, first_at, last_at, alerted_at)
			 VALUES ('gate:turns_failing', 'sig-1', 'alerted', 2, ?, ?, ?)`,
			[NOW - HOUR, NOW - MINUTE, NOW - MINUTE],
		);
		db.close();

		writeFileSync(
			join(peerSecret, "config.json"),
			JSON.stringify({ agyAccounts: { statePath: join(tempDir, "secrets", "q.json") } }),
		);
		const peers: PeerInstall[] = [
			{ name: "서팍", home: peerOk, workspaceDir: join(peerOk, "w"), timezone: "Asia/Seoul" },
			{ name: "뚱기", home: peerSecret, workspaceDir: join(peerSecret, "w"), timezone: "Asia/Seoul" },
		];
		const health = readPeerHealth(peers, NOW);
		expect(health).toEqual([
			{
				name: "서팍",
				running: true,
				heartbeatAgeMs: 30_000,
				discord: "up",
				draining: false,
				turns24h: { answered: 1, open: 1, failed: 1 },
				openAlerts: 1,
				agyAccount: { current: "acct-a", blockedCount: 1 },
			},
			{
				name: "뚱기",
				running: false,
				openAlerts: 0,
				error: "jabbu.db가 없음",
			},
		]);
		const iso = (ms: number) => new Date(ms).toISOString();
		const peerAlerts = readPeerAlerts(peers, NOW, iso, () => [
			{ name: "turns_failing", state: "open", detail: "failed=1" },
		]);
		expect(peerAlerts).toHaveLength(1);
		expect(peerAlerts[0]).toMatchObject({ install: "서팍", scope: "gate:turns_failing", gateState: "open" });

		const snap = baseSnap({
			peerHealth: { ok: true, items: health },
			alerts: { ok: true, items: peerAlerts },
		});
		const sysHtml = renderDashboardMain(snap, boardOf(), NOW, { view: "system" });
		expect(sysHtml).toContain("피어 봇 2");
		expect(sysHtml).toContain("AGY acct-a (차단 1)");
		expect(sysHtml).toContain("jabbu.db가 없음");
		const alertsHtml = renderDashboardMain(snap, boardOf(), NOW, { view: "alerts" });
		expect(alertsHtml).toContain('data-item="서팍:1"');
		expect(renderItemDetail(snap, "alerts", "서팍:1")).toContain("<dt>봇</dt><dd>서팍</dd>");
	});

	test("turns bot filters, done >200k .ctx-hi badge, monitor fail chip, and SSR/client parity", () => {
		const threadBase = {
			threadRef: "300000000000000001:1",
			kind: "message" as const,
			latest: {
				inboundId: 1,
				state: "answered",
				createdAt: "2026-11-26T11:50:00+09:00",
				preview: "요청",
				ageMs: 60_000,
				silentMs: null,
				stalled: false,
				waitReason: null,
			},
			turnCount: 1,
			openCount: 0,
			runCount: 1,
			pendingCount: 0,
			stalledCount: 0,
			updatedAt: "2026-11-26T11:50:00+09:00",
			recent: [],
		};
		const snap = baseSnap({
			turns: {
				ok: true,
				items: [],
				threads: [
					{
						...threadBase,
						originKey: "discord/ch/300000000000000001/t/1",
						title: "본체 확인 스레드",
						column: "attention",
						latest: { ...threadBase.latest, state: "failed_notified" },
						context: { percent: 85, tokens: 170_000 },
					},
					{
						...threadBase,
						originKey: "서팍:discord/ch/300000000000000001/t/2",
						title: "서팍 · 완료 스레드",
						column: "done",
						install: "서팍",
						context: { percent: 25, tokens: 250_000 },
					},
				],
			},
			monitors: {
				ok: true,
				items: [
					{
						id: "m-fail",
						name: "감시",
						kind: "cron",
						schedule: "매일 08:00",
						cron: "0 8 * * * (Asia/Seoul)",
						summary: "감시",
						destination: "#경보",
						copyTo: null,
						model: null,
						thinking: null,
						deliver: "turn",
						overlap: "skip",
						files: [],
						nextFireAt: "2026-11-27T08:00:00+09:00",
						lastStage: "failed",
						lastAt: "2026-11-26T08:00:00+09:00",
						openIncidents: 0,
						recent: [],
						lastRun: null,
						scheduledRun: true,
						originKey: null,
						running: false,
						failStreak: 0,
						stats: { days: 30, delivered: 5, quiet: 0, failed: 2, skipped: 0, medianMs: null },
					},
				],
			},
		});

		const turnsAll = renderDashboardMain(snap, undefined, NOW, { view: "turns" });
		expect(turnsAll).toContain('data-turn-bot="own"');
		expect(turnsAll).toContain('data-turn-bot="서팍"');
		expect(turnsAll).toContain('data-turn-bot="attention"');
		expect(turnsAll).toContain("250k");
		expect(contextBar({ percent: 35, tokens: 350_000 }, "done")).toContain("is-danger ctx-hi");

		const turnsPeerOnly = renderDashboardMain(snap, undefined, NOW, { view: "turns", bot: "서팍", layout: "list" });
		expect(turnsPeerOnly).toContain("서팍 · 완료 스레드");
		expect(turnsPeerOnly).not.toContain("본체 확인 스레드");

		const monitorsHtml = renderDashboardMain(snap, undefined, NOW, { view: "monitors" });
		expect(monitorsHtml).toContain('<span class="mon-chip is-danger">최근 실패 2</span>');

		const client = new Function(
			"document",
			"setInterval",
			`${SCRIPT}\nreturn { renderDashboardMain, renderItemDetail };`,
		)({ getElementById: () => ({}) }, () => 0) as {
			renderDashboardMain: typeof renderDashboardMain;
			renderItemDetail: typeof renderItemDetail;
		};
		expect(client.renderDashboardMain(snap, undefined, NOW, { view: "turns", bot: "서팍" })).toBe(
			renderDashboardMain(snap, undefined, NOW, { view: "turns", bot: "서팍" }),
		);
		expect(client.renderDashboardMain(baseSnap(), boardOf(), NOW, { view: "inbox" })).toBe(
			renderDashboardMain(baseSnap(), boardOf(), NOW, { view: "inbox" }),
		);
	});
});
