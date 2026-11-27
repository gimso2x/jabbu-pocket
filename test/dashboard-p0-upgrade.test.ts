import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearContextLoad, withContextLoad } from "../src/dashboard/context-load";
import {
	clearHostMetricsCache,
	HOST_METRICS_TTL_MS,
	type HostMetricsInfo,
	parseBrowserPs,
	parseMeminfo,
	parseMemoryPressure,
	readHostMetrics,
} from "../src/dashboard/host-metrics";
import { SCRIPT } from "../src/dashboard/html";
import { contextBar, renderLimitsPop } from "../src/dashboard/load-view";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { fmtContextRatio, renderQuotaGrid } from "../src/dashboard/p0-renderers";
import type { DashboardSnapshot, Section } from "../src/dashboard/snapshot";
import type { ThreadInfo } from "../src/dashboard/turn-board";
import type { UsageLimitsInfo } from "../src/dashboard/usage-limits";
import { applyAgyBlockedOverlay, readAgyBlockedOverlay } from "../src/dashboard/usage-limits-agy";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-27T14:00:00+09:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jabbu-p0-"));
	clearHostMetricsCache();
	clearContextLoad();
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

const baseSnap = (extra: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
	generatedAt: "2026-11-27T14:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "omp/19.2.1",
		origins: 4,
		busy: 1,
		ledger: { pending: 0, inflight: 0, confirmed: 10, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 1, answered: 10, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 1, next: null },
		openGates: [],
		hostSessions: { count: 7, ceiling: 8 },
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
	backup: { ok: true, local: { at: "2026-11-27T13:30:00+09:00", ageMs: 1_800_000 }, offsite: null },
	jobs: { ok: true, items: [] },
	...extra,
});

const mkThread = (over: Partial<ThreadInfo> = {}): ThreadInfo => ({
	originKey: "discord/ch/300000000000000001/t/1",
	threadRef: "300000000000000001:1",
	kind: "message",
	title: "활성 작업 스레드",
	column: "working",
	latest: {
		inboundId: 1,
		state: "dispatched",
		createdAt: "2026-11-27T13:50:00+09:00",
		preview: "진행 중",
		ageMs: 600_000,
		silentMs: 10_000,
		stalled: false,
		waitReason: null,
	},
	turnCount: 2,
	openCount: 1,
	runCount: 1,
	pendingCount: 0,
	stalledCount: 0,
	updatedAt: "2026-11-27T13:59:00+09:00",
	recent: [],
	...over,
});

describe("host metrics collection and parsers", () => {
	test("parseMeminfo parses MemAvailable, falls back to MemFree+Buffers+Cached, and clamps", () => {
		const procText = [
			"MemTotal:       24548116 kB",
			"MemFree:         3155892 kB",
			"MemAvailable:   14448720 kB",
			"Buffers:          681748 kB",
			"Cached:          8409212 kB",
			"SwapTotal:       8388604 kB",
			"SwapFree:        5903428 kB",
		].join("\n");
		const parsed = parseMeminfo(procText);
		expect(parsed).toEqual({
			memTotalMb: 23973,
			memAvailMb: 14110,
			memUsedPct: 41,
			memAvailPct: 59,
			swapTotalMb: 8192,
			swapUsedMb: 2427,
		});

		const noAvail = parseMeminfo(
			["MemTotal: 1024000 kB", "MemFree: 204800 kB", "Buffers: 102400 kB", "Cached: 204800 kB"].join("\n"),
		);
		expect(noAvail).toMatchObject({ memTotalMb: 1000, memAvailMb: 500, memAvailPct: 50, memUsedPct: 50 });
		expect(parseMeminfo("MemTotal: 0 kB\n")).toBeUndefined();
		expect(parseMeminfo("unrelated")).toBeUndefined();
	});

	test("parseMemoryPressure classifies normal, some, full, and unknown", () => {
		expect(parseMemoryPressure("some avg10=0.00 avg60=0.01\nfull avg10=0.00 avg60=0.00\n")).toBe("normal");
		expect(parseMemoryPressure("some avg10=12.40 avg60=5.00\nfull avg10=0.50 avg60=0.00\n")).toBe("some");
		expect(parseMemoryPressure("some avg10=20.00 avg60=10.00\nfull avg10=5.10 avg60=2.00\n")).toBe("full");
		expect(parseMemoryPressure("empty")).toBeUndefined();
	});

	test("parseBrowserPs excludes crashpad and preserves exclusive bucket sum === total invariant", () => {
		const psOut = [
			"283192 chrome          /opt/chrome --user-data-dir=/home/u/.hub-browser/profile",
			"159168 chrome          /opt/chrome --type=renderer --headless",
			"102400 headless_shell  /opt/headless_shell --no-sandbox",
			"204800 chrome          /opt/chromium --playwright-browser-args",
			"102400 node            node agent-browser open https://example.test",
			" 20000 chrome_crashpad /opt/chrome_crashpad_handler --monitor-self",
			" 50000 bun             bun src/main.ts",
		].join("\n");
		const br = parseBrowserPs(psOut);
		expect(br.total).toBe(5);
		expect(br.chrome + br.headless + br.playwright + br.agentBrowser).toBe(br.total);
		expect(br).toEqual({
			total: 5,
			rssMb: 832,
			chrome: 1,
			headless: 2,
			playwright: 1,
			agentBrowser: 1,
		});
	});

	test("readHostMetrics caches for TTL, falls back on ps failure, and skips ps on win32", async () => {
		const memPath = join(tempDir, "meminfo");
		const presPath = join(tempDir, "pressure");
		writeFileSync(memPath, "MemTotal: 10485760 kB\nMemAvailable: 5242880 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
		writeFileSync(presPath, "some avg10=0.00\nfull avg10=0.00\n");
		let psCalls = 0;
		let t = NOW;
		const run = async () => {
			psCalls += 1;
			return { code: 0, stdout: "102400 chrome /opt/chrome --headless\n", timedOut: false };
		};
		const opts = {
			platform: "linux" as const,
			meminfoPath: memPath,
			pressurePath: presPath,
			cpus: () => 4,
			loadavg: (): [number, number, number] => [2, 1.5, 1],
			cacheKey: "t1",
		};
		const first = await readHostMetrics(run, () => t, opts);
		expect(first).toEqual({
			ok: true,
			cpuCores: 4,
			load1: 2,
			load5: 1.5,
			load15: 1,
			cpuPct: 50,
			memTotalMb: 10240,
			memAvailMb: 5120,
			memUsedPct: 50,
			memAvailPct: 50,
			swapTotalMb: 0,
			swapUsedMb: 0,
			pressure: "normal",
			browsers: { total: 1, rssMb: 100, chrome: 0, headless: 1, playwright: 0, agentBrowser: 0 },
		});
		t += HOST_METRICS_TTL_MS - 1;
		await readHostMetrics(run, () => t, opts);
		expect(psCalls).toBe(1);
		t += 1;
		await readHostMetrics(run, () => t, opts);
		expect(psCalls).toBe(2);

		const psFail = await readHostMetrics(
			async () => ({ code: 1, stdout: "", timedOut: true }),
			() => NOW,
			{ ...opts, cacheKey: "t2" },
		);
		expect(psFail.ok).toBe(true);
		if (psFail.ok) expect(psFail.browsers.total).toBe(0);

		let winCalls = 0;
		const win = await readHostMetrics(
			async () => {
				winCalls += 1;
				return { code: 0, stdout: "", timedOut: false };
			},
			() => NOW,
			{
				platform: "win32",
				cpus: () => 8,
				loadavg: (): [number, number, number] => [0, 0, 0],
				totalmem: () => 16 * 1024 ** 3,
				freemem: () => 8 * 1024 ** 3,
				cacheKey: "win",
			},
		);
		expect(winCalls).toBe(0);
		expect(win).toMatchObject({ ok: true, cpuCores: 8, memTotalMb: 16384, memAvailMb: 8192, memUsedPct: 50 });
	});
});

describe("AGY blocked overlay and quota grid", () => {
	test("readAgyBlockedOverlay reads primary+peer state, skips secrets paths, and drops expired blocks", () => {
		const own = join(tempDir, "own");
		const peerOk = join(tempDir, "peer-ok");
		const peerSecret = join(tempDir, "peer-secret");
		mkdirSync(own, { recursive: true });
		mkdirSync(peerOk, { recursive: true });
		mkdirSync(peerSecret, { recursive: true });
		const stateFile = join(tempDir, "quota-state.json");
		const secretFile = join(tempDir, "secrets", "q.json");
		mkdirSync(join(tempDir, "secrets"), { recursive: true });
		writeFileSync(
			stateFile,
			JSON.stringify({
				current: "ssukcode",
				blocked: { sgkim: NOW + 2 * HOUR, camelwise: NOW - 1000 },
			}),
		);
		writeFileSync(secretFile, JSON.stringify({ current: "secret-acct", blocked: { evil: NOW + HOUR } }));
		writeFileSync(join(own, "config.json"), JSON.stringify({ dashboard: { port: 7331 } }));
		writeFileSync(join(peerOk, "config.json"), JSON.stringify({ agyAccounts: { statePath: stateFile } }));
		writeFileSync(join(peerSecret, "config.json"), JSON.stringify({ agyAccounts: { statePath: secretFile } }));

		const overlay = readAgyBlockedOverlay(own, [{ home: peerSecret }, { home: peerOk }], NOW);
		expect(overlay).toEqual({
			current: "ssukcode",
			blocked: { sgkim: NOW + 2 * HOUR },
		});
	});

	test("applyAgyBlockedOverlay does not mutate cached section and renders 차단 in popover + quota grid", () => {
		const cached: Section<UsageLimitsInfo> = {
			ok: true,
			sources: [
				{
					name: "Claude",
					ok: true,
					rows: [
						{ label: "Claude 5 Hour", window: "5h", windowLabel: "5h", remainingPct: 94, resetsAt: NOW + HOUR },
						{
							label: "Claude 7 Day",
							window: "weekly",
							windowLabel: "7d",
							remainingPct: 28,
							resetsAt: NOW + 2 * 86_400_000,
						},
					],
				},
				{
					name: "Antigravity",
					account: "sgkim",
					ok: true,
					rows: [
						{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 0, resetsAt: NOW + HOUR },
						{
							label: "Gemini Models",
							window: "weekly",
							windowLabel: "weekly",
							remainingPct: 49,
							resetsAt: NOW + 86_400_000,
						},
						{ label: "Claude and GPT models", window: "5h", windowLabel: "5h", remainingPct: 100 },
						{ label: "Claude and GPT models", window: "weekly", windowLabel: "weekly", remainingPct: 100 },
					],
					accounts: [
						{
							name: "sgkim",
							active: true,
							ok: true,
							rows: [
								{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 0, resetsAt: NOW + HOUR },
								{
									label: "Gemini Models",
									window: "weekly",
									windowLabel: "weekly",
									remainingPct: 49,
									resetsAt: NOW + 86_400_000,
								},
								{ label: "Claude and GPT models", window: "5h", windowLabel: "5h", remainingPct: 100 },
								{ label: "Claude and GPT models", window: "weekly", windowLabel: "weekly", remainingPct: 100 },
							],
						},
						{
							name: "ssukcode",
							ok: true,
							rows: [
								{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 76, resetsAt: NOW + 2 * HOUR },
								{
									label: "Gemini Models",
									window: "weekly",
									windowLabel: "weekly",
									remainingPct: 49,
									resetsAt: NOW + 86_400_000,
								},
								{ label: "Claude and GPT models", window: "5h", windowLabel: "5h", remainingPct: 100 },
								{ label: "Claude and GPT models", window: "weekly", windowLabel: "weekly", remainingPct: 100 },
							],
						},
					],
				},
			],
		};
		const snap = structuredClone(cached);
		const overlaid = applyAgyBlockedOverlay(cached, { current: "ssukcode", blocked: { sgkim: NOW + HOUR } }, NOW);
		expect(cached).toEqual(snap);
		expect(overlaid.ok).toBe(true);
		if (!overlaid.ok) throw new Error("expected ok");
		const agy = overlaid.sources[1];
		expect(agy?.account).toBe("ssukcode");
		expect(agy?.accounts?.[0]?.active).toBeUndefined();
		expect(agy?.accounts?.[0]).toMatchObject({ name: "sgkim", blockedUntil: NOW + HOUR });
		expect(agy?.accounts?.[1]).toMatchObject({ name: "ssukcode", active: true });

		const pop = renderLimitsPop(overlaid, NOW, (_k, v) => String(v));
		expect(pop).toContain("차단 1h0m");
		expect(pop).toContain("차단 해제까지 1h0m");

		const grid = renderQuotaGrid(overlaid, NOW);
		expect(grid).toContain("quota-card");
		expect(grid).toContain("사용 중");
		expect(grid).toContain("차단 1h0m");
		expect(grid).toContain("Gemini 5시간");
		expect(grid).toContain("Claude·GPT 5시간");
		expect(grid).not.toContain("limit-tile");
		expect(grid).not.toContain('data-card="usage"');
	});
});

describe("peer context load and tokensOnly rendering", () => {
	test("withContextLoad reads peer live IPC and falls back to peer agy transcript.jsonl", async () => {
		const own = join(tempDir, "own");
		const peer = join(tempDir, "peer");
		mkdirSync(own, { recursive: true });
		mkdirSync(peer, { recursive: true });
		const ownDbPath = join(own, "jabbu.db");
		const peerDbPath = join(peer, "jabbu.db");
		openStore({ timezone: "Asia/Seoul", path: ownDbPath, clock: { now: () => NOW }, redact: (s) => s }).close();
		openStore({ timezone: "Asia/Seoul", path: peerDbPath, clock: { now: () => NOW }, redact: (s) => s }).close();

		const ompOrigin = "discord/ch/300000000000000001/t/10";
		const agyOrigin = "discord/ch/300000000000000001/t/20";
		const ompSessDir = join(peer, "sessions", "omp-s");
		const agySessDir = join(peer, "sessions", "agy-s");
		mkdirSync(ompSessDir, { recursive: true });
		mkdirSync(agySessDir, { recursive: true });
		writeFileSync(
			join(agySessDir, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-12345678", account: "ssukcode" }),
		);
		const agyLogDir = join(
			tempDir,
			".gemini",
			"antigravity-cli-acct-ssukcode",
			"brain",
			"conv-12345678",
			".system_generated",
			"logs",
		);
		mkdirSync(agyLogDir, { recursive: true });
		writeFileSync(
			join(agyLogDir, "transcript.jsonl"),
			`${JSON.stringify({
				type: "PLANNER_RESPONSE",
				input_tokens: 6569,
				cache_read_tokens: 289331,
				output_tokens: 791,
			})}\n`,
		);

		const pdb = new Database(peerDbPath, { strict: true });
		pdb.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			ompOrigin,
			ompSessDir,
			NOW,
		]);
		pdb.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
			agyOrigin,
			agySessDir,
			NOW,
		]);
		pdb.close();

		const ownDb = new Database(ownDbPath, { readonly: true, strict: true });
		const prevHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			const res = await withContextLoad(
				{
					threads: [
						mkThread({ originKey: `뚱기:${ompOrigin}`, install: "뚱기" }),
						mkThread({ originKey: `서팍:${agyOrigin}`, install: "서팍" }),
					],
				},
				ownDb,
				{
					homeDir: own,
					usageLimits: true,
					peers: [
						{ name: "뚱기", home: peer, workspaceDir: peer, timezone: "Asia/Seoul" },
						{ name: "서팍", home: peer, workspaceDir: peer, timezone: "Asia/Seoul" },
					],
					callDaemon: async (_sock, req) => {
						const r = req as { origin?: string };
						if (r.origin === ompOrigin) {
							return { ok: true, live: { context: { tokens: 54_690, window: 1_000_000, percent: 5.469 } } };
						}
						return { ok: true, live: null };
					},
				},
			);
			expect(res.threads[0]?.context).toEqual({ tokens: 54_690, percent: 5.469 });
			expect(res.threads[1]?.context).toEqual({ tokens: 295_900, percent: 0, tokensOnly: true });
			expect(fmtContextRatio(res.threads[0]?.context)).toBe("54.7k / 1.0M");
			expect(fmtContextRatio(res.threads[1]?.context)).toBe("295.9k");
			expect(contextBar(res.threads[1]?.context, "working")).toContain(">295.9k<");
			expect(contextBar(res.threads[1]?.context, "working")).not.toContain("0%");
			expect(contextBar({ tokens: 120_000, percent: 0, tokensOnly: true }, "done")).toBe("");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			ownDb.close();
		}
	});
});

describe("P0 dashboard main-view rendering and SSR/client parity", () => {
	test("renders live rail, active turns cards, quota section, turns ratio, and system cards identically on server & client", () => {
		const hostMetrics: Section<HostMetricsInfo> = {
			ok: true,
			cpuCores: 4,
			load1: 2.1,
			load5: 1.5,
			load15: 1.2,
			cpuPct: 53,
			memTotalMb: 24576,
			memAvailMb: 14336,
			memUsedPct: 42,
			memAvailPct: 58,
			swapTotalMb: 8192,
			swapUsedMb: 2048,
			pressure: "normal",
			browsers: { total: 12, rssMb: 1536, chrome: 4, headless: 8, playwright: 0, agentBrowser: 0 },
		};
		const usageLimits: Section<UsageLimitsInfo> = {
			ok: true,
			sources: [
				{
					name: "Claude",
					ok: true,
					rows: [{ label: "Claude 5 Hour", window: "5h", windowLabel: "5h", remainingPct: 94, resetsAt: NOW + HOUR }],
				},
				{
					name: "Antigravity",
					account: "ssukcode",
					ok: true,
					rows: [{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 76, resetsAt: NOW + HOUR }],
					accounts: [
						{
							name: "ssukcode",
							active: true,
							ok: true,
							rows: [
								{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 76, resetsAt: NOW + HOUR },
							],
						},
						{
							name: "sgkim",
							blockedUntil: NOW + HOUR,
							ok: true,
							rows: [
								{ label: "Gemini Models", window: "5h", windowLabel: "5h", remainingPct: 0, resetsAt: NOW + HOUR },
							],
						},
					],
				},
			],
		};
		const snap = baseSnap({
			channelNames: { "300000000000000001": "#루트" },
			hostMetrics,
			usageLimits,
			peerHealth: {
				ok: true,
				items: [
					{
						name: "서팍",
						running: true,
						discord: "up",
						turns24h: { answered: 10, open: 1, failed: 0 },
						openAlerts: 0,
						agyAccount: { current: "ssukcode", blockedCount: 1 },
					},
				],
			},
			turns: {
				ok: true,
				items: [],
				threads: [
					mkThread({
						title: "본체 작업",
						model: { model: "anthropic/claude-opus-5-5", thinking: "medium", fallback: false },
						context: { tokens: 54_690, percent: 5.469 },
					}),
					mkThread({
						originKey: "서팍:discord/ch/300000000000000001/t/2",
						install: "서팍",
						title: "서팍 · 피어 작업",
						context: { tokens: 295_900, percent: 0, tokensOnly: true },
					}),
				],
			},
			tasks: {
				ok: true,
				items: [
					{
						taskId: "T-20261127-04",
						title: "열린 TASK",
						risk: "L2",
						status: "review",
						host: "local",
						agent: "a1",
						runtime: "herdr",
						branch: "task/T-20261127-04",
						open: true,
						updatedAt: "2026-11-27T13:55:00+09:00",
						acTotal: 2,
					},
				],
			},
		});

		const inboxHtml = renderDashboardMain(snap, undefined, NOW, { view: "inbox" });
		expect(inboxHtml).toContain('class="dash-home has-rail"');
		expect(inboxHtml).toContain('class="dash-rail"');
		expect(inboxHtml).toContain('class="active-sec"');
		expect(inboxHtml).toContain('class="active-grid"');
		expect(inboxHtml).toContain('class="quota-sec"');
		expect(inboxHtml).toContain("54.7k / 1.0M (5%)");
		expect(inboxHtml).toContain("295.9k");
		expect(inboxHtml).toContain("#루트");
		expect(inboxHtml).toContain("차단 1h0m");
		// Active cards navigate via href without data-row/data-item so j/k triage and detail view remain scoped cleanly.
		const activeBlock = /<section class="active-sec"[\s\S]*?<\/section>/.exec(inboxHtml)?.[0] ?? "";
		expect(activeBlock).not.toContain("data-row=");
		expect(activeBlock).not.toContain("data-item=");
		expect(activeBlock).toContain('href="?view=turns&amp;item=');
		expect(inboxHtml).not.toMatch(/<main [^>]*>[\s\S]*limit-tile/);

		const searched = renderDashboardMain(snap, undefined, NOW, { view: "inbox", q: "T-20261127-04" });
		expect(searched).not.toContain('class="dash-rail"');
		expect(searched).not.toContain('class="active-sec"');
		expect(searched).not.toContain('class="quota-sec"');

		const turnsHtml = renderDashboardMain(snap, undefined, NOW, { view: "turns" });
		expect(turnsHtml).toContain('<small class="ctx-ratio">54.7k / 1.0M</small>');

		const sysHtml = renderDashboardMain(snap, undefined, NOW, { view: "system" });
		expect(sysHtml).toContain('data-card="resources"');
		expect(sysHtml).toContain('data-card="quota"');
		expect(sysHtml).not.toContain('data-card="usage"');
		expect(sysHtml).not.toMatch(/<main [^>]*>[\s\S]*limit-tile/);

		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		for (const view of ["inbox", "turns", "system"]) {
			expect(client(snap, undefined, NOW, { view })).toBe(renderDashboardMain(snap, undefined, NOW, { view }));
		}
	});
});
