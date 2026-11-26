import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_CSS } from "../src/dashboard/assets";
import type { BoardView } from "../src/dashboard/board";
import { updateCostLedger } from "../src/dashboard/cost-ledger";
import { renderDetailHead, renderDiffDetail, renderItemDetail } from "../src/dashboard/detail";
import { SCRIPT } from "../src/dashboard/html";
import { costCardBody } from "../src/dashboard/load-view";
import { renderDashboardMain } from "../src/dashboard/main-view";
import type { DashboardSnapshot, FlowChainInfo } from "../src/dashboard/snapshot";
import { readTranscript } from "../src/dashboard/trace-transcript";
import { renderTrace, type TraceViewState } from "../src/dashboard/trace-view";

const NOW = Date.parse("2026-11-26T12:00:00+09:00");
const DAY = 86_400_000;
const off = { ok: false as const, error: "off" };

const baseSnap = (extra: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
	generatedAt: "2026-11-26T12:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [],
		hostSessions: { count: 1, ceiling: 4 },
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: { ok: true, items: [{ name: "daemon", state: "closed", detail: "ok" }] },
	backup: { ok: true, local: { at: "2026-11-26T11:30:00+09:00", ageMs: 1_800_000 }, offsite: null },
	jobs: off,
	...extra,
});

const boardOf = (cards: BoardView["cards"] = []): BoardView => ({
	ok: true,
	generatedAt: NOW,
	machines: [{ id: "local", name: "oci", connected: true }],
	cards,
});

const flowChain = (ref: string, here: string | null, taskId: string): FlowChainInfo => ({
	threadRef: ref,
	originKey: `discord/ch/1/t/${ref}`,
	place: "Discord",
	title: `흐름 ${ref}`,
	requestedAt: "2026-11-26T10:00:00+09:00",
	updatedAt: "2026-11-26T11:00:00+09:00",
	done: here === null ? 1 : 0,
	total: 1,
	here,
	now: here === null ? "끝" : "진행 중",
	discordHref: "",
	tasks: [
		{
			taskId,
			title: `작업 ${taskId}`,
			status: here === null ? "done" : "working",
			risk: "L1",
			host: "local",
			branch: `task/${taskId}`,
			createdAt: "2026-11-26T10:01:00+09:00",
			...(here === null ? { closedAt: "2026-11-26T10:30:00+09:00" } : {}),
			acTotal: 2,
			stage: here === null ? { label: "끝남", msg: "", tone: "done" } : { label: "구현", msg: "", tone: "run" },
		},
	],
});

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jabbu-ux-bench-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

describe("P0 & P1 dashboard UX improvements", () => {
	test("P0: topbar uses status-pop, mobile nav uses .nav-sheet, and single-item next-line is hidden", () => {
		const snap = baseSnap({
			tasks: {
				ok: true,
				items: [
					{
						taskId: "T-1",
						title: "단일 확인",
						risk: "L1",
						status: "review",
						host: "local",
						agent: "a1",
						runtime: "herdr",
						branch: "task/T-1",
						open: true,
						updatedAt: "2026-11-26T11:50:00+09:00",
						acTotal: 1,
					},
				],
			},
		});
		const html = renderDashboardMain(snap, boardOf(), NOW, { view: "inbox" });
		expect(html).toContain('<details class="status-pop"><summary class="status-summary">');
		expect(html).toContain("data-nav-more");
		expect(html).not.toContain('class="nav-count is-warn">!<');
		expect(html).toContain('<div class="nav-sheet">');
		expect(html).toContain('<span class="view-tools">');
		expect(html).toContain('<div class="next-line is-single">');
		expect(PAGE_CSS).toContain("@media (max-width:1023px){.hint-bar{display:none}");
	});

	test("P1 flow: removes 2-line legend, folds closed chains into 1-line details, auto-opens selected closed task", () => {
		const chains = [
			flowChain("open-1", "T-OPEN", "T-OPEN"),
			flowChain("closed-1", null, "T-C1"),
			flowChain("closed-2", null, "T-C2"),
		];
		const snap = baseSnap({ flows: { ok: true, items: chains } });
		const html = renderDashboardMain(snap, undefined, NOW, { view: "flow" });
		expect(html).not.toContain("flow-lead");
		expect(html).toContain('class="flow-bar"');
		expect(html).toContain("진행 중 <b>1</b> · 끝남 <b>2</b>");
		expect(html).toContain("data-flow-closed-toggle");
		expect(html).toContain('<details class="flow-fold" id="flow-closed-1">');
		expect(html).toContain('<details class="flow-fold" id="flow-closed-2">');
		const withSel = renderDashboardMain(snap, undefined, NOW, { view: "flow", selected: "T-C2" });
		expect(withSel).toContain('<details class="flow-fold" id="flow-closed-2" open>');
		expect(withSel).toContain('<details class="flow-fold" id="flow-closed-1">');
	});

	test("P1 approvals & questions: 4-quadrant appr-grid and clickable question chips", () => {
		const snap = baseSnap({
			approvals: {
				ok: true,
				stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
				recent: [],
				items: [
					{
						approvalId: "A-1",
						title: "배포 승인",
						summary: "배포 승인",
						createdAt: "2026-11-26T11:50:00+09:00",
						expiresAt: "2026-11-26T12:20:00+09:00",
						remainingMs: 1_200_000,
						originKey: "discord/dm/1",
						originThreadRef: null,
						originLabel: "DM",
						originUrl: null,
						cardUrl: null,
						detail: { action: "git push", why: "릴리스", impact: "main 변경", rollback: "원격 반영" },
					},
				],
			},
		});
		const appr = renderItemDetail(snap, "approvals", "A-1");
		expect(appr).toContain('<dl class="appr-grid">');
		for (const cls of ["is-action", "is-why", "is-impact", "is-rollback"]) {
			expect(appr).toContain(`class="appr-cell ${cls}"`);
		}
		const nullAppr = renderItemDetail(
			baseSnap({
				approvals: {
					ok: true,
					stats: { days: 7, approved: 0, denied: 0, expired: 0, replied: 0, medianAnswerMs: null },
					recent: [],
					items: [
						{
							approvalId: "A-NULL",
							title: "요약만",
							summary: "요약만",
							createdAt: "2026-11-26T11:50:00+09:00",
							expiresAt: "2026-11-26T12:20:00+09:00",
							remainingMs: 1_200_000,
							originKey: "discord/dm/1",
							originThreadRef: null,
							originLabel: "DM",
							originUrl: null,
							cardUrl: null,
							detail: null,
						},
					],
				},
			}),
			"approvals",
			"A-NULL",
		);
		expect(nullAppr.split("세부 내용 없음(요약만 받은 요청)").length - 1).toBe(1);
		const head = renderDetailHead(
			"p1",
			{
				key: "p1",
				local: true,
				machineId: "local",
				machineName: "oci",
				paneId: "p1",
				workspaceId: "w",
				workspaceLabel: "main",
				tabLabel: "tab",
				paneLabel: "pane",
				name: "agent",
				agent: "omp",
				status: "blocked",
				column: "attention",
				unknown: false,
				since: NOW,
				cwd: "/w",
				asks: [{ question: "어떤 안?", options: ["1안", "2안"] }],
				replyUrl: "https://herdr.test/r/1",
			},
			undefined,
			NOW,
		);
		expect(head).toContain('data-reply-url="https://herdr.test/r/1"');
		expect(head).toContain("<li>1안</li><li>2안</li>");
		expect(head).toContain("say-hint");
	});

	test("P1 client helpers: unmarkSeen/restoreMarkSeen, triageRow e/u + undo, and uxPeekLink", () => {
		const env = new Function(
			"document",
			"setInterval",
			`${SCRIPT}\nreturn { unmarkSeen, restoreMarkSeen, triageRow, uxPeekLink, uxShowToast, restoreUxOpenState, readUnread, seedStore, unreadIds, inboxEntries };`,
		)({ getElementById: () => ({}) }, () => 0) as {
			unmarkSeen: (store: { get: () => string | null; set: (v: string) => void }, id: string) => unknown;
			restoreMarkSeen: (store: { get: () => string | null; set: (v: string) => void }, id: string, m: unknown) => void;
			triageRow: (doc: unknown, mode: "read" | "unread", ctx: Record<string, unknown>) => boolean;
			uxPeekLink: (link: { getAttribute: (n: string) => string | null }, show: (t: unknown, h: string) => void) => void;
			restoreUxOpenState: (doc: unknown, saved: unknown) => void;
			readUnread: (store: { get: () => string | null; set: (v: string) => void }) => {
				seeded: boolean;
				seen: Record<string, unknown>;
			};
			seedStore: (s: unknown, snap: DashboardSnapshot, board: BoardView, now: number) => boolean;
			unreadIds: (entries: unknown[], s: unknown) => string[];
			inboxEntries: (snap: DashboardSnapshot, board: BoardView) => unknown[];
		};
		let raw: string | null = null;
		const store = {
			get: () => raw,
			set: (v: string) => {
				raw = v;
			},
		};
		const snap = baseSnap({
			tasks: {
				ok: true,
				items: [
					{
						taskId: "T-9",
						title: "트리아지 테스트",
						risk: "L1",
						status: "review",
						host: "local",
						agent: "a9",
						runtime: "herdr",
						branch: "task/T-9",
						open: true,
						updatedAt: "2026-11-26T11:00:00+09:00",
						acTotal: 1,
					},
				],
			},
		});
		const brd = boardOf();
		expect(env.seedStore(store, snap, brd, NOW)).toBe(true);
		const entries = env.inboxEntries(snap, brd);
		expect(env.unreadIds(entries, store)).toEqual([]);

		let keep = "";
		let redraws = 0;
		const toasts: Array<{ text: string; action?: { label?: string; run?: () => void } }> = [];
		const ctx = {
			view: "inbox",
			store,
			snapshot: snap,
			board: brd,
			open: { kind: "task", id: "T-9" },
			getKeep: () => keep,
			setKeep: (v: string) => {
				keep = v;
			},
			redraw: () => {
				redraws += 1;
			},
			toast: (text: string, action?: { label?: string; run?: () => void }) => {
				toasts.push({ text, action });
			},
		};
		const doc = { activeElement: null, getElementById: () => null };
		expect(env.triageRow(doc, "unread", ctx)).toBe(true);
		expect(env.unreadIds(entries, store)).toEqual(["T-9"]);
		expect(keep).toBe("task:T-9");
		expect(toasts.at(-1)?.text).toBe("안 읽음으로 표시했어요");

		expect(env.triageRow(doc, "read", ctx)).toBe(true);
		expect(env.unreadIds(entries, store)).toEqual([]);
		expect(keep).toBe("");
		expect(toasts.at(-1)?.text).toBe("확인함으로 표시했어요");
		toasts.at(-1)?.action?.run?.();
		expect(env.unreadIds(entries, store)).toEqual(["T-9"]);
		expect(redraws).toBe(3);

		const peeks: Array<[unknown, string]> = [];
		const g = globalThis as Record<string, unknown>;
		const prevWin = g.window;
		const hadWin = Object.hasOwn(g, "window");
		g.window = { matchMedia: () => ({ matches: true }) };
		try {
			env.uxPeekLink({ getAttribute: (n) => (n === "data-task" ? "T-9" : null) }, (target, how) =>
				peeks.push([target, how]),
			);
		} finally {
			if (hadWin) g.window = prevWin;
			else delete g.window;
		}
		expect(peeks).toEqual([[{ kind: "task", id: "T-9" }, "peek"]]);

		const attrs: Record<string, string> = {};
		const gridAttrs: Record<string, string> = {};
		const classes = new Set<string>();
		const fakeBtn = {
			textContent: "정상 카드 접기",
			setAttribute: (k: string, v: string) => {
				attrs[k] = v;
			},
		};
		const fakeGrid = {
			classList: {
				toggle: (c: string, on: boolean) => {
					if (on) classes.add(c);
					else classes.delete(c);
					return on;
				},
			},
			setAttribute: (k: string, v: string) => {
				gridAttrs[k] = v;
			},
			querySelectorAll: (sel: string) => (sel === ".sys-card.is-ok" ? [{}, {}, {}] : []),
		};
		const uxDoc = {
			querySelectorAll: () => [],
			querySelector: (sel: string) =>
				sel === ".sys-grid" ? fakeGrid : sel === "[data-sys-ok-toggle]" ? fakeBtn : null,
		};
		env.restoreUxOpenState(uxDoc, { statusOpen: false, moreOpen: false, sysCompact: true, costDay: null });
		expect(classes.has("is-compact-ok")).toBe(true);
		expect(gridAttrs["data-ux-toggled"]).toBe("1");
		expect(attrs["aria-pressed"]).toBe("true");
		expect(fakeBtn.textContent).toBe("정상 카드 펼치기 (3)");
		env.restoreUxOpenState(uxDoc, { statusOpen: false, moreOpen: false, sysCompact: false, costDay: null });
		expect(classes.has("is-compact-ok")).toBe(false);
		expect(attrs["aria-pressed"]).toBe("false");
		expect(fakeBtn.textContent).toBe("정상 카드 접기");
	});
});

describe("P2 dashboard trace, diff, system & cost improvements", () => {
	test("P2 trace-transcript: records cache tokens and masks argsPreview/resultPreview", () => {
		const file = join(tempDir, "s.jsonl");
		const lines = [
			{ type: "session", timestamp: "2026-11-26T02:00:00Z" },
			{
				type: "message",
				id: "u1",
				timestamp: "2026-11-26T02:00:01Z",
				message: { role: "user", content: [{ type: "text", text: "점검" }] },
			},
			{
				type: "message",
				id: "m1",
				timestamp: "2026-11-26T02:00:03Z",
				message: {
					role: "assistant",
					model: "opus",
					timestamp: Date.parse("2026-11-26T02:00:01Z"),
					completedAt: Date.parse("2026-11-26T02:00:03Z"),
					stopReason: "toolUse",
					usage: { input: 100, cacheRead: 800, cacheWrite: 100, output: 50, cost: { total: 0.4 } },
					content: [
						{ type: "toolCall", id: "c1", name: "bash", arguments: { i: "run probe", cmd: "echo sk-TESTKEY123" } },
					],
				},
			},
			{
				type: "message",
				id: "r1",
				timestamp: "2026-11-26T02:00:05Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					isError: false,
					content: [{ type: "text", text: "ok xoxb-TEST-0 done" }],
				},
			},
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		const tr = readTranscript(file, {
			from: Date.parse("2026-11-26T02:00:00Z"),
			to: Number.POSITIVE_INFINITY,
			live: false,
			origin: Date.parse("2026-11-26T02:00:00Z"),
		});
		const llm = tr.spans[0];
		const tool = tr.spans[1];
		expect(llm).toMatchObject({ tokensIn: 1000, tokensInput: 100, cacheRead: 800, cacheWrite: 100, tokensOut: 50 });
		expect(tool?.argsPreview).toBe("cmd: echo [REDACTED]");
		expect(tool?.resultPreview).toBe("ok [REDACTED] done");
		expect(`${tool?.argsPreview} ${tool?.resultPreview}`).not.toContain("sk-TESTKEY123");
		expect(`${tool?.argsPreview} ${tool?.resultPreview}`).not.toContain("xoxb-TEST-0");
	});

	test("P2 trace-view: filters (llm/tool/error/slow), cache bar, payload fold, and data-sig invariance", () => {
		const trace = {
			ok: true as const,
			inboundId: 1,
			startedAt: NOW - 10_000,
			now: NOW,
			live: false,
			truncated: false,
			root: {
				id: "turn",
				name: "턴",
				kind: "agent" as const,
				status: "done" as const,
				start: 0,
				end: 8000,
				children: [
					{
						id: "m1",
						name: "opus",
						kind: "llm" as const,
						status: "done" as const,
						start: 0,
						end: 1500,
						tokensIn: 1000,
						tokensInput: 100,
						cacheRead: 800,
						cacheWrite: 100,
						tokensOut: 50,
						cost: 0.4,
					},
					{
						id: "t1",
						name: "bash",
						kind: "tool" as const,
						status: "failed" as const,
						start: 1500,
						end: 7500,
						argsPreview: "cmd: ls",
						resultPreview: "boom",
						error: "exit 1",
					},
				],
			},
		};
		const baseState: TraceViewState = { now: NOW, fold: {}, focus: null, open: null, title: "테스트" };
		const spanIds = (html: string) => [...html.matchAll(/data-span="([^"]+)"/g)].map((m) => m[1]);
		expect(spanIds(renderTrace(trace, { ...baseState, filter: "llm" }))).toEqual(["turn", "m1"]);
		expect(spanIds(renderTrace(trace, { ...baseState, filter: "tool" }))).toEqual(["turn", "t1"]);
		expect(spanIds(renderTrace(trace, { ...baseState, filter: "error" }))).toEqual(["turn", "t1"]);
		expect(spanIds(renderTrace(trace, { ...baseState, filter: "slow" }))).toEqual(["turn", "t1", "m1"]);

		const sig = (html: string) => /data-sig="([^"]+)"/.exec(html)?.[1];
		expect(sig(renderTrace(trace, baseState))).toBe(sig(renderTrace(trace, { ...baseState, now: NOW + 5000 })));
		expect(sig(renderTrace(trace, { ...baseState, filter: "llm" }))).not.toBe(sig(renderTrace(trace, baseState)));

		const llmOpen = renderTrace(trace, { ...baseState, open: "m1" });
		expect(llmOpen).toContain("tw-tok-bar");
		expect(llmOpen).toContain("입력 100 · 캐시 읽기 800 · 캐시 쓰기 100 · 출력 50 · 캐시 적중 80%");
		const toolOpen = renderTrace(trace, { ...baseState, open: "t1" });
		expect(toolOpen).toContain("tw-payload");
		expect(toolOpen).toContain('<pre class="tw-pre">cmd: ls</pre>');
	});

	test("P2 diff: renders file navigator jump links and toggle-all control", () => {
		const html = renderDiffDetail("task:T-1", {
			base: "aaaa",
			sha: "bbbb",
			truncated: false,
			files: [
				{ path: "src/a.ts", added: 3, deleted: 1, binary: false, hunks: "@@ -1 +1 @@\n-a\n+b" },
				{ path: "src/b.ts", added: 2, deleted: 0, binary: false, hunks: "@@ -1 +1 @@\n+c" },
			],
		});
		expect(html).toContain('class="diff-nav"');
		expect(html).toContain("파일 목록 (2)");
		expect(html).toContain("data-diff-toggle-all");
		expect(html).toContain('data-diff-jump="diff-f-0"');
		expect(html).toContain('<details class="diff-file" id="diff-f-1">');
	});

	test("P2 system & cost: summary strip, compact-ok on issue, per-day top drilldown & avg baseline", () => {
		const sDir = join(tempDir, "sessions", encodeURIComponent("discord/ch/1/t/2"), "e1");
		mkdirSync(sDir, { recursive: true });
		const msg = (at: number, total: number) =>
			`${JSON.stringify({
				type: "message",
				timestamp: new Date(at).toISOString(),
				message: { role: "assistant", usage: { input: 1, output: 1, cost: { total, cacheWrite: 0 } } },
			})}\n`;
		writeFileSync(
			join(sDir, "s.jsonl"),
			`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "비용 작업" }] } })}\n${msg(NOW - DAY, 4)}${msg(NOW, 3)}`,
		);
		const { info } = updateCostLedger(tempDir, NOW, "Asia/Seoul");
		expect(info.dayTop?.["11-25"]?.[0]).toMatchObject({ title: "비용 작업", kind: "대화", cost: 4 });
		expect(info.dayTop?.["11-26"]?.[0]).toMatchObject({ title: "비용 작업", kind: "대화", cost: 3 });

		const body = costCardBody({ ok: true, ...info });
		expect(body).toContain('class="cost-avg"');
		expect(body).toContain("일평균 $1.00 · 날짜 클릭 시 상세");
		expect(body).toContain('data-cost-day="11-25"');
		expect(body).toContain("data-cost-day-reset");

		const baseDaemon = baseSnap().daemon;
		if (!baseDaemon.ok) throw new Error("expected ok daemon");
		const okDaemon = {
			...baseDaemon,
			heartbeat: { at: "2026-11-26T11:59:30+09:00", ageMs: 30_000, draining: false },
		};
		const calm = renderDashboardMain(
			baseSnap({ daemon: okDaemon, monitors: { ok: true, items: [] }, costLedger: { ok: true, ...info } }),
			undefined,
			NOW,
			{ view: "system" },
		);
		expect(calm).toContain("모두 정상 (7/7)");
		expect(calm).not.toContain("is-compact-ok");

		const warnSnap = baseSnap({
			daemon: { ...okDaemon, openGates: [{ name: "backup_age", detail: "old" }] },
			gates: { ok: true, items: [{ name: "backup_age", state: "open", detail: "old" }] },
			monitors: { ok: true, items: [] },
			costLedger: { ok: true, ...info },
		});
		const warn = renderDashboardMain(warnSnap, undefined, NOW, { view: "system" });
		expect(warn).toContain("확인 필요 1건 · 정상 6/7");
		expect(warn).toContain("has-issue is-compact-ok");
		expect(warn).toContain('class="sys-card is-wide is-warn" data-card="gates"');

		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(client(warnSnap, undefined, NOW, { view: "system" })).toBe(warn);
	});
});
