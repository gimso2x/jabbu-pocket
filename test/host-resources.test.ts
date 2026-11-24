import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { CgroupMemory } from "../src/ops/cgroup-memory";
import { DISK_MIN_FREE_BYTES, diskHeadroom, diskLow, formatHeadroom, hostPressure } from "../src/ops/host-resources";
import { startCapacity } from "../src/ops/start-capacity";

const GIB = 1024 ** 3;
const view = (freeGib: number, totalGib: number) => ({
	path: "/d",
	freeBytes: freeGib * GIB,
	totalBytes: totalGib * GIB,
});
const budget = (pct: number) => ({
	path: "/cg/app.slice",
	limitBytes: 1000,
	currentBytes: 1000 - Math.round(10 * pct),
	reclaimableBytes: 0,
	chargedFreePct: pct,
	freePct: pct,
});

describe("diskHeadroom / diskLow", () => {
	test("statfs blocks times block size; an unaskable path is null and never low", () => {
		const real = diskHeadroom(tmpdir());
		expect(real.freeBytes).toBeGreaterThan(0);
		expect(real.totalBytes).toBeGreaterThanOrEqual(real.freeBytes ?? 0);
		expect(diskHeadroom("/d", () => ({ bavail: 3n, blocks: 10n, bsize: 4096n }))).toEqual({
			path: "/d",
			freeBytes: 3 * 4096,
			totalBytes: 10 * 4096,
		});
		const missing = diskHeadroom("/no/such/path/for/ompbot");
		expect(missing).toEqual({ path: "/no/such/path/for/ompbot", freeBytes: null, totalBytes: null });
		expect(diskLow(missing)).toBe(false);
	});

	test("low under 5 GiB or under 10%: the boundaries themselves are not low", () => {
		expect(diskLow({ path: "/d", freeBytes: DISK_MIN_FREE_BYTES - 1, totalBytes: 1000 * GIB })).toBe(true);
		expect(diskLow(view(5, 50))).toBe(false);
		expect(diskLow(view(9.9, 100))).toBe(true);
		expect(diskLow(view(10, 100))).toBe(false);
		expect(formatHeadroom(view(9.96, 100))).toBe("free_gib=10.0 pct=9");
	});
});

describe("hostPressure", () => {
	const noCgroup = (): undefined => undefined;
	test("reads the 15-minute load and MemAvailable / MemTotal; an unreadable meminfo only drops that condition", () => {
		const meminfo = "MemTotal:       2000 kB\nMemAvailable:     99 kB\n";
		expect(
			hostPressure({ loadavg: () => [9, 9, 1], cpuCount: () => 2, meminfo: () => meminfo, cgroup: noCgroup }),
		).toEqual({
			load15: 1,
			cpus: 2,
			memAvailableRatio: 99 / 2000,
			cgroupHighFreeRatio: null,
			cgroupHardFreeRatio: null,
			cgroupVersion: undefined,
			cgroupIncomplete: false,
			open: true,
		});
		expect(
			hostPressure({ loadavg: () => [9, 9, 3.99], cpuCount: () => 2, meminfo: () => undefined, cgroup: noCgroup }),
		).toEqual({
			load15: 3.99,
			cpus: 2,
			memAvailableRatio: null,
			cgroupHighFreeRatio: null,
			cgroupHardFreeRatio: null,
			cgroupVersion: undefined,
			cgroupIncomplete: false,
			open: false,
		});
		expect(
			hostPressure({
				loadavg: () => [0, 0, 4],
				cpuCount: () => 2,
				meminfo: () => "MemTotal: 10 kB\n",
				cgroup: noCgroup,
			}).open,
		).toBe(true);
		const here = hostPressure();
		expect(here.cpus).toBeGreaterThan(0);
		expect(here.memAvailableRatio).not.toBeNull();
	});

	test("a cgroup budget under 10% free opens the gate; incomplete and no-hierarchy reads never do", () => {
		const calm = {
			loadavg: () => [0, 0, 0],
			cpuCount: () => 4,
			meminfo: () => "MemTotal: 2000 kB\nMemAvailable: 1000 kB\n",
		};
		const v2 = (high: number | null, hard: number | null, incomplete = false) => ({
			...calm,
			cgroup: (): CgroupMemory => ({
				version: 2,
				hard: hard === null ? null : budget(hard),
				high: high === null ? null : budget(high),
				incomplete,
			}),
		});
		expect(hostPressure(v2(null, 9.9)).open).toBe(true);
		expect(hostPressure(v2(9.9, 60)).open).toBe(true);
		// Exactly at the floor is not under it; an incomplete read alone is not pressure.
		expect(hostPressure(v2(10, 10)).open).toBe(false);
		expect(hostPressure(v2(null, null, true)).open).toBe(false);
		expect(hostPressure(v2(null, null, true)).cgroupIncomplete).toBe(true);
	});
});

describe("startCapacity", () => {
	const meminfo = (availableKb: number) => `MemTotal:       1000 kB\nMemAvailable:   ${availableKb} kB\n`;
	test("memory floors refuse (host and each cgroup budget), load only warns, disks join the refusal", () => {
		const calm = {
			loadavg: () => [0, 0, 0],
			cpuCount: () => 4,
			meminfo: () => meminfo(500),
			cgroup: (): undefined => undefined,
		};
		expect(startCapacity(calm, [view(50, 100)])).toEqual({
			refusals: [],
			warning: undefined,
			memoryLow: false,
			sessionFull: false,
		});
		// Host MemAvailable under 10% refuses with the measured number.
		expect(startCapacity({ ...calm, meminfo: () => meminfo(40) }).refusals).toEqual([
			"호스트 메모리 여유 4% (기준 10%)",
		]);
		// The tightest visible cgroup budget refuses (hard and high are separate budgets).
		expect(
			startCapacity({
				...calm,
				cgroup: () => ({ version: 2, hard: budget(60), high: budget(6.25), incomplete: false }),
			}).refusals,
		).toEqual(["cgroup v2 high 여유 6.2% (기준 10%)"]);
		// A low disk view adds its own line to the same refusal.
		expect(startCapacity(calm, [view(4, 100)]).refusals).toEqual([
			"디스크 여유 부족 (/d free_gib=4.0 pct=4, 기준 5GiB·10%)",
		]);
		// Busy load never refuses: it warns.
		const busy = startCapacity({ ...calm, loadavg: () => [9, 9, 5] });
		expect(busy.refusals).toEqual([]);
		expect(busy.warning).toBe("주의: 호스트 부하 높음 (load15 5.0, 코어 4) — 시작은 계속합니다");
		// An unreadable meminfo and an absent cgroup drop their own conditions instead of refusing.
		expect(startCapacity({ loadavg: () => [0, 0, 0], cpuCount: () => 4 }).refusals).toEqual([]);
	});
});
