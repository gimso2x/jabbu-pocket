import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../omp/type-guards";
import { formatLocal } from "../time";
import { esc } from "./text";
import type { UsageRow, UsageSource } from "./usage-limits";

/**
 * The "모델 한도" rows' burn-down forecast (from herdr-modulor `modulor-quota`). Every fresh run of the card (TTL 15
 * minutes) appends one sample per five-hour or weekly row to `<home>/state/usage-samples.jsonl`; a row's current
 * cycle (the samples since its reset moved or its share jumped back up) gives a least-squares decline per hour.
 */

export interface UsageSample {
	at: number;
	source: string;
	label: string;
	window: "5h" | "weekly";
	remainingPct: number;
	resetsAt?: number;
}

export interface UsageTrend {
	/** collecting: too few samples · flat: under {@link FLAT_RATE} · holds: lasts until the reset · zero: runs out first. */
	state: "collecting" | "flat" | "holds" | "zero";
	/** Decline in percentage points per hour (holds, zero). */
	rate?: number;
	/** Epoch ms the fit reaches 0% (holds, zero). */
	zeroAt?: number;
	/** Five-hour: runs out before its reset. Weekly: runs out within {@link WEEKLY_DANGER_MS} and before its reset. */
	danger: boolean;
	/** The current cycle's remaining shares as block characters, oldest first, at most {@link SPARK_CELLS}. */
	spark: string;
	/** Hover text: fit window, sample count, 0% and reset times. */
	title: string;
}

/** Fs seam for the sample file; a failed read or write calls `warn` and the card is drawn anyway. */
export interface SampleStore {
	read(file: string): string;
	write(file: string, text: string): void;
	warn(message: string): void;
}

/** Where samples live and how their times read; `store` replaces the file system in tests. */
export interface TrendOptions {
	home: string;
	timezone: string;
	store?: SampleStore;
}

const KEEP_MS = 7 * 86_400_000;
const FIT_MS = { "5h": 90 * 60_000, weekly: 24 * 3_600_000 } as const;
const MIN_SPAN_MS = 60_000;
const FLAT_RATE = 0.05;
const WEEKLY_DANGER_MS = 36 * 3_600_000;
const CYCLE_JUMP_PCT = 10;
/** Reset times move this much between runs without a new cycle (a provider recomputes them each call). */
const RESET_SLACK_MS = 10 * 60_000;
const SPARK_CELLS = 16;
const BLOCKS = "▁▂▃▄▅▆▇█";

export const usageSamplesFile = (home: string): string => join(home, "state", "usage-samples.jsonl");

const realStore: SampleStore = {
	read: (file) => {
		try {
			return readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	},
	write: (file, text) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(`${file}.tmp`, text);
		renameSync(`${file}.tmp`, file);
	},
	warn: (message) => process.stderr.write(`dashboard: ${message}\n`),
};

function parseSample(line: string): UsageSample | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.at !== "number" || typeof value.remainingPct !== "number") return undefined;
	if (typeof value.source !== "string" || typeof value.label !== "string") return undefined;
	if (value.window !== "5h" && value.window !== "weekly") return undefined;
	const sample: UsageSample = {
		at: value.at,
		source: value.source,
		label: value.label,
		window: value.window,
		remainingPct: value.remainingPct,
	};
	if (typeof value.resetsAt === "number") sample.resetsAt = value.resetsAt;
	return sample;
}

/**
 * Appends `fresh` to the sample file, dropping lines older than seven days, and returns every kept sample. A read
 * failure starts from `fresh` alone; a write failure keeps the returned samples; both only warn.
 */
export function recordUsageSamples(
	file: string,
	fresh: UsageSample[],
	now: number,
	store: SampleStore = realStore,
): UsageSample[] {
	let kept: UsageSample[] = [];
	try {
		kept = store
			.read(file)
			.split("\n")
			.flatMap((line) => parseSample(line) ?? [])
			.filter((sample) => now - sample.at <= KEEP_MS);
	} catch (error) {
		store.warn(`usage samples unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const all = [...kept, ...fresh];
	try {
		store.write(file, all.map((sample) => `${JSON.stringify(sample)}\n`).join(""));
	} catch (error) {
		store.warn(`usage samples not written: ${error instanceof Error ? error.message : String(error)}`);
	}
	return all;
}

/** The samples since the last cycle start (reset time moved, or the share rose by more than 10 points), oldest first. */
export function currentCycle(samples: UsageSample[]): UsageSample[] {
	const sorted = [...samples].sort((a, b) => a.at - b.at);
	let start = 0;
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1] as UsageSample;
		const cur = sorted[i] as UsageSample;
		const moved =
			(prev.resetsAt === undefined) !== (cur.resetsAt === undefined) ||
			Math.abs((cur.resetsAt ?? 0) - (prev.resetsAt ?? 0)) > RESET_SLACK_MS;
		if (moved || cur.remainingPct - prev.remainingPct > CYCLE_JUMP_PCT) start = i;
	}
	return sorted.slice(start);
}

/** A row's trend from its current cycle (oldest first) at `now`. */
export function forecastCycle(
	cycle: UsageSample[],
	window: "5h" | "weekly",
	now: number,
	timezone: string,
): UsageTrend {
	const spark = cycle
		.slice(-SPARK_CELLS)
		.map((sample) => BLOCKS[Math.min(7, Math.max(0, Math.floor(sample.remainingPct / 12.5)))])
		.join("");
	const fit = cycle.filter((sample) => now - sample.at <= FIT_MS[window]);
	const last = cycle.at(-1);
	const resetsAt = last?.resetsAt;
	const at = (ms: number): string => formatLocal(ms, timezone).slice(5, 16);
	const head = `${window === "5h" ? "최근 90분" : "최근 24시간"} · 표본 ${fit.length}개`;
	const resetText = resetsAt === undefined ? "" : ` · 초기화 ${at(resetsAt)}`;
	const first = fit[0];
	const newest = fit.at(-1);
	if (first === undefined || newest === undefined || newest.at - first.at < MIN_SPAN_MS) {
		return { state: "collecting", danger: false, spark, title: `${head}${resetText}` };
	}
	const hours = fit.map((sample) => (sample.at - first.at) / 3_600_000);
	const meanX = hours.reduce((sum, x) => sum + x, 0) / fit.length;
	const meanY = fit.reduce((sum, sample) => sum + sample.remainingPct, 0) / fit.length;
	let num = 0;
	let den = 0;
	for (const [i, sample] of fit.entries()) {
		const dx = (hours[i] as number) - meanX;
		num += dx * (sample.remainingPct - meanY);
		den += dx * dx;
	}
	const rate = -num / den;
	if (!(rate >= FLAT_RATE)) return { state: "flat", danger: false, spark, title: `${head}${resetText}` };
	const fitNow = meanY - rate * ((newest.at - first.at) / 3_600_000 - meanX);
	const zeroAt = Math.round(newest.at + (Math.max(0, fitNow) / rate) * 3_600_000);
	const runsOut = resetsAt === undefined || zeroAt < resetsAt;
	const danger = runsOut && (window === "5h" || zeroAt - now <= WEEKLY_DANGER_MS);
	return {
		state: runsOut ? "zero" : "holds",
		rate,
		zeroAt,
		danger,
		spark,
		title: `${head} · 0% 예상 ${at(zeroAt)}${resetText}`,
	};
}

/** `warn` under 20% remaining, `danger` under 5%; serialized into the page script, so it stays self-contained. */
export function usageLevel(remainingPct: number): "ok" | "warn" | "danger" {
	return remainingPct < 5 ? "danger" : remainingPct < 20 ? "warn" : "ok";
}

/** Time until a reset as `1h46m`, `4d6h`, `12m`; empty once it has passed. Self-contained for the page script. */
export function resetIn(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined || resetsAt <= now) return "";
	const minutes = Math.floor((resetsAt - now) / 60_000);
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
	return hours >= 1 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

/** The trend line under a limit row; self-contained for the page script (uses the shipped `esc`). */
export function trendHtml(trend: UsageTrend | undefined, now: number): string {
	if (trend === undefined) return "";
	const left = Math.max(0, Math.round(((trend.zeroAt ?? now) - now) / 60_000));
	const rate = `-${(trend.rate ?? 0).toFixed(1)}%/h · `;
	const text =
		trend.state === "collecting"
			? "추세 수집 중"
			: trend.state === "flat"
				? "변화 없음"
				: trend.state === "holds"
					? `${rate}초기화까지 버팀`
					: `${rate}${Math.floor(left / 60)}시간 ${left % 60}분 뒤 0%`;
	return `<span class="limit-trend${trend.danger ? " is-danger" : ""}" title="${esc(trend.title)}">${esc(
		`${trend.spark} ${text}`.trim(),
	)}</span>`;
}

/**
 * Records this run's five-hour and weekly rows and returns the sources with each such row's {@link UsageTrend}.
 * Never throws for the file: a failed read or write only warns.
 */
export function withTrends(sources: UsageSource[], options: TrendOptions, now: number): UsageSource[] {
	const keyOf = (s: Pick<UsageSample, "source" | "label" | "window">): string => `${s.source}\t${s.label}\t${s.window}`;
	const tracked = (row: UsageRow): row is UsageRow & { window: "5h" | "weekly" } => row.window !== "other";
	const fresh = sources.flatMap((source) =>
		source.ok
			? source.rows.filter(tracked).map(
					(row): UsageSample => ({
						at: now,
						source: source.name,
						label: row.label,
						window: row.window,
						remainingPct: row.remainingPct,
						...(row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt }),
					}),
				)
			: [],
	);
	const all = recordUsageSamples(usageSamplesFile(options.home), fresh, now, options.store);
	const byRow = Map.groupBy(all, keyOf);
	return sources.map((source) =>
		source.ok
			? {
					...source,
					rows: source.rows.map((row) =>
						tracked(row)
							? {
									...row,
									trend: forecastCycle(
										currentCycle(byRow.get(keyOf({ source: source.name, ...row })) ?? []),
										row.window,
										now,
										options.timezone,
									),
								}
							: row,
					),
				}
			: source,
	);
}
