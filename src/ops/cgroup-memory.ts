// cgroup 메모리 예산: 이 프로세스가 속한 계층에서 실제로 걸린 한도(v2 memory.max·high,
// v1 memory.limit_in_bytes)와 여유를 읽는다. 조상에 걸린 한도도 보고(v1은 use_hierarchy가 0인 곳에서 멈춘다), 일부를
// 못 읽으면 판정을 접지 않고 incomplete로 알린다. 파일 해석은 cgroup-fs가 맡는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budget, type CgroupMemory, chain, membership, parseLimit, parseMounts, statField, widest } from "./cgroup-fs";

export type { CgroupMemory } from "./cgroup-fs";

type Reader = (path: string) => string;
const MAX_SAFE = 9007199254740991;
/** 수 텍스트. 수가 아니면 undefined. */
const safe = (text: string | undefined): number | undefined => {
	const value = text?.trim() ?? "";
	return /^\d+$/.test(value) ? Number(value) : undefined;
};

/** 이 프로세스의 cgroup 메모리 예산. `readFile` 기본값은 UTF-8 `readFileSync`. */
export function sampleCgroupMemory(readFile: Reader = (path) => readFileSync(path, "utf8")): CgroupMemory {
	const state = {
		version: null as 1 | 2 | null,
		hard: null as CgroupMemory["hard"],
		high: null as CgroupMemory["high"],
		incomplete: false,
	};
	/** 없는 파일(ENOENT)은 그 항목만 비고, 권한·입출력 실패는 계층을 못 본 것으로 남긴다. */
	const read = (path: string): string | undefined => {
		try {
			return readFile(path);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") state.incomplete = true;
			return undefined;
		}
	};
	const cgroup = read("/proc/self/cgroup");
	const mounts = read("/proc/self/mountinfo");
	if (cgroup === undefined || mounts === undefined) return state;
	const found = parseMounts(mounts);
	// v1 줄에 memory 컨트롤러 소속이 적혀 있는데 마운트가 안 보이면, 예산이 있다는 것만 알고 읽지는 못한 것이다
	// (v2의 `0::/…` 줄은 통합 계층 소속일 뿐 memory 컨트롤러를 증명하지 않는다).
	if (found.v2.length === 0 && found.v1.length === 0)
		return { ...state, incomplete: state.incomplete || membership(cgroup, 1) !== undefined };
	const version = found.v2.length > 0 ? 2 : 1;
	const mount = widest(version === 2 ? found.v2 : found.v1);
	const path = membership(cgroup, version);
	state.version = version;
	if (mount === undefined || path === undefined) {
		state.incomplete = true;
		return state;
	}
	for (const { dir, label } of chain(mount, path)) {
		const used = safe(read(join(dir, version === 2 ? "memory.current" : "memory.usage_in_bytes")));
		const stat = read(join(dir, "memory.stat"));
		if (used === undefined) state.incomplete = true;
		const cache =
			version === 2
				? (statField(stat, "file") ?? 0) - (statField(stat, "shmem") ?? 0)
				: (statField(stat, "total_cache") ?? 0);
		const limits = [
			[read(join(dir, version === 2 ? "memory.max" : "memory.limit_in_bytes")), true],
			[version === 2 ? read(join(dir, "memory.high")) : undefined, false],
		] as const;
		for (const [text, isHard] of limits) {
			// v1에는 memory.high가 없다: 읽지 않는 파일은 incomplete로 세지 않는다.
			if (text === undefined) {
				if (isHard || version === 2) state.incomplete = true;
				continue;
			}
			const limit = parseLimit(text, version === 2);
			if (limit === "unlimited") continue;
			if (limit === "unknown" || used === undefined || used > MAX_SAFE) {
				state.incomplete = true;
				continue;
			}
			const entry = budget(label, limit, used, cache);
			const prev = isHard ? state.hard : state.high;
			if (prev !== null && prev.freePct <= entry.freePct) continue;
			if (isHard) state.hard = entry;
			else state.high = entry;
		}
		// 계층 계산이 꺼진 v1 cgroup에서는 그 위 조상의 한도가 자손을 제약하지 않는다.
		if (version === 1 && read(join(dir, "memory.use_hierarchy"))?.trim() === "0") break;
	}
	return state;
}
