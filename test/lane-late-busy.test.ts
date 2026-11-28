// A turn starting while a landing/discard is prepared must hold it off: the entry
// `laneBusy` check alone is not enough, because the awaits in between (repo and
// land-mode reads, QA stop) leave time for a turn to start (round-15 F2, F4). Each
// test flips `laneBusy` on the second call — the first call is the entry check, the
// second the late re-check — so the test fails when the re-check is removed: the
// worktree is gone instead of kept.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneLand } from "../src/lanes/status";
import { CHANNEL } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const LANE = "late-busy";
const LANE_ORIGIN = `jabbu/work/${LANE}`;
const BRANCH = "lane/L-20261128-01";

/** A snowflake-sized message id from a small number. */
const sf = (n: number): string => String(700_000_000_000_000_000n + BigInt(n));

let homeDir: string;
let repos: string[];
let h: LaneHarness | undefined;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "jabbu-late-busy-"));
	repos = [];
	h = undefined;
});

afterEach(() => {
	h?.close();
	rmSync(homeDir, { recursive: true, force: true });
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** A harness whose `laneBusy` is false on the first call, true from the second. */
function harness(): { h: LaneHarness; busy: () => number } {
	let calls = 0;
	const hh = laneHarness(homeDir, {
		laneBusy: () => {
			calls += 1;
			return calls >= 2;
		},
	});
	h = hh;
	return { h: hh, busy: () => calls };
}

interface LaneFixture {
	repo: string;
	worktree: string;
	baseSha: string;
	sha: string;
}

/** A repo with the lane branch one commit ahead of main; `mergedIntoBase` also fast-forwards main onto it. */
function makeLaneRepo(mergedIntoBase: boolean): LaneFixture {
	const repo = makeRepo(repos);
	const baseSha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "-b", BRANCH);
	git(repo, "commit", "-q", "--allow-empty", "-m", "lane work");
	const sha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "main");
	if (mergedIntoBase) git(repo, "merge", "-q", "--ff-only", BRANCH);
	const worktree = `${repo}-l-20261128-01`;
	git(repo, "worktree", "add", "-q", worktree, BRANCH);
	return { repo, worktree, baseSha, sha };
}

function insertClosedLane(hh: LaneHarness, fx: LaneFixture, land: LaneLand): void {
	hh.store.insertLane({
		name: LANE,
		title: "late busy lane",
		threadRef: `${CHANNEL}:${sf(9001)}`,
		originKey: LANE_ORIGIN,
		cwd: fx.worktree,
		sessionDir: join(homeDir, "sessions", LANE),
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			repo: fx.repo,
			worktree: fx.worktree,
			branch: BRANCH,
			baseBranch: "main",
			baseSha: fx.baseSha,
			sha: fx.sha,
			land,
		},
	});
	hh.store.transitionLane(LANE, "done-claimed", { event: "claimed" });
	hh.store.transitionLane(LANE, "closed", { event: "closed" });
}

test("a turn starting during requestLand's preparation defers the landing", async () => {
	const fx = makeLaneRepo(false);
	const { h: hh, busy } = harness();
	insertClosedLane(hh, fx, { state: "pending", requestedBy: "owner", attempts: 0 });
	const outcome = await hh.manager.requestLand(LANE, "owner");
	await hh.settle();
	expect(outcome.text).toContain("끝나는 대로 머지합니다");
	expect(hh.store.getLane(LANE)?.meta.land?.state).toBe("pending");
	expect(existsSync(fx.worktree)).toBe(true);
	expect(busy()).toBe(2);
});

test("a turn starting during discard preparation keeps the worktree", async () => {
	const fx = makeLaneRepo(false);
	const { h: hh, busy } = harness();
	insertClosedLane(hh, fx, { state: "pending", attempts: 0 });
	const outcome = await hh.manager.discard(LANE);
	await hh.settle();
	expect(outcome.handled).toBe(false);
	expect(outcome.text).toContain("다시 시도해 주세요");
	expect(hh.store.getLane(LANE)?.meta.land?.state).toBe("pending");
	expect(existsSync(fx.worktree)).toBe(true);
	expect(busy()).toBe(2);
});
