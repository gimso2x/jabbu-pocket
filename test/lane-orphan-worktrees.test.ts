import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { orphanLaneIds } from "../src/lanes/orphans";
import { worktreePathOf } from "../src/tasks/docs";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const CHILD = join(import.meta.dir, "fixtures", "lane-start-crash-child.ts");
let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-lane-orphan-home-");
	repos = [];
});
afterEach(() => {
	home.remove();
	for (const dir of repos) removeRepoAndWorktrees(dir);
});

test("orphanLaneIds: a branch with a worktree and no row; rows, and branches without a worktree, are not orphans", () => {
	const repo = "/r/app";
	const present = new Set([worktreePathOf(repo, "L-1-01"), worktreePathOf(repo, "L-1-02")]);
	const found = orphanLaneIds(repo, new Set(["L-1-01", "L-1-02", "L-1-03"]), new Set(["L-1-02"]), (p) =>
		present.has(p),
	);
	expect(found).toEqual(["L-1-01"]);
});

test("a start killed after the worktree exists is reported by the next start, and nothing is deleted", async () => {
	const repo = makeRepo(repos);
	const child = Bun.spawn(["bun", CHILD, home.dir, repo], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(137);

	const h = laneHarness(home.dir);
	try {
		expect(h.store.listLanes()).toHaveLength(0);
		const lane = await h.manager.start({ title: "second", cwd: repo, channel: CHANNEL, parentOrigin: "discord/dm/1" });
		await h.settle();
		expect(lane.meta.laneId?.endsWith("-02")).toBe(true); // the id of the orphan is skipped, as before
		const warned = h.logs.filter((line) => line.includes("lane_orphan_worktrees"));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("-01");
		const orphanTree = worktreePathOf(repo, `${lane.meta.laneId?.slice(0, -2)}01`);
		expect(existsSync(orphanTree)).toBe(true);
		expect(
			git(repo, "branch", "--list", "lane/*")
				.split("\n")
				.filter((l) => l.trim() !== ""),
		).toHaveLength(2);
	} finally {
		h.close();
	}
});
