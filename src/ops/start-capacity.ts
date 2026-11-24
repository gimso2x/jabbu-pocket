// The start-time floor for a new lane, reservation or [TASK]: memory, disk and the host-wide omp session ceiling refuse with the measured
// numbers, a busy load only warns, an unreadable input drops its own condition.

import {
	CGROUP_MEM_MIN_FREE_RATIO,
	type DiskView,
	diskLow,
	formatHeadroom,
	type HostLoadReader,
	hostPressure,
	START_LOAD_WARN_PER_CPU,
	START_MEM_AVAILABLE_MIN_RATIO,
} from "./host-resources";
import { ompRpcSessions, type SessionCeilingGate } from "./host-sessions";

/** Why a new lane, reservation or [TASK] must not start on this host right now; load only warns. */
export interface StartCapacity {
	/** Refusal lines (memory·disk·session floors); an empty list means the start may go. */
	refusals: readonly string[];
	/** The busy-load or skipped-check warning lines; `undefined` when there is none. Warnings never refuse a start. */
	warning: string | undefined;
	/**
	 * Host or cgroup memory is under its start floor (the two memory refusals); `undefined` when no memory reading was
	 * available. Idle omp children can be stopped to free it.
	 */
	memoryLow: boolean | undefined;
	/**
	 * The host-wide omp session count is at the ceiling; `false` while the gate is off, `undefined` when the count
	 * could not be read. Idle omp children can be stopped to free a slot.
	 */
	sessionFull: boolean | undefined;
}

/**
 * The start-time floor under {@link hostPressure}'s gate: memory (host and cgroup budgets), the given disks and the
 * host-wide omp session ceiling refuse a new start, a busy load only warns. An unreadable input drops its own
 * condition instead of refusing (the session read says so in {@link StartCapacity.warning}).
 */
export function startCapacity(
	read: Partial<HostLoadReader> = {},
	disks: readonly DiskView[] = [],
	sessions?: SessionCeilingGate,
): StartCapacity {
	const pressure = hostPressure(read);
	const refusals: string[] = [];
	let memoryLow: boolean | undefined;
	let sessionFull: boolean | undefined = false;
	const pct = (ratio: number): string => `${Math.floor(ratio * 100)}%`;
	const memoryRatios = [pressure.memAvailableRatio, pressure.cgroupHardFreeRatio, pressure.cgroupHighFreeRatio];
	if (memoryRatios.some((ratio) => ratio !== null)) memoryLow = false;
	if (pressure.memAvailableRatio !== null && pressure.memAvailableRatio < START_MEM_AVAILABLE_MIN_RATIO) {
		memoryLow = true;
		refusals.push(`호스트 메모리 여유 ${pct(pressure.memAvailableRatio)} (기준 ${pct(START_MEM_AVAILABLE_MIN_RATIO)})`);
	}
	for (const kind of ["hard", "high"] as const) {
		const ratio = kind === "hard" ? pressure.cgroupHardFreeRatio : pressure.cgroupHighFreeRatio;
		if (ratio !== null && ratio < CGROUP_MEM_MIN_FREE_RATIO) {
			memoryLow = true;
			refusals.push(
				`cgroup v${pressure.cgroupVersion} ${kind} 여유 ${(Math.floor(ratio * 1000) / 10).toFixed(1)}% (기준 ${pct(CGROUP_MEM_MIN_FREE_RATIO)})`,
			);
		}
	}
	for (const disk of disks)
		if (diskLow(disk)) refusals.push(`디스크 여유 부족 (${disk.path} ${formatHeadroom(disk)}, 기준 5GiB·10%)`);
	const warnings: string[] = [];
	if (pressure.load15 >= START_LOAD_WARN_PER_CPU * pressure.cpus)
		warnings.push(
			`주의: 호스트 부하 높음 (load15 ${pressure.load15.toFixed(1)}, 코어 ${pressure.cpus}) — 시작은 계속합니다`,
		);
	if (sessions !== undefined && sessions.ceiling > 0) {
		const count = ompRpcSessions(sessions.list);
		if (count === undefined) {
			sessionFull = undefined;
			warnings.push("주의: 호스트 omp 세션 수를 읽지 못했습니다 — 세션 상한 검사를 건너뜁니다");
		} else if (count >= sessions.ceiling) {
			sessionFull = true;
			refusals.push(`호스트 omp 세션 ${count}개 (상한 ${sessions.ceiling})`);
		}
	}
	if (sessionFull === true || memoryLow === true) sessions?.onPressure?.();
	return { refusals, warning: warnings.length === 0 ? undefined : warnings.join("\n"), memoryLow, sessionFull };
}
