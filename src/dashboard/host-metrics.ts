import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import type { ProcessRunner } from "../dispatch/omp";
import { sectionCache } from "./section-cache";
import type { Section } from "./snapshot";

/** Cache lifetime for local host CPU/memory/browser probes. */
export const HOST_METRICS_TTL_MS = 30_000;
const PS_TIMEOUT_MS = 3_000;
const PS_STDOUT_CAP = 512_000;

export interface BrowserBreakdown {
	total: number;
	rssMb: number;
	chrome: number;
	headless: number;
	playwright: number;
	agentBrowser: number;
}

export interface HostMetricsInfo {
	cpuCores: number;
	load1: number;
	load5: number;
	load15: number;
	cpuPct: number;
	memTotalMb: number;
	memAvailMb: number;
	memUsedPct: number;
	memAvailPct: number;
	swapTotalMb: number;
	swapUsedMb: number;
	pressure?: "normal" | "some" | "full";
	browsers: BrowserBreakdown;
}

export interface HostMetricsOptions {
	platform?: NodeJS.Platform;
	meminfoPath?: string;
	pressurePath?: string;
	cpus?: () => number;
	loadavg?: () => [number, number, number];
	totalmem?: () => number;
	freemem?: () => number;
	cacheKey?: string;
}

const ZERO_BROWSERS: BrowserBreakdown = {
	total: 0,
	rssMb: 0,
	chrome: 0,
	headless: 0,
	playwright: 0,
	agentBrowser: 0,
};

/** Parses `/proc/meminfo` (kB values) into rounded MiB and availability/usage percentages. */
export function parseMeminfo(
	text: string,
):
	| Pick<HostMetricsInfo, "memTotalMb" | "memAvailMb" | "memUsedPct" | "memAvailPct" | "swapTotalMb" | "swapUsedMb">
	| undefined {
	const vals: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z0-9_()]+):\s+(\d+)/.exec(line.trim());
		if (m?.[1] !== undefined && m[2] !== undefined) vals[m[1]] = Number(m[2]);
	}
	const totalKb = vals.MemTotal;
	if (totalKb === undefined || !Number.isFinite(totalKb) || totalKb <= 0) return undefined;
	const rawAvailKb = vals.MemAvailable ?? (vals.MemFree ?? 0) + (vals.Buffers ?? 0) + (vals.Cached ?? 0);
	const availKb = Math.min(totalKb, Math.max(0, rawAvailKb));
	const memTotalMb = Math.round(totalKb / 1024);
	const memAvailMb = Math.round(availKb / 1024);
	const memAvailPct = Math.min(100, Math.max(0, Math.round((availKb / totalKb) * 100)));
	const memUsedPct = 100 - memAvailPct;
	const swapTotalKb = Math.max(0, vals.SwapTotal ?? 0);
	const swapFreeKb = Math.min(swapTotalKb, Math.max(0, vals.SwapFree ?? swapTotalKb));
	return {
		memTotalMb,
		memAvailMb,
		memUsedPct,
		memAvailPct,
		swapTotalMb: Math.round(swapTotalKb / 1024),
		swapUsedMb: Math.round((swapTotalKb - swapFreeKb) / 1024),
	};
}

/** Parses `/proc/pressure/memory` into `normal | some | full`. */
export function parseMemoryPressure(text: string): "normal" | "some" | "full" | undefined {
	const some = /\bsome\b[^\n]*?\bavg10=([\d.]+)/.exec(text)?.[1];
	const full = /\bfull\b[^\n]*?\bavg10=([\d.]+)/.exec(text)?.[1];
	if (some === undefined && full === undefined) return undefined;
	const someVal = some === undefined ? 0 : Number(some);
	const fullVal = full === undefined ? 0 : Number(full);
	if (Number.isFinite(fullVal) && fullVal >= 5) return "full";
	if (Number.isFinite(someVal) && someVal >= 10) return "some";
	return "normal";
}

const BROWSER_BIN_RE = /^(?:(?:google-)?chrom(?:e|ium)|headless_shell|chrome-headless|agent-browser|playwright)/i;
const RUNTIME_WRAPPER_RE = /^(?:node|nodejs|deno|bun|python\d*(?:\.\d+)?)$/i;
const WRAPPER_AGENT_BROWSER_RE = /(?:^|[\s/])agent-browser(?:\s|$)/i;
const WRAPPER_PLAYWRIGHT_RE =
	/(?:^|[\s/])playwright(?:-core)?(?:\/cli\.js|\/driver|\s+(?:run-driver|open|codegen|install|show-report|screenshot|pdf)|$)/i;

/**
 * Classifies browser processes from `ps -eo rss=,comm=,args=` into mutually exclusive buckets
 * (`agentBrowser`, `playwright`, `headless`, `chrome`) excluding crashpad helpers and non-browser tools (e.g. `grep`, tests).
 */
export function parseBrowserPs(stdout: string): BrowserBreakdown {
	let total = 0;
	let rssKb = 0;
	let chrome = 0;
	let headless = 0;
	let playwright = 0;
	let agentBrowser = 0;
	for (const line of stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
		if (m?.[1] === undefined || m[2] === undefined) continue;
		const comm = m[2];
		const args = m[3] ?? "";
		const cmd = `${comm} ${args}`;
		if (/crashpad/i.test(cmd)) continue;
		const argv0 = (args.trim().split(/\s+/)[0] ?? "").split("/").at(-1) ?? "";
		const isNativeBrowser = BROWSER_BIN_RE.test(comm) || BROWSER_BIN_RE.test(argv0);
		const isAutomationWrapper =
			!isNativeBrowser &&
			RUNTIME_WRAPPER_RE.test(comm) &&
			(WRAPPER_AGENT_BROWSER_RE.test(args) || WRAPPER_PLAYWRIGHT_RE.test(args));
		if (!isNativeBrowser && !isAutomationWrapper) continue;
		total += 1;
		rssKb += Number(m[1]);
		if (WRAPPER_AGENT_BROWSER_RE.test(args) || /^agent-browser/i.test(comm)) agentBrowser += 1;
		else if (/playwright/i.test(cmd)) playwright += 1;
		else if (/--headless|headless_shell|headless/i.test(cmd)) headless += 1;
		else chrome += 1;
	}
	return {
		total,
		rssMb: Math.round((rssKb / 1024) * 10) / 10,
		chrome,
		headless,
		playwright,
		agentBrowser,
	};
}

const cache = sectionCache<HostMetricsInfo>(HOST_METRICS_TTL_MS);

/** Test only: clears the cached host metrics section. */
export const clearHostMetricsCache = (): void => cache.clear();

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Reads CPU load, memory/swap/pressure, and browser process RSS on the local host (30s cache). Never throws. */
export function readHostMetrics(
	run: ProcessRunner,
	now: () => number,
	opts?: HostMetricsOptions,
): Promise<Section<HostMetricsInfo>> {
	const key = opts?.cacheKey ?? "local";
	return cache.read(key, now, async () => {
		const platform = opts?.platform ?? process.platform;
		const cpuCores = Math.max(1, opts?.cpus ? opts.cpus() : cpus().length || 1);
		const [l1 = 0, l5 = 0, l15 = 0] = opts?.loadavg ? opts.loadavg() : loadavg();
		const cpuPct = Math.min(999, Math.max(0, Math.round((l1 / cpuCores) * 100)));

		let mem: ReturnType<typeof parseMeminfo>;
		if (platform !== "win32") {
			try {
				mem = parseMeminfo(readFileSync(opts?.meminfoPath ?? "/proc/meminfo", "utf8"));
			} catch {
				mem = undefined;
			}
		}
		if (mem === undefined) {
			const tot = Math.max(1024, opts?.totalmem ? opts.totalmem() : totalmem());
			const free = Math.min(tot, Math.max(0, opts?.freemem ? opts.freemem() : freemem()));
			const memAvailPct = Math.min(100, Math.max(0, Math.round((free / tot) * 100)));
			mem = {
				memTotalMb: Math.round(tot / 1_048_576),
				memAvailMb: Math.round(free / 1_048_576),
				memUsedPct: 100 - memAvailPct,
				memAvailPct,
				swapTotalMb: 0,
				swapUsedMb: 0,
			};
		}

		let pressure: HostMetricsInfo["pressure"];
		if (platform !== "win32") {
			try {
				pressure = parseMemoryPressure(readFileSync(opts?.pressurePath ?? "/proc/pressure/memory", "utf8"));
			} catch {
				pressure = undefined;
			}
		}

		let browsers: BrowserBreakdown = { ...ZERO_BROWSERS };
		if (platform !== "win32") {
			try {
				const out = await run(["ps", "-eo", "rss=,comm=,args="], {
					timeoutMs: PS_TIMEOUT_MS,
					stdoutCap: PS_STDOUT_CAP,
				});
				if (!out.timedOut && out.code === 0) browsers = parseBrowserPs(out.stdout);
			} catch {
				browsers = { ...ZERO_BROWSERS };
			}
		}

		return {
			ok: true,
			cpuCores,
			load1: round2(l1),
			load5: round2(l5),
			load15: round2(l15),
			cpuPct,
			...mem,
			...(pressure === undefined ? {} : { pressure }),
			browsers,
		};
	});
}
