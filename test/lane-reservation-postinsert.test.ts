// A reservation ▶ whose `start` throws after the lane row was inserted (injected matcher failure) must not leave a
// working lane behind: the retry click would otherwise open a second one for the same reservation.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

let home: TestHome;
let repos: string[];
let h: LaneHarness;
let fail = false;
beforeEach(() => {
	home = makeHome("zz-");
	repos = [];
});
afterEach(() => {
	h?.close();
	home.remove();
	for (const r of repos) removeRepoAndWorktrees(r);
});

test("▶ on a reservation whose start throws after the lane row exists: the failed lane is closed and the second click opens the only live one", async () => {
	const repo = makeRepo(repos);
	const repoB = makeRepo(repos);
	h = laneHarness(home.dir, {
		repoMatches: async () => {
			if (fail) throw new Error("spawn EMFILE");
			return false;
		},
	});
	const a = await h.manager.start({ title: "first", cwd: repoB, channel: CHANNEL });
	await h.settle();
	await h.manager.start({ title: "other", cwd: repo, channel: CHANNEL });
	await h.settle();
	h.store.transitionLane("first", "done-claimed", { event: "claimed" });
	h.store.transitionLane("first", "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
	const r = await h.manager.reserve({
		args: { title: "next step", cwd: repoB, channel: CHANNEL, brief: "x" },
		after: ["first"],
		originKey: "discord/dm/1",
		threadRef: a.threadRef,
	});
	await h.manager.tick();
	await h.settle();
	fail = true;
	const o1 = await h.manager.startReservation(r.id);
	await h.settle();
	expect(o1.handled).toBeFalse();
	expect(h.store.getLaneReservation(r.id)?.state).toBe("ready");
	fail = false;
	expect((await h.manager.startReservation(r.id)).handled).toBeTrue();
	await h.settle();
	const working = h.store.listLanes().filter((l) => l.title === "next step" && l.status === "working");
	expect(working).toHaveLength(1);
});
