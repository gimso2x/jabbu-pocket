// cgroup 메모리 예산: 가짜 /proc과 cgroup 파일로 v1·v2·하이브리드, 조상 한도,
// 이스케이프 경로, 잘못된 한도 값, 읽기 실패를 확인한다. 호스트 실제 값은 여기서 보지 않는다.

import { describe, expect, test } from "bun:test";
import { sampleCgroupMemory } from "../src/ops/cgroup-memory";

const V2 = "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate";
const V1 = "25 23 0:22 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec - cgroup cgroup rw,memory";

const denied = (path: string): never => {
	throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
};

/** 가짜 파일 트리 리더. 목록에 없는 경로는 ENOENT, `deny`에 맞는 경로는 권한 오류다. */
const files = (tree: Record<string, string>, deny: string[] = []) => {
	const seen: string[] = [];
	const read = (path: string): string => {
		seen.push(path);
		if (deny.includes(path)) return denied(path);
		const text = tree[path];
		if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		return text;
	};
	return { read, seen };
};

/** 이 프로세스가 `path`에 속한 v2 세계. `at`의 인터페이스 파일만 둔다. */
const v2 = (path: string, at: Record<string, string>, deny: string[] = []) => {
	const tree: Record<string, string> = { "/proc/self/cgroup": `0::${path}`, "/proc/self/mountinfo": V2 };
	for (const [file, text] of Object.entries(at)) tree[`/sys/fs/cgroup${path === "/" ? "" : path}/${file}`] = text;
	return files(tree, deny);
};

describe("cgroup-memory", () => {
	test("a visible v2 hierarchy without non-root memory interfaces retains its version and marks incomplete", () => {
		const world = v2("/app.slice", {});
		expect(sampleCgroupMemory(world.read)).toEqual({ version: 2, hard: null, high: null, incomplete: true });
	});

	test("v1 uses the memory mount and ancestor usage, not the soft-limit hint", () => {
		const world = files({
			"/proc/self/cgroup": "12:memory:/app.slice",
			"/proc/self/mountinfo": V1,
			"/sys/fs/cgroup/memory/app.slice/memory.limit_in_bytes": "1000",
			"/sys/fs/cgroup/memory/app.slice/memory.usage_in_bytes": "800",
			"/sys/fs/cgroup/memory/app.slice/memory.soft_limit_in_bytes": "801",
			"/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000",
			"/sys/fs/cgroup/memory/memory.usage_in_bytes": "200",
		});
		const result = sampleCgroupMemory(world.read);
		expect(result.version).toBe(1);
		expect(result.hard?.path).toBe("/app.slice");
		expect(result.hard?.freePct).toBeCloseTo(20);
		expect(result.high).toBeNull();
	});

	test("non-hierarchical v1 ancestors do not constrain descendants", () => {
		const world = files({
			"/proc/self/cgroup": "12:memory:/app.slice",
			"/proc/self/mountinfo": V1,
			"/sys/fs/cgroup/memory/app.slice/memory.use_hierarchy": "0",
			"/sys/fs/cgroup/memory/app.slice/memory.limit_in_bytes": "1000",
			"/sys/fs/cgroup/memory/app.slice/memory.usage_in_bytes": "100",
			"/sys/fs/cgroup/memory/memory.limit_in_bytes": "1000",
			"/sys/fs/cgroup/memory/memory.usage_in_bytes": "950",
		});
		const result = sampleCgroupMemory(world.read);
		expect(result.hard?.path).toBe("/app.slice");
		expect(result.hard?.freePct).toBeCloseTo(90);
	});

	test("subtree mount roots and escaped paths are resolved without escaping the mount", () => {
		const world = files({
			"/proc/self/cgroup": "0::/app.slice/../../escape",
			"/proc/self/mountinfo": "30 23 0:26 /app.slice /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
			"/sys/fs/cgroup/escape/memory.max": "1000",
			"/sys/fs/cgroup/escape/memory.current": "250",
		});
		const result = sampleCgroupMemory(world.read);
		expect(result.hard?.path).toBe("/app.slice/escape");
		expect(result.hard?.freePct).toBeCloseTo(75);
		const cgroupReads = world.seen.filter((path) => path.startsWith("/sys/"));
		expect(cgroupReads.length).toBeGreaterThan(0);
		expect(cgroupReads.every((path) => path.startsWith("/sys/fs/cgroup/"))).toBe(true);
	});

	test("membership preserves the exact cgroup name", () => {
		for (const name of ["work.slice", "a b@c,d", "wörk.slice", "x:y"]) {
			const world = v2(`/user.slice/${name}`, { "memory.max": "1000", "memory.current": "100" });
			expect(sampleCgroupMemory(world.read).hard?.path).toBe(`/user.slice/${name}`);
		}
	});

	test("a wider visible mount wins over a subtree bind", () => {
		const world = files({
			"/proc/self/cgroup": "0::/app.slice",
			"/proc/self/mountinfo": `${V2}\n31 23 0:26 /app.slice /sys/fs/cgroup/bind rw - cgroup2 cgroup2 rw`,
			"/sys/fs/cgroup/app.slice/memory.max": "1000",
			"/sys/fs/cgroup/app.slice/memory.current": "900",
			"/sys/fs/cgroup/bind/memory.max": "1000",
			"/sys/fs/cgroup/bind/memory.current": "1",
		});
		expect(sampleCgroupMemory(world.read).hard?.path).toBe("/app.slice");
	});

	test("a namespace root stops at its visible mount root", () => {
		const world = files({
			"/proc/self/cgroup": "0::/nsroot",
			"/proc/self/mountinfo": "32 23 0:26 /nsroot /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
			"/sys/fs/cgroup/memory.max": "1000",
			"/sys/fs/cgroup/memory.current": "500",
		});
		const result = sampleCgroupMemory(world.read);
		expect(result.hard?.path).toBe("/nsroot");
		expect(world.seen.filter((path) => path.startsWith("/sys/fs/cgroup/"))).toEqual(
			expect.arrayContaining(["/sys/fs/cgroup/memory.max"]),
		);
	});

	test.each(["-1", "1garbage", "", "NaN", "9007199254740992"])(
		"malformed hard limit %s is unknown, not unlimited",
		(limit) => {
			const world = v2("/app.slice", { "memory.max": limit, "memory.current": "500" });
			const result = sampleCgroupMemory(world.read);
			expect(result.hard).toBeNull();
			expect(result.incomplete).toBe(true);
		},
	);

	test("unreadable current usage leaves valid ancestor evidence intact", () => {
		const world = v2("/app.slice", { "memory.max": "1000", "memory.current": "900" }, [
			"/sys/fs/cgroup/app.slice/memory.current",
		]);
		const withParent = files({
			...Object.fromEntries(world.seen.map((path) => [path, "1"])),
			"/proc/self/cgroup": "0::/app.slice",
			"/proc/self/mountinfo": V2,
			"/sys/fs/cgroup/app.slice/memory.max": "1000",
			"/sys/fs/cgroup/memory.max": "1000",
			"/sys/fs/cgroup/memory.current": "200",
		});
		const result = sampleCgroupMemory(withParent.read);
		expect(result.incomplete).toBe(true);
		expect(result.hard?.path).toBe("/");
		expect(result.hard?.freePct).toBeCloseTo(80);
	});

	test("v1 uses matching memory hierarchy cache counters", () => {
		const world = files({
			"/proc/self/cgroup": "12:memory:/app.slice",
			"/proc/self/mountinfo": V1,
			"/sys/fs/cgroup/memory/app.slice/memory.limit_in_bytes": "1000",
			"/sys/fs/cgroup/memory/app.slice/memory.usage_in_bytes": "900",
			"/sys/fs/cgroup/memory/app.slice/memory.stat": "cache 10\ntotal_cache 100\nrss 800\n",
		});
		const result = sampleCgroupMemory(world.read);
		expect(result.hard?.reclaimableBytes).toBe(100);
		expect(result.hard?.chargedFreePct).toBeCloseTo(10);
		expect(result.hard?.freePct).toBeCloseTo(20);
	});

	test.each([
		["file 100\nshmem 200", 0],
		["file 9999\nshmem 0", 900],
	])("cache estimate is clamped within charged usage: %s", (stat, clamp) => {
		const world = v2("/app.slice", {
			"memory.max": "1000",
			"memory.current": "900",
			"memory.stat": `${stat}\n`,
		});
		expect(sampleCgroupMemory(world.read).hard?.reclaimableBytes).toBe(clamp);
	});

	test("permission failures at the mount root remain incomplete", () => {
		const world = v2("/", { "memory.max": "1000", "memory.current": "100" }, ["/sys/fs/cgroup/memory.max"]);
		const result = sampleCgroupMemory(world.read);
		expect(result.version).toBe(2);
		expect(result.hard).toBeNull();
		expect(result.incomplete).toBe(true);
	});

	test("missing controllers, missing mounts and invalid membership are distinguishable", () => {
		// 컨트롤러도 cgroup 마운트도 없음: 판정할 것이 없다.
		const nothing = files({
			"/proc/self/cgroup": "0::/init",
			"/proc/self/mountinfo": "22 1 8:1 / / rw - ext4 /dev/sda1 rw",
		});
		expect(sampleCgroupMemory(nothing.read)).toEqual({ version: null, hard: null, high: null, incomplete: false });
		// memory에 속했다는데 마운트가 안 보임: 읽지 못했다고 알린다.
		const unmounted = files({
			"/proc/self/cgroup": "12:memory:/app.slice",
			"/proc/self/mountinfo": "22 1 8:1 / / rw - ext4 rw",
		});
		expect(sampleCgroupMemory(unmounted.read)).toEqual({ version: null, hard: null, high: null, incomplete: true });
		// 버전은 보이는데 소속 경로가 절대 경로가 아님: 잘못된 줄로 본다.
		const invalid = files({ "/proc/self/cgroup": "12:memory:app.slice", "/proc/self/mountinfo": V1 });
		expect(sampleCgroupMemory(invalid.read)).toEqual({ version: 1, hard: null, high: null, incomplete: true });
	});
});
