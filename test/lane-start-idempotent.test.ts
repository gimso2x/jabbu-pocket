import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { LaneInputError } from "../src/lanes/manager-constants";
import { buildWorkStartTool } from "../src/lanes/tools";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// Lane start retries are idempotent and a launch-failed lane's thread is archived.

const signal = new AbortController().signal;
const PARENT = "discord/dm/1";

let home: TestHome;
let repos: string[];
let h: LaneHarness;
let repo: string;

beforeEach(() => {
	home = makeHome("jabbu-lane-idempotent-home-");
	repos = [];
	repo = makeRepo(repos);
});

afterEach(() => {
	h?.close();
	home.remove();
	for (const dir of repos) removeRepoAndWorktrees(dir);
});

const roots = (title: string) =>
	h.transport.calls.filter((call) => call.method === "createMessage" && call.content === `🔄 ${title}`);
const archives = () => h.transport.calls.filter((call) => call.method === "archiveThread");

/** A harness whose lane omp has no commands loaded: a `ulw-plan` start is refused at launch. */
function refusingHarness(extra: Parameters<typeof laneHarness>[1] = {}): LaneHarness {
	const sessions = new FakeSessionStore();
	return laneHarness(home.dir, {
		...extra,
		driver: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, commands: [] }),
	});
}

const launchRefusedStart = (title: string) =>
	h.manager.start({
		title,
		cwd: repo,
		channel: CHANNEL,
		parentOrigin: PARENT,
		workflow: { name: "ulw-plan", reason: "plan" },
	});

describe("a repeated start of the same request", () => {
	beforeEach(() => {
		h = laneHarness(home.dir);
	});

	test("reuseOpen returns the open lane: one row, one worktree, one root", async () => {
		const first = await h.manager.start({
			title: "same",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: PARENT,
			reuseOpen: true,
		});
		const second = await h.manager.start({
			title: "same",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: PARENT,
			reuseOpen: true,
		});
		await h.settle();
		expect(first.reused).toBeUndefined();
		expect(second.reused).toBe(true);
		expect(second.name).toBe(first.name);
		expect(second.startNote).toContain(first.name);
		expect(h.store.listLanes()).toHaveLength(1);
		expect(existsSync(first.meta.worktree ?? "")).toBe(true);
		expect(roots("same")).toHaveLength(1);
		expect(first.meta.requestedCwd).toBe(repo);
	});

	test("a closed (launch-failed) lane of the same key does not block a new start", async () => {
		h.close();
		h = refusingHarness();
		const failed = await launchRefusedStart("retry");
		await h.settle();
		expect(h.store.getLane(failed.name)?.status).toBe("closed");
		const again = await h.manager.start({
			title: "retry",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: PARENT,
			reuseOpen: true,
		});
		await h.settle();
		expect(again.reused).toBeUndefined();
		expect(again.name).not.toBe(failed.name);
		expect(h.store.listLanes()).toHaveLength(2);
	});

	test("another title or cwd under the same parentOrigin opens its own lane", async () => {
		const other = makeRepo(repos);
		const base = { channel: CHANNEL, parentOrigin: PARENT, reuseOpen: true };
		const a = await h.manager.start({ ...base, title: "alpha", cwd: repo });
		const b = await h.manager.start({ ...base, title: "beta", cwd: repo });
		const c = await h.manager.start({ ...base, title: "alpha", cwd: other });
		await h.settle();
		expect(new Set([a.name, b.name, c.name]).size).toBe(3);
		expect([a, b, c].some((lane) => lane.reused === true)).toBe(false);
	});

	test("two concurrent starts of one key: one is refused, one lane exists", async () => {
		const input = { title: "race", cwd: repo, channel: CHANNEL, parentOrigin: PARENT };
		const results = await Promise.allSettled([h.manager.start(input), h.manager.start(input)]);
		await h.settle();
		const refused = results.filter((r) => r.status === "rejected");
		expect(refused).toHaveLength(1);
		const reason = (refused[0] as PromiseRejectedResult).reason;
		expect(reason).toBeInstanceOf(LaneInputError);
		expect((reason as Error).message).toContain("시작하는 중");
		expect(h.store.listLanes()).toHaveLength(1);
	});

	test("a start that ends in a refusal leaves no key behind", async () => {
		h.close();
		h = laneHarness(home.dir, { maxLanes: 1 });
		await h.manager.start({ title: "occupant", cwd: repo, channel: CHANNEL, parentOrigin: PARENT });
		const input = { title: "capped", cwd: repo, channel: CHANNEL, parentOrigin: PARENT };
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const error = await h.manager.start(input).then(
				() => undefined,
				(e: unknown) => e as Error,
			);
			expect(error).toBeDefined();
			expect(error?.message).not.toContain("시작하는 중");
		}
		await h.settle();
		expect(h.store.listLanes()).toHaveLength(1);
	});

	test("a reservation start opens a new lane even if the same key is open", async () => {
		const prereq = await h.manager.start({ title: "prereq", cwd: repo, channel: CHANNEL, parentOrigin: PARENT });
		const twin = await h.manager.start({ title: "next step", cwd: repo, channel: CHANNEL, parentOrigin: PARENT });
		await h.settle();
		const reservation = await h.manager.reserve({
			args: { title: "next step", cwd: repo, channel: CHANNEL },
			after: [prereq.name],
			originKey: PARENT,
			threadRef: prereq.threadRef,
		});
		h.store.transitionLane(prereq.name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(prereq.name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		await h.manager.tick();
		await h.settle();
		const outcome = await h.manager.startReservation(reservation.id);
		await h.settle();
		expect(outcome.handled).toBe(true);
		const started = h.store.getLaneReservation(reservation.id);
		expect(started?.laneName).toBeTruthy();
		expect(started?.laneName).not.toBe(twin.name);
		expect(h.store.listLanes()).toHaveLength(3);
	});
});

describe("work_start tool reply", () => {
	test("a reused lane answers already open, not started", async () => {
		h = laneHarness(home.dir);
		const tool = buildWorkStartTool(h.manager, CHANNEL, PARENT);
		const first = String(await tool.execute({ title: "tooled", cwd: repo }, { signal }));
		const second = String(await tool.execute({ title: "tooled", cwd: repo }, { signal }));
		await h.settle();
		expect(first).toContain("started");
		expect(second).toContain("already open");
		expect(second).not.toContain("started");
		expect(h.store.listLanes()).toHaveLength(1);
	});
});

describe("thread archive of a failed start", () => {
	test("failLaunch archives the lane thread once, by the thread id", async () => {
		h = refusingHarness();
		const lane = await launchRefusedStart("archived");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		const rootId = lane.threadRef.split(":")[1];
		expect(archives()).toEqual([expect.objectContaining({ method: "archiveThread", threadId: rootId })]);
	});

	test("an archive that throws leaves the lane closed", async () => {
		h = refusingHarness();
		h.transport.failNext.archiveThread = [new Error("archive down")];
		const lane = await launchRefusedStart("archive-throws");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(archives()).toHaveLength(1);
		expect(h.logs.some((line) => line.includes("lane_thread_archive_failed"))).toBe(true);
	});

	test("a failed sync edit keeps the thread unarchived", async () => {
		h = refusingHarness();
		h.transport.failNext.editMessage = [new Error("edit down")];
		const lane = await launchRefusedStart("edit-fails");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(archives()).toHaveLength(0);
	});

	test("start failing after openThread archives the thread once", async () => {
		h = laneHarness(home.dir);
		const original = h.transport.createMessage.bind(h.transport);
		let posts = 0;
		h.transport.createMessage = async (args) => {
			posts += 1;
			if (posts === 2) throw new Error("status post down");
			return original(args);
		};
		await expect(h.manager.start({ title: "late", cwd: repo, channel: CHANNEL })).rejects.toThrow();
		expect(archives()).toHaveLength(1);
		expect(h.store.listLanes()).toEqual([]);
	});

	test("start failing before openThread archives nothing", async () => {
		h = laneHarness(home.dir);
		h.transport.failNext.startThread = [new Error("thread down")];
		await expect(h.manager.start({ title: "early", cwd: repo, channel: CHANNEL })).rejects.toThrow();
		expect(archives()).toHaveLength(0);
		h.transport.failNext.createMessage = [new Error("root down")];
		await expect(h.manager.start({ title: "earlier", cwd: repo, channel: CHANNEL })).rejects.toThrow();
		expect(archives()).toHaveLength(0);
	});
});
