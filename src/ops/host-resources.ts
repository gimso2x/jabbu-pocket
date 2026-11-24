import { readFileSync, statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { type CgroupMemory, sampleCgroupMemory } from "./cgroup-memory";
import { DEFAULT_HOST_SESSION_CEILING } from "./host-sessions";

/** Below this much free space a filesystem is low (gajae-way ops cycle: 5 GiB or 10%, whichever trips first). */
export const DISK_MIN_FREE_BYTES = 5 * 1024 ** 3;
/** ... or below this share of its size. */
export const DISK_MIN_FREE_RATIO = 0.1;
/** The 15-minute load average at or past this many runnable tasks per CPU is pressure. */
export const LOAD_PER_CPU_MAX = 2;
/** MemAvailable under this share of MemTotal is pressure. */
export const MEM_AVAILABLE_MIN_RATIO = 0.05;
/**
 * Free memory of a visible cgroup budget (`memory.high`/`memory.max`) under this share opens `host_pressure` and
 * refuses new starts. Separate from the host's 5% (`MEM_AVAILABLE_MIN_RATIO`): this host's `app.slice` carries an
 * 18 GiB `memory.high` the bot hits long before MemAvailable drops that low. Start at 10%; tune on the refusals.
 */
export const CGROUP_MEM_MIN_FREE_RATIO = 0.1;
/** Host MemAvailable under this share refuses a new start (the gate stays at 5%: a start is earlier, not louder). */
export const START_MEM_AVAILABLE_MIN_RATIO = 0.1;
/** A 15-minute load at or past this many runnable tasks per CPU only warns on a start; load never refuses one. */
export const START_LOAD_WARN_PER_CPU = 1;

/** Free and total bytes of the filesystem holding `path`; `null` when it cannot be asked. */
export interface DiskView {
	path: string;
	freeBytes: number | null;
	totalBytes: number | null;
}

/** `statfsSync`'s fields this module reads (blocks of `bsize` bytes); throws when the path cannot be asked. */
export type StatfsReader = (path: string) => {
	bavail: number | bigint;
	blocks: number | bigint;
	bsize: number | bigint;
};

const realStatfs: StatfsReader = (path) => statfsSync(path);

/** Space an unprivileged writer can still use (`bavail`), and the filesystem's size. */
export function diskHeadroom(path: string, statfs: StatfsReader = realStatfs): DiskView {
	try {
		const stats = statfs(path);
		const bsize = Number(stats.bsize);
		return { path, freeBytes: Number(stats.bavail) * bsize, totalBytes: Number(stats.blocks) * bsize };
	} catch {
		return { path, freeBytes: null, totalBytes: null };
	}
}

/** Under 5 GiB or under 10% free; a filesystem that could not be asked is not low. */
export function diskLow(view: DiskView): boolean {
	if (view.freeBytes === null || view.totalBytes === null) return false;
	return (
		view.freeBytes < DISK_MIN_FREE_BYTES ||
		(view.totalBytes > 0 && view.freeBytes / view.totalBytes < DISK_MIN_FREE_RATIO)
	);
}

/** `free_gib=<n.n> pct=<n>`: how a disk view reads in a gate detail or a refusal. */
export function formatHeadroom(view: DiskView): string {
	const free = view.freeBytes ?? 0;
	const pct = view.totalBytes === null || view.totalBytes === 0 ? 0 : Math.floor((free / view.totalBytes) * 100);
	return `free_gib=${(free / 1024 ** 3).toFixed(1)} pct=${pct}`;
}

/** Where `hostPressure` reads the machine (each defaults to this machine's own). */
export interface HostLoadReader {
	/** `os.loadavg()`: the 1, 5 and 15-minute averages. */
	loadavg(): number[];
	cpuCount(): number;
	/** `/proc/meminfo` text; `undefined` when it cannot be read. */
	meminfo(): string | undefined;
	/** The visible cgroup memory hierarchy; `undefined` when this machine has none to read (test seam, non-Linux). */
	cgroup(): CgroupMemory | undefined;
}

/** An idle 4-CPU host with unreadable meminfo: `host_pressure` stays closed whatever this machine is doing. */
export const IDLE_HOST_LOAD: HostLoadReader = {
	loadavg: () => [0, 0, 0],
	cpuCount: () => 4,
	meminfo: () => undefined,
	cgroup: () => undefined,
};

/**
 * Test-only host readers for child processes, which cannot take {@link IDLE_HOST_LOAD} as an argument.
 * `JABBU_TEST_HOST_LOAD=idle` is read only when `JABBU_TEST_HOOKS=1` (like `JABBU_TEST_CRASH_AT`), so a stray
 * variable in production never hides real load. `undefined` = this machine's own readings.
 */
export function testHostLoad(env: Record<string, string | undefined> = process.env): HostLoadReader | undefined {
	const value = env.JABBU_TEST_HOOKS === "1" ? env.JABBU_TEST_HOST_LOAD : undefined;
	if (value === undefined) return undefined;
	if (value !== "idle") throw new Error(`JABBU_TEST_HOST_LOAD: unknown value ${value}`);
	return IDLE_HOST_LOAD;
}

export interface HostPressure {
	load15: number;
	cpus: number;
	/** MemAvailable / MemTotal; `null` when /proc/meminfo cannot be read or lacks either line. */
	memAvailableRatio: number | null;
	/** Free share of the tightest visible cgroup `memory.high` budget; `null` when none is visible. */
	cgroupHighFreeRatio: number | null;
	/** Free share of the tightest visible cgroup `memory.max` budget; `null` when none is visible. */
	cgroupHardFreeRatio: number | null;
	/** The hierarchy the cgroup budgets came from; `undefined` when nothing was read, `null` when none is visible. */
	cgroupVersion: 1 | 2 | null | undefined;
	/** The cgroup read could not see the whole hierarchy: detail only, never judged as pressure. */
	cgroupIncomplete: boolean;
	open: boolean;
}

const readMeminfo = (): string | undefined => {
	try {
		return readFileSync("/proc/meminfo", "utf8");
	} catch {
		return undefined;
	}
};

/** Only Linux has a cgroup hierarchy to read; elsewhere (and when the read itself fails) there is nothing to judge. */
const readCgroup = (): CgroupMemory | undefined => {
	if (process.platform !== "linux") return undefined;
	try {
		return sampleCgroupMemory();
	} catch {
		return undefined;
	}
};

const meminfoKb = (text: string, field: string): number | undefined => {
	const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text);
	return match === null ? undefined : Number(match[1]);
};

/**
 * Load at or past 2 per CPU, under 5% of memory available, or a visible cgroup budget (`memory.high`/`memory.max`)
 * under {@link CGROUP_MEM_MIN_FREE_RATIO}; unreadable inputs only drop their own condition.
 */
export function hostPressure(read: Partial<HostLoadReader> = {}): HostPressure {
	const load15 = (read.loadavg ?? loadavg)()[2] ?? 0;
	const cpuCount = Math.max(1, (read.cpuCount ?? (() => cpus().length))());
	const meminfo = (read.meminfo ?? readMeminfo)();
	const available = meminfo === undefined ? undefined : meminfoKb(meminfo, "MemAvailable");
	const total = meminfo === undefined ? undefined : meminfoKb(meminfo, "MemTotal");
	const memAvailableRatio = available === undefined || total === undefined || total === 0 ? null : available / total;
	const cgroup = (read.cgroup ?? readCgroup)();
	const cgroupHighFreeRatio = cgroup?.high === null || cgroup?.high === undefined ? null : cgroup.high.freePct / 100;
	const cgroupHardFreeRatio = cgroup?.hard === null || cgroup?.hard === undefined ? null : cgroup.hard.freePct / 100;
	const open =
		load15 >= LOAD_PER_CPU_MAX * cpuCount ||
		(memAvailableRatio !== null && memAvailableRatio < MEM_AVAILABLE_MIN_RATIO) ||
		(cgroupHighFreeRatio !== null && cgroupHighFreeRatio < CGROUP_MEM_MIN_FREE_RATIO) ||
		(cgroupHardFreeRatio !== null && cgroupHardFreeRatio < CGROUP_MEM_MIN_FREE_RATIO);
	return {
		load15,
		cpus: cpuCount,
		memAvailableRatio,
		cgroupHighFreeRatio,
		cgroupHardFreeRatio,
		cgroupVersion: cgroup === undefined ? undefined : cgroup.version,
		cgroupIncomplete: cgroup?.incomplete === true,
		open,
	};
}

/** `hostSessionCeiling` with its default applied, for a gate built from a possibly-unset config key. */
export function resolvedCeiling(ceiling: number | undefined): number {
	return ceiling ?? DEFAULT_HOST_SESSION_CEILING;
}
