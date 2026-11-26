// T-20261125-08 item 4: the seven-day cost ledger — byte offsets per session file, a shrunk file read again,
// per-day costs, the costliest sessions with their kind, the cache-write share and the 15-minute cache.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COST_LEDGER_TTL_MS,
	clearCostLedgerCache,
	readCostLedger,
	updateCostLedger,
} from "../src/dashboard/cost-ledger";
import { SCRIPT } from "../src/dashboard/html";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { buildSnapshot, type DashboardSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { STYLE } from "../src/dashboard/style";

/** 2026-11-25 12:00 KST. */
const NOW = Date.parse("2026-11-25T03:00:00Z");
const DAY = 86_400_000;
const TZ = "Asia/Seoul";

const call = (at: number, total: number, cacheWrite = 0): string =>
	`${JSON.stringify({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "assistant", usage: { input: 1, output: 1, cost: { total, cacheWrite } } },
	})}\n`;
const user = (text: string): string =>
	`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

let home: string;
const session = (origin: string): string => {
	const dir = join(home, "sessions", encodeURIComponent(origin), "e1");
	mkdirSync(dir, { recursive: true });
	return join(dir, "s.jsonl");
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-cost-"));
	clearCostLedgerCache();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("AC-5: offsets", () => {
	test("the second run reads only the appended bytes; a truncated file is read from the start", () => {
		const file = session("discord/ch/1/t/2");
		const first = user("배포 점검") + call(NOW - DAY, 1.5, 0.5) + call(NOW, 2);
		writeFileSync(file, first);
		const one = updateCostLedger(home, NOW, TZ);
		expect(one.bytesRead).toBe(Buffer.byteLength(first));
		expect(one.info.total).toBeCloseTo(3.5);

		const more = call(NOW, 0.25);
		appendFileSync(file, more);
		const two = updateCostLedger(home, NOW, TZ);
		expect(two.bytesRead).toBe(Buffer.byteLength(more));
		expect(two.info.total).toBeCloseTo(3.75);

		expect(updateCostLedger(home, NOW, TZ).bytesRead).toBe(0);

		const shorter = call(NOW, 1);
		writeFileSync(file, shorter);
		const three = updateCostLedger(home, NOW, TZ);
		expect(three.bytesRead).toBe(Buffer.byteLength(shorter));
		expect(three.info.total).toBeCloseTo(1);
	});

	test("a torn last line waits for its newline", () => {
		const file = session("discord/ch/1/t/2");
		const whole = call(NOW, 1);
		const torn = call(NOW, 2);
		writeFileSync(file, whole + torn.slice(0, 20));
		expect(updateCostLedger(home, NOW, TZ).info.total).toBeCloseTo(1);
		appendFileSync(file, torn.slice(20));
		const next = updateCostLedger(home, NOW, TZ);
		expect(next.bytesRead).toBe(Buffer.byteLength(torn));
		expect(next.info.total).toBeCloseTo(3);
	});
});

describe("AC-5: the card", () => {
	test("seven days oldest first, top sessions with their kind, the cache-write share", () => {
		writeFileSync(session("discord/ch/1/t/2"), user("배포 점검") + call(NOW - DAY, 4, 2) + call(NOW, 1));
		writeFileSync(session("jabbu/work/ui-fix"), call(NOW, 3, 1));
		writeFileSync(session("jabbu/task/t-1"), call(NOW, 2));
		writeFileSync(session("monitor/m1"), call(NOW - 2 * DAY, 0.5));
		writeFileSync(session("discord/ch/1/t/3"), call(NOW - 10 * DAY, 9));
		const { info } = updateCostLedger(home, NOW, TZ);
		expect(info.days.map((d) => d.day)).toEqual(["11-19", "11-20", "11-21", "11-22", "11-23", "11-24", "11-25"]);
		expect(info.days.map((d) => d.cost)).toEqual([0, 0, 0, 0, 0.5, 4, 6]);
		expect(info.top).toEqual([
			{ title: "배포 점검", kind: "대화", cost: 5 },
			{ title: "ui-fix", kind: "레인", cost: 3 },
			{ title: "t-1", kind: "TASK", cost: 2 },
			{ title: "monitor/m1", kind: "모니터", cost: 0.5 },
		]);
		expect(info.total).toBeCloseTo(10.5);
		expect(info.cacheWritePct).toBe(29);
	});

	test("the window walks calendar days: the 23-hour DST spring-forward day is not skipped", () => {
		// 2026-03-09 00:30 in New York (EDT); 2026-03-08 is the 23-hour day the clocks jump over.
		const nyNow = Date.parse("2026-03-09T04:30:00Z");
		writeFileSync(session("discord/ch/1/t/2"), call(Date.parse("2026-03-08T12:00:00Z"), 7));
		const { info } = updateCostLedger(home, nyNow, "America/New_York");
		expect(info.days.map((d) => d.day)).toEqual(["03-03", "03-04", "03-05", "03-06", "03-07", "03-08", "03-09"]);
		expect(info.days.map((d) => d.cost)).toEqual([0, 0, 0, 0, 0, 7, 0]);
		expect(info.total).toBeCloseTo(7);
	});

	test("one computation per 15 minutes", async () => {
		const file = session("discord/ch/1/t/2");
		writeFileSync(file, call(NOW, 1));
		const first = await readCostLedger(home, () => NOW, TZ);
		appendFileSync(file, call(NOW, 1));
		expect(await readCostLedger(home, () => NOW + COST_LEDGER_TTL_MS - 1, TZ)).toBe(first);
		const later = await readCostLedger(home, () => NOW + COST_LEDGER_TTL_MS, TZ);
		expect(later.ok && later.total).toBeCloseTo(2);
	});
});

describe("the system view's 7일 비용 card", () => {
	const snapshotOf = (usageLimits: boolean): Promise<DashboardSnapshot> => {
		const deps: SnapshotDeps = {
			homeDir: home,
			repoDir: "/srv/jabbu",
			timezone: TZ,
			config: undefined,
			now: () => NOW,
			...(usageLimits ? { usageLimits } : {}),
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
		return buildSnapshot(deps);
	};
	const cardOf = (html: string): string =>
		/<section class="sys-card[^"]*" data-card="cost"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

	test("a day bar per day, the top sessions with their kind and the cache-write share; the client draws the same", async () => {
		writeFileSync(session("discord/ch/1/t/2"), user("배포 점검") + call(NOW - DAY, 4, 2) + call(NOW, 1));
		writeFileSync(session("jabbu/work/ui-fix"), call(NOW, 3, 1));
		const snapshot = await snapshotOf(true);
		const server = renderDashboardMain(snapshot, undefined, NOW, { view: "system" });
		const card = cardOf(server);
		expect(card.match(/<div class="limit-row" data-day=/g)).toHaveLength(7);
		expect(card).toContain('data-day="11-24"><span class="limit-name">11-24</span>');
		expect(card).toContain('<b class="limit-pct">$4.00</b>');
		expect(card).toContain(
			'<span class="gate-word">대화</span><span class="gate-label">배포 점검</span><code class="gate-detail">$5.00</code>',
		);
		expect(card).toContain('<span class="gate-word">레인</span><span class="gate-label">ui-fix</span>');
		expect(card).toContain("7일 합계 $8.00 · 캐시 쓰기 38% · 이 기기 세션만 집계 (원격 호스트 제외)");
		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(client(snapshot, undefined, NOW, { view: "system" })).toBe(server);
	});

	test("a failed read is the card's note; without the dashboard flag there is no card and no ledger file", async () => {
		const snapshot = await snapshotOf(false);
		expect(snapshot.costLedger).toBeUndefined();
		expect(cardOf(renderDashboardMain(snapshot, undefined, NOW, { view: "system" }))).toBe("");
		const failed = { ...snapshot, costLedger: { ok: false as const, error: "boom" } };
		expect(cardOf(renderDashboardMain(failed, undefined, NOW, { view: "system" }))).toContain("읽지 못했어요: boom");
	});

	test("UX-005: strips Discord channel context header before [현재 요청] and keeps cost values unwrapped", async () => {
		const wrapped = "[이 방의 자리와 용도 — Discord 채널 정보]\n```\n자리: #서팍\n```\n\n[현재 요청]\n실제 작업 제목";
		writeFileSync(session("discord/ch/1/t/99"), user(wrapped) + call(NOW, 77.43, 0));
		const ledger = await readCostLedger(home, () => NOW, TZ);
		if (!ledger.ok) throw new Error(ledger.error);
		expect(ledger.top[0]?.title).toBe("실제 작업 제목");
		expect(STYLE).toContain('[data-card="cost"] .limit-row');
		expect(STYLE).toContain('[data-card="cost"] .limit-pct { white-space: nowrap; }');
	});
});
