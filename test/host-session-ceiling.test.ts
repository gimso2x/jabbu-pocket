// T-20261122-07: the host-wide omp RPC session ceiling — the /proc argv count
// takes direct and bun-spawned omp sessions (`--mode rpc`·`rpc-ui`) only, a start refuses at or above the ceiling,
// 0 turns the gate off, and an unreadable process table warns instead of refusing.

import { describe, expect, test } from "bun:test";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { DEFAULT_HOST_SESSION_CEILING, ompRpcSessions, type ProcCmdlineReader } from "../src/ops/host-sessions";
import { startCapacity } from "../src/ops/start-capacity";

/** A fake /proc: two real omp RPC sessions (one direct, one bun-spawned) and five that must not count. */
const HOST: readonly (readonly string[])[] = [
	["omp", "--mode", "rpc", "--no-title"], // direct omp RPC session
	["bun", "/home/me/.bun/bin/omp", "--mode", "rpc-ui", "--no-title"], // bun-spawned rpc-ui session
	["omp", "-p", "요약해 줘"], // a simple omp run, no rpc mode
	["agy", "--mode", "rpc"], // another program with the same flag
	["bun", "src/daemon/run.ts"], // the bot's own daemon
	["sh", "-c", "omp --mode rpc"], // a shell whose one argv word is the whole command text
	["systemd", "--user"], // unrelated
];
const hostList: ProcCmdlineReader = () => HOST;

describe("ompRpcSessions", () => {
	test("counts direct and bun-spawned omp rpc·rpc-ui sessions and nothing else", () => {
		expect(ompRpcSessions(hostList)).toBe(2);
	});

	test("a process table that cannot be listed reads as unknown", () => {
		expect(ompRpcSessions(() => undefined)).toBeUndefined();
	});
});

describe("startCapacity session ceiling", () => {
	test("a session count at the ceiling refuses with the measured reason", () => {
		const capacity = startCapacity(IDLE_HOST_LOAD, [], { ceiling: 2, list: hostList });
		expect([...capacity.refusals]).toEqual(["호스트 omp 세션 2개 (상한 2)"]);
		expect(capacity.warning).toBeUndefined();
	});

	test("a count under the ceiling passes", () => {
		const capacity = startCapacity(IDLE_HOST_LOAD, [], { ceiling: 3, list: hostList });
		expect([...capacity.refusals]).toEqual([]);
		expect(capacity.warning).toBeUndefined();
	});

	test("a ceiling of 0 turns the gate off", () => {
		const capacity = startCapacity(IDLE_HOST_LOAD, [], { ceiling: 0, list: hostList });
		expect([...capacity.refusals]).toEqual([]);
		expect(capacity.warning).toBeUndefined();
	});

	test("an unreadable process table refuses nothing and only warns", () => {
		const capacity = startCapacity(IDLE_HOST_LOAD, [], { ceiling: 2, list: () => undefined });
		expect([...capacity.refusals]).toEqual([]);
		expect(capacity.warning).toBe("주의: 호스트 omp 세션 수를 읽지 못했습니다 — 세션 상한 검사를 건너뜁니다");
	});

	test("the skipped session check joins the busy-load warning lines", () => {
		const capacity = startCapacity(
			{
				loadavg: () => [9, 9, 5],
				cpuCount: () => 4,
				meminfo: () => "MemTotal:       1000 kB\nMemAvailable:   500 kB\n",
				cgroup: () => undefined,
			},
			undefined,
			{ ceiling: 2, list: () => undefined },
		);
		expect([...capacity.refusals]).toEqual([]);
		expect(capacity.warning).toBe(
			"주의: 호스트 부하 높음 (load15 5.0, 코어 4) — 시작은 계속합니다\n" +
				"주의: 호스트 omp 세션 수를 읽지 못했습니다 — 세션 상한 검사를 건너뜁니다",
		);
	});

	test("the ceiling is off by default at 8", () => {
		expect(DEFAULT_HOST_SESSION_CEILING).toBe(8);
	});
});
