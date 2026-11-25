// T-20261125-08 item 1: the limit rows' burn-down forecast — cycle split, least-squares rate, the four phrases,
// danger rules, and the seven-day sample file behind it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	currentCycle,
	forecastCycle,
	recordUsageSamples,
	type SampleStore,
	trendHtml,
	type UsageSample,
	usageSamplesFile,
} from "../src/dashboard/usage-forecast";
import { clearUsageLimitsCache, readUsageLimits } from "../src/dashboard/usage-limits";
import type { ProcessRunner } from "../src/dispatch/omp";

const NOW = Date.parse("2026-11-25T03:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const TZ = "Asia/Seoul";

/** Samples `[minutes before NOW, remaining %]` of one row with one reset time. */
const series = (window: "5h" | "weekly", resetsAt: number, points: Array<[number, number]>): UsageSample[] =>
	points.map(([ago, remainingPct]) => ({
		at: NOW - ago * MIN,
		source: "Claude",
		label: "Claude 5 Hour",
		window,
		remainingPct,
		resetsAt,
	}));
const text = (cycle: UsageSample[], window: "5h" | "weekly") => {
	const trend = forecastCycle(cycle, window, NOW, TZ);
	return { trend, html: trendHtml(trend, NOW) };
};

describe("AC-1 forecast: the four phrases", () => {
	test("one sample, or two closer than 60 seconds: 추세 수집 중", () => {
		expect(text(series("5h", NOW + 4 * HOUR, [[0, 80]]), "5h").html).toContain("추세 수집 중");
		const close = series("5h", NOW + 4 * HOUR, [
			[0.5, 81],
			[0, 80],
		]);
		expect(text(close, "5h").trend.state).toBe("collecting");
	});

	test("a decline under 0.05 points per hour: 변화 없음", () => {
		const still = series("weekly", NOW + 72 * HOUR, [
			[600, 50],
			[300, 50],
			[0, 50],
		]);
		const { trend, html } = text(still, "weekly");
		expect(trend).toMatchObject({ state: "flat", danger: false });
		expect(html).toContain("변화 없음");
	});

	test("reaches 0% only after the reset: -X.X%/h · 초기화까지 버팀, no color", () => {
		// 2 points per hour from 90%: 0% in 45 hours, the reset is in 4.
		const slow = series("5h", NOW + 4 * HOUR, [
			[60, 92],
			[30, 91],
			[0, 90],
		]);
		const { trend, html } = text(slow, "5h");
		expect(trend).toMatchObject({ state: "holds", danger: false });
		expect(html).toContain("-2.0%/h · 초기화까지 버팀");
		expect(html).toContain('class="limit-trend"');
	});

	test("reaches 0% before the reset: -X.X%/h · N시간 M분 뒤 0%, five-hour in danger", () => {
		// 20 points per hour from 50%: 0% in 2h30m, the reset is in 4h.
		const fast = series("5h", NOW + 4 * HOUR, [
			[60, 70],
			[30, 60],
			[0, 50],
		]);
		const { trend, html } = text(fast, "5h");
		expect(trend).toMatchObject({ state: "zero", danger: true, zeroAt: NOW + 150 * MIN });
		expect(html).toContain("-20.0%/h · 2시간 30분 뒤 0%");
		expect(html).toContain('class="limit-trend is-danger"');
		expect(html).toMatch(/title="최근 90분 · 표본 3개 · 0% 예상 11-25 14:30 · 초기화 11-25 16:00"/);
	});

	test("the fit window: five-hour reads the last 90 minutes only", () => {
		// An old steep drop outside the window does not count; the last 90 minutes are flat.
		const points: Array<[number, number]> = [
			[200, 100],
			[80, 40],
			[40, 40],
			[0, 40],
		];
		expect(text(series("5h", NOW + 4 * HOUR, points), "5h").trend.state).toBe("flat");
	});
});

describe("AC-1 forecast: cycles", () => {
	test("a moved reset time starts a new cycle", () => {
		const old = series("5h", NOW - HOUR, [
			[200, 90],
			[150, 10],
		]);
		const fresh = series("5h", NOW + 4 * HOUR, [
			[30, 99],
			[0, 98],
		]);
		expect(currentCycle([...fresh, ...old])).toEqual(fresh);
	});

	test("a share rising by more than 10 points starts a new cycle; 10 or less does not", () => {
		const reset = NOW + 4 * HOUR;
		const jumped = series("5h", reset, [
			[60, 30],
			[30, 41],
			[0, 40],
		]);
		expect(currentCycle(jumped).map((s) => s.remainingPct)).toEqual([41, 40]);
		const small = series("5h", reset, [
			[60, 30],
			[30, 40],
			[0, 39],
		]);
		expect(currentCycle(small)).toHaveLength(3);
	});

	test("the spark line shows the current cycle only, at most 16 cells", () => {
		const reset = NOW + 4 * HOUR;
		const many = series(
			"5h",
			reset,
			Array.from({ length: 20 }, (_, i): [number, number] => [80 - i * 4, 100 - i * 5]),
		);
		expect([...forecastCycle(currentCycle(many), "5h", NOW, TZ).spark]).toHaveLength(16);
	});
});

describe("AC-1 forecast: danger colors", () => {
	const weekly = (hoursToZero: number, resetHours: number) => {
		// 1 point per hour from `hoursToZero`%.
		const cycle = series("weekly", NOW + resetHours * HOUR, [
			[120, hoursToZero + 2],
			[60, hoursToZero + 1],
			[0, hoursToZero],
		]);
		return forecastCycle(cycle, "weekly", NOW, TZ);
	};

	test("weekly: 0% within 36 hours and before the reset is danger", () => {
		expect(weekly(30, 48)).toMatchObject({ state: "zero", danger: true });
		expect(weekly(36, 48)).toMatchObject({ state: "zero", danger: true });
	});

	test("weekly: 0% beyond 36 hours, or after the reset, is no color", () => {
		expect(weekly(40, 48)).toMatchObject({ state: "zero", danger: false });
		expect(weekly(30, 20)).toMatchObject({ state: "holds", danger: false });
	});

	test("five-hour: any 0% before the reset is danger, after it none", () => {
		const cycle = (resetHours: number) =>
			series("5h", NOW + resetHours * HOUR, [
				[60, 12],
				[0, 10],
			]);
		expect(forecastCycle(cycle(10), "5h", NOW, TZ)).toMatchObject({ state: "zero", danger: true });
		expect(forecastCycle(cycle(4), "5h", NOW, TZ)).toMatchObject({ state: "holds", danger: false });
	});
});

describe("AC-2: the sample file", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "jabbu-forecast-"));
		clearUsageLimitsCache();
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	test("lines older than seven days are cut when writing", () => {
		const file = usageSamplesFile(home);
		const reset = NOW + HOUR;
		recordUsageSamples(file, series("5h", reset, [[8 * 24 * 60, 90]]), NOW - 8 * 24 * HOUR + 1, quiet());
		recordUsageSamples(file, series("5h", reset, [[6 * 24 * 60, 80]]), NOW - 6 * 24 * HOUR, quiet());
		const kept = recordUsageSamples(file, series("5h", reset, [[0, 70]]), NOW, quiet());
		expect(kept.map((s) => s.remainingPct)).toEqual([80, 70]);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((line) => (JSON.parse(line) as UsageSample).remainingPct)).toEqual([80, 70]);
	});

	test("a failing write keeps the card section ok and only warns", async () => {
		const warnings: string[] = [];
		const store: SampleStore = {
			read: () => "",
			write: () => {
				throw new Error("disk full");
			},
			warn: (message) => warnings.push(message),
		};
		const run: ProcessRunner = async () => ({
			code: 0,
			timedOut: false,
			stdout: JSON.stringify({
				reports: [
					{
						limits: [
							{ label: "Claude 5 Hour", window: { id: "5h", resetsAt: NOW + HOUR }, amount: { usedFraction: 0.2 } },
						],
					},
				],
			}),
		});
		const section = await readUsageLimits({ omp: [["omp", "usage", "-p", "anthropic"]] }, run, () => NOW, {
			home,
			timezone: TZ,
			store,
		});
		if (!section.ok) throw new Error(section.error);
		expect(section.sources[0]?.ok).toBe(true);
		expect(section.sources[0]?.ok && section.sources[0].rows[0]?.trend?.state).toBe("collecting");
		expect(warnings).toEqual(["usage samples not written: disk full"]);
	});
});

/** The real file system; a warning fails the test. */
function quiet(): SampleStore {
	return {
		read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : ""),
		write: (file, body) => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body);
		},
		warn: (message) => {
			throw new Error(message);
		},
	};
}
