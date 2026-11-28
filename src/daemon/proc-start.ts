import { readFileSync } from "node:fs";

/** Linux clock ticks per second (`CLK_TCK`): 100 on x86_64 and arm64, the platforms this daemon runs on. */
const CLK_TCK = 100;

/**
 * How much later than the lock's `startedAt` a holder's process may report starting and still count as the holder:
 * `/proc/stat` btime is second-precision and the wall clock may step, so a few seconds of slack. A pid reused after
 * that window is a different process and the lock is stale; reuse inside the window still refuses (safe direction).
 */
const STARTED_AT_TOLERANCE_MS = 5_000;

/**
 * Start time of process `pid` in epoch ms, from `/proc/<pid>/stat` field 22 (starttime, ticks since boot) plus the
 * boot time in `/proc/stat`; undefined off Linux, when the process is gone, or when either file is unreadable.
 * The comm field may contain spaces or parens, so the fields after it are split off the last `)`.
 */
export function processStartedAt(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/);
		const ticks = Number(fields[19]);
		if (!Number.isFinite(ticks)) return undefined;
		const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
		if (btime === undefined) return undefined;
		return Number(btime) * 1000 + (ticks * 1000) / CLK_TCK;
	} catch {
		return undefined;
	}
}

/**
 * Whether the process `pid` plausibly started the lock recorded at `recordedStartedAt`: its actual start is no later
 * than the lock write plus tolerance. An unreadable start time fails closed (the pid alone decides, as before).
 * `startedAt` is the process-start probe (default: the real `/proc` read); tests inject one.
 */
export function startedAtMatches(
	pid: number,
	recordedStartedAt: number,
	startedAt: (pid: number) => number | undefined = processStartedAt,
): boolean {
	const started = startedAt(pid);
	return started === undefined || started <= recordedStartedAt + STARTED_AT_TOLERANCE_MS;
}
