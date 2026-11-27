// T-20261121-06: a start-time host-capacity gate over `startCapacity` — memory
// (host MemAvailable and the visible cgroup budgets) and disk refuse a new lane, reservation or [TASK] with the
// measured reason, the owner's explicit `force` passes, and a busy load only warns.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import type { ProcessRunner } from "../src/dispatch/omp";
import { LaneInputError } from "../src/lanes/manager-constants";
import { buildWorkStartTool } from "../src/lanes/tools";
import type { CgroupMemory } from "../src/ops/cgroup-memory";
import type { HostLoadReader, StatfsReader } from "../src/ops/host-resources";
import type { ProcCmdlineReader, SessionCeilingGate } from "../src/ops/host-sessions";
import { startTask, type TaskDispatchDeps } from "../src/tasks/dispatch";
import type { TaskHostOps, TaskResumeOps } from "../src/tasks/host";
import { TaskLedger } from "../src/tasks/ledger";
import type { WorkerTier } from "../src/tasks/worker-tier";
import { CHANNEL, makeHome, OWNER, type TestHome } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const GIB = 1024 ** 3;
/** 2026-10-26 15:00 KST: the task id of this harness's first [TASK] reads `T-20261026-01`. */
const NOW = Date.parse("2026-10-26T06:00:00Z");

/** A cgroup budget `pct`% free on a `v2` hierarchy (only `freePct` feeds the gate). */
const budget = (pct: number) => ({
	path: "/cg/app.slice",
	limitBytes: 1000,
	currentBytes: 1000 - Math.round(10 * pct),
	reclaimableBytes: 0,
	chargedFreePct: pct,
	freePct: pct,
});

/** The readers of one host whose cgroup `memory.high` budget is 5% free only while `tight.value` is true. */
const tighteningHost = (tight: { value: boolean }): Partial<HostLoadReader> => ({
	loadavg: () => [0, 0, 0],
	cpuCount: () => 4,
	meminfo: () => "MemTotal:       1000 kB\nMemAvailable:   500 kB\n",
	cgroup: (): CgroupMemory | undefined =>
		tight.value ? { version: 2, hard: budget(60), high: budget(5), incomplete: false } : undefined,
});

/** A fake /proc with exactly one running omp RPC session (T-20261122-07's ceiling gate input). */
const oneSession: ProcCmdlineReader = () => [["omp", "--mode", "rpc", "--no-title"]];

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-hostcap-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Lane worktree directories beside `repo` (none when nothing was created). */
const siblingWorktrees = (repo: string): string[] =>
	readdirSync(dirname(repo)).filter((entry) => entry.startsWith(`${basename(repo)}-l-`));

describe("lane start capacity", () => {
	test("a tight cgroup budget refuses with the measured reason before anything is created", async () => {
		const repo = makeRepo(repos);
		const tight = { value: true };
		const h = laneHarness(home.dir, { hostLoad: tighteningHost(tight) });
		const refused = await h.manager
			.start({ title: "mem lane", cwd: repo, channel: CHANNEL })
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toBe("시작 거부: cgroup v2 high 여유 5.0% (기준 10%)");
		expect(h.store.listLanes()).toHaveLength(0);
		expect(h.transport.posts()).toEqual([]);
		expect(siblingWorktrees(repo)).toEqual([]);
		expect(h.logs.some((line) => line.includes("lane_start_refused_capacity"))).toBe(true);
		h.close();
	});

	test("a low disk on the lane's repository refuses the same way", async () => {
		const repo = makeRepo(repos);
		const statfs: StatfsReader = () => ({ bavail: 4n, blocks: 100n, bsize: 1073741824n });
		const h = laneHarness(home.dir, { statfs });
		const refused = await h.manager
			.start({ title: "disk lane", cwd: repo, channel: CHANNEL })
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toBe(
			`시작 거부: 디스크 여유 부족 (${repo} free_gib=4.0 pct=4, 기준 5GiB·10%)`,
		);
		expect(h.store.listLanes()).toHaveLength(0);
		expect(siblingWorktrees(repo)).toEqual([]);
		h.close();
	});

	test("the owner's explicit force passes the refusal", async () => {
		const repo = makeRepo(repos);
		const tight = { value: true };
		const h = laneHarness(home.dir, { hostLoad: tighteningHost(tight) });
		const lane = await h.manager.start({ title: "forced lane", cwd: repo, channel: CHANNEL, force: true });
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(h.logs.some((line) => line.includes("lane_start_forced"))).toBe(true);
		h.close();
	});

	test("a busy load never refuses: the start note only warns", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir, {
			hostLoad: {
				loadavg: () => [9, 9, 5],
				cpuCount: () => 4,
				meminfo: () => "MemTotal:       1000 kB\nMemAvailable:   500 kB\n",
				cgroup: () => undefined,
			},
		});
		const lane = await h.manager.start({ title: "busy lane", cwd: repo, channel: CHANNEL });
		await h.settle();
		expect(lane.startNote).toBe("주의: 호스트 부하 높음 (load15 5.0, 코어 4) — 시작은 계속합니다");
		h.close();
	});

	test("the work-start tool adds the force hint to the refusal and starts on force", async () => {
		const repo = makeRepo(repos);
		const tight = { value: true };
		const h = laneHarness(home.dir, { hostLoad: tighteningHost(tight) });
		const tool = buildWorkStartTool(h.manager, CHANNEL, `discord/ch/${CHANNEL}`);
		const signal = new AbortController().signal;
		const refused = await tool.execute({ title: "via tool", cwd: repo }, { signal }).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toBe(
			"시작 거부: cgroup v2 high 여유 5.0% (기준 10%) — 오너가 강행한다고 명시하면 force: true로 다시 시작하세요",
		);
		const reply = await tool.execute({ title: "via tool", cwd: repo, force: true }, { signal });
		expect(reply).toContain("lane via-tool started");
		await h.settle();
		h.close();
	});
});

describe("reservation start held by capacity", () => {
	let h: LaneHarness;
	let repo: string;
	const tight = { value: true };

	beforeEach(() => {
		repo = makeRepo(repos);
		h = laneHarness(home.dir, { hostLoad: tighteningHost(tight) });
		tight.value = true;
	});

	afterEach(() => h.close());

	/** Puts the lane through claim and landing in the registry (what a landing leaves in `meta.land`). */
	const land = (name: string): void => {
		h.store.transitionLane(name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
	};

	test("a held ▶ stays ready with the reason and starts once the host has room", async () => {
		tight.value = false;
		const first = await h.manager.start({ title: "first", cwd: repo, channel: CHANNEL });
		await h.settle();
		// Reserving is never capacity-checked: nothing starts yet.
		tight.value = true;
		const reservation = await h.manager.reserve({
			args: { title: "next step", cwd: repo, channel: CHANNEL },
			after: ["first"],
			originKey: "discord/dm/1",
			threadRef: first.threadRef,
		});
		land("first");
		await h.manager.tick();
		await h.settle();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");

		// ▶ while tight: refused with the reason, the reservation stays ready.
		const held = await h.manager.startReservation(reservation.id);
		expect(held.handled).toBeFalse();
		expect(held.text).toContain("시작하지 못했습니다");
		expect(held.text).toContain("시작 거부: cgroup v2 high 여유 5.0% (기준 10%)");
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("ready");
		expect(h.store.listLanes().map((lane) => lane.name)).toEqual(["first"]);

		// The same ▶ once the host has room starts the lane.
		tight.value = false;
		const outcome = await h.manager.startReservation(reservation.id);
		await h.settle();
		expect(outcome.handled).toBeTrue();
		expect(h.store.getLaneReservation(reservation.id)?.state).toBe("started");
	});
});

describe("[TASK] dispatch capacity", () => {
	const SPEC = {
		title: "로그 회전",
		risk: "L2" as const,
		goal: "로그 회전을 넣는다",
		scope: ["src/log.ts"],
		exclusions: ["배포"],
		acceptance: ["회전 테스트가 통과한다"],
		repo: "/r/repo",
	};
	const WORKER: WorkerTier = { tier: "low", tierReason: "시작", model: null };

	/** `startTask` deps over an in-memory ledger, a fake host, a fake herdr runner and the given host readers. */
	function taskHarness(
		hostLoad: Partial<HostLoadReader>,
		hostSessions?: SessionCeilingGate,
	): {
		deps: TaskDispatchDeps;
		ledger: TaskLedger;
		opsCalls: string[];
		herdr: string[][];
	} {
		const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
			timezone: "Asia/Seoul",
			clock: { now: () => NOW },
		});
		const transport = new FakeDiscordTransport();
		const logs: string[] = [];
		const opsCalls: string[] = [];
		const herdr: string[][] = [];
		const agents = new Set<string>();
		const ops: TaskHostOps & TaskResumeOps = {
			pathExists: async (path) => {
				opsCalls.push(`exists ${path}`);
				return { ok: true, value: false };
			},
			createWorktree: async (input) => {
				opsCalls.push(`worktree ${input.branch}`);
				return { ok: true, value: null };
			},
			removeWorktree: async (input) => {
				opsCalls.push(`remove ${input.branch}`);
			},
			writeFile: async (path) => {
				opsCalls.push(`write ${path}`);
				return { ok: true, value: null };
			},
			readFile: async () => ({ ok: true, value: undefined }),
			readBytes: async () => ({ ok: true, value: undefined }),
			readPlan: async () => ({ ok: true, value: undefined }),
			removeRecords: async () => {},
			commitOnTaskBranch: async () => {
				throw new Error("not used by a start");
			},
			branchDiff: async () => ({ ok: true, value: "" }),
			progressLag: async () => {
				throw new Error("not used by a start");
			},
			commitDocs: async (input) => {
				opsCalls.push(`commit ${input.taskId}`);
				return { ok: true, value: "abc1234" };
			},
			runCheck: async () => {
				throw new Error("not used by a start");
			},
			// A start stores the new worktree's HEAD as the row's base.
			headOf: async () => ({ sha: "e".repeat(40), clean: true }),
		};
		const run: ProcessRunner = async (cmd) => {
			herdr.push(cmd);
			const ok = (stdout = "{}") => ({ code: 0, stdout, timedOut: false });
			if (cmd[1] === "agent" && cmd[2] === "list")
				return ok(JSON.stringify({ result: { agents: [...agents].map((name) => ({ name })) } }));
			if (cmd[1] === "workspace" && cmd[2] === "list") return ok(JSON.stringify({ result: { workspaces: [] } }));
			if ((cmd[1] === "workspace" || cmd[1] === "tab") && cmd[2] === "create")
				return ok(
					JSON.stringify({
						result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
					}),
				);
			if (cmd[1] === "agent" && cmd[2] === "start") agents.add(cmd[3] as string);
			return ok();
		};
		const deps: TaskDispatchDeps = {
			ledger,
			originKey: "discord/ch/111111111111111111/t/222222222222222222",
			threadRef: () => "111111111111111111:222222222222222222",
			rootText: () => "[TASK] L2 로그 회전\n목표: 회전",
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			now: () => NOW,
			timezone: "Asia/Seoul",
			workspaceDir: "/ws",
			secretsDir: "/secrets",
			hostOps: () => ops,
			diskHeadroom: (path) => ({ path, freeBytes: 80 * GIB, totalBytes: 100 * GIB }),
			hostLoad,
			...(hostSessions === undefined ? {} : { hostSessions }),
			run,
			// The harness models an owner-confirmed force: the force test's start passes its card.
			confirmForce: async () => true,
			recordPrompt: () => undefined,
			log: {
				info: (event, fields) => logs.push(JSON.stringify({ event, fields })),
				warn: (event, fields) => logs.push(JSON.stringify({ event, fields })),
			},
		};
		return { deps, ledger, opsCalls, herdr };
	}

	test("a tight host refuses before anything is registered, created or started", async () => {
		const { deps, ledger, opsCalls, herdr } = taskHarness(tighteningHost({ value: true }));
		const out = await startTask(deps, { spec: SPEC, task: "회전을 구현해", host: null, worker: WORKER });
		expect(out).toBe("시작 거부: cgroup v2 high 여유 5.0% (기준 10%)");
		expect(ledger.list()).toEqual([]);
		expect([opsCalls, herdr]).toEqual([[], []]);
	});

	test("the owner's explicit force registers and starts the task", async () => {
		const { deps, ledger } = taskHarness(tighteningHost({ value: true }));
		const out = await startTask(deps, {
			spec: SPEC,
			task: "회전을 구현해",
			host: null,
			worker: WORKER,
			force: true,
		});
		expect(out).toContain("T-20261026-01 등록·시작했습니다");
		expect(ledger.require("T-20261026-01").status).toBe("working");
	});

	test("a host omp session at its ceiling refuses before anything is registered", async () => {
		const { deps, ledger, opsCalls, herdr } = taskHarness(tighteningHost({ value: false }), {
			ceiling: 1,
			list: oneSession,
		});
		const out = await startTask(deps, { spec: SPEC, task: "회전을 구현해", host: null, worker: WORKER });
		expect(out).toBe("시작 거부: 호스트 omp 세션 1개 (상한 1)");
		expect(ledger.list()).toEqual([]);
		expect([opsCalls, herdr]).toEqual([[], []]);
	});
});

describe("host-wide omp session ceiling", () => {
	// T-20261122-07: the /proc session count the ceiling gate judges reaches the
	// lane and [TASK] starts as the same refusal line, and the owner's `force` passes it like the other floors.

	test("a lane start refuses with the session reason and force passes", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir, { hostSessions: { ceiling: 1, list: oneSession } });
		const refused = await h.manager
			.start({ title: "session lane", cwd: repo, channel: CHANNEL })
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(LaneInputError);
		expect(String((refused as Error).message)).toBe("시작 거부: 호스트 omp 세션 1개 (상한 1)");
		expect(h.store.listLanes()).toHaveLength(0);
		expect(siblingWorktrees(repo)).toEqual([]);
		expect(h.logs.some((line) => line.includes("lane_start_refused_capacity"))).toBe(true);

		const lane = await h.manager.start({ title: "forced session lane", cwd: repo, channel: CHANNEL, force: true });
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		h.close();
	});
});
