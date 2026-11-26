import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLaneOutcomeCard } from "../src/lanes/card";
import { gcSessions } from "../src/ops/gc";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// A lane's recorded file evidence is copied to <home>/lanes/<lane>/artifacts/<sha256> before its worktree goes, on every
// path that removes the worktree (landing, discard, failed launch).

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-lane-artifacts-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

const lanesDir = () => join(home.dir, "lanes");
const artifactsOf = (name: string) => join(lanesDir(), name, "artifacts");

/** A started lane whose worktree holds `report.txt`, reported as progress evidence. */
async function laneWithEvidence(h: LaneHarness, repo: string, content = "green\n", commit = false) {
	const lane = await h.manager.start({ title: "proof", cwd: repo, channel: CHANNEL, risk: "L2" });
	await h.settle();
	const worktree = lane.meta.worktree ?? "";
	writeFileSync(join(worktree, "report.txt"), content);
	if (commit) {
		git(worktree, "add", "--", "report.txt");
		git(worktree, "commit", "-q", "-m", "report");
	}
	expect(await h.manager.progress(lane.originKey, "report written", { evidence: { file: "report.txt" } })).toBe(
		"progress recorded",
	);
	return { lane, worktree };
}

const historyEvents = (h: LaneHarness, name: string) =>
	(h.store.getLane(name)?.history ?? []).map((entry) => entry.event);

/** Closes `lane` as a landing would find it: a claim over the committed work, verified by the core. */
async function claim(h: LaneHarness, lane: { originKey: string }, worktree: string) {
	expect(await h.manager.claimDone(lane.originKey, { repo: worktree, commit: "HEAD", summary: "report" })).toContain(
		"검증 통과",
	);
	await h.settle();
}

describe("lane evidence artifacts (AC-2)", () => {
	test("landing keeps the evidence file under its sha256 and the card says so; the worktree is gone", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir, { lanesDir: lanesDir() });
		const { lane, worktree } = await laneWithEvidence(h, repo, "green\n", true);
		await claim(h, lane, worktree);
		expect((await h.manager.requestLand(lane.name, "owner")).handled).toBe(true);
		await h.settle();
		expect(h.store.getLane(lane.name)?.meta.land?.state).toMatch(/landed|merged-not-pushed/);
		expect(existsSync(worktree)).toBe(false);
		expect(readFileSync(join(artifactsOf(lane.name), sha256("green\n")), "utf8")).toBe("green\n");
		const closed = h.store.getLane(lane.name);
		expect(closed?.meta.evidence).toEqual([{ file: "report.txt", sha256: sha256("green\n"), preserved: true }]);
		const card = buildLaneOutcomeCard(closed as NonNullable<typeof closed>, { kind: "result" });
		expect(card.text).toContain("증거: 파일 report.txt(보존됨)");
		h.close();
	});

	test("discard keeps the file; a changed file is artifact_drift (not copied); the worktree is removed either way", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir, { lanesDir: lanesDir() });
		const kept = await laneWithEvidence(h, repo, "one\n", true);
		await claim(h, kept.lane, kept.worktree);
		expect((await h.manager.discard(kept.lane.name)).handled).toBe(true);
		expect(existsSync(kept.worktree)).toBe(false);
		expect(readdirSync(artifactsOf(kept.lane.name))).toEqual([sha256("one\n")]);
		expect(historyEvents(h, kept.lane.name)).not.toContain("artifact_drift");

		const drifted = await laneWithEvidence(h, repo, "two\n", true);
		await claim(h, drifted.lane, drifted.worktree);
		writeFileSync(join(drifted.worktree, "report.txt"), "changed afterwards\n");
		expect((await h.manager.discard(drifted.lane.name)).handled).toBe(true);
		expect(existsSync(drifted.worktree)).toBe(false);
		expect(existsSync(artifactsOf(drifted.lane.name))).toBe(false);
		expect(historyEvents(h, drifted.lane.name)).toContain("artifact_drift");
		expect(h.logs.some((entry) => entry.includes("artifact_drift"))).toBe(true);
		h.close();
	});

	test("a copy that fails is artifact_copy_failed with a warning, and the worktree is still removed", async () => {
		const repo = makeRepo(repos);
		// A regular file where the lanes directory should be: mkdir under it fails.
		const blocker = join(home.dir, "not-a-directory");
		writeFileSync(blocker, "x");
		const h = laneHarness(home.dir, { lanesDir: blocker });
		const { lane, worktree } = await laneWithEvidence(h, repo, "three\n", true);
		await claim(h, lane, worktree);
		expect((await h.manager.discard(lane.name)).handled).toBe(true);
		expect(existsSync(worktree)).toBe(false);
		expect(historyEvents(h, lane.name)).toContain("artifact_copy_failed");
		expect(h.logs.some((entry) => entry.includes("artifact_copy_failed"))).toBe(true);
		expect(h.store.getLane(lane.name)?.meta.evidence?.[0]).not.toHaveProperty("preserved");
		h.close();
	});

	test("a refused launch (failLaunch) goes through the same keep-then-remove step", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir, { lanesDir: lanesDir() });
		const { lane, worktree } = await laneWithEvidence(h, repo, "four\n");
		await h.manager.failLaunch(lane.originKey, "refused");
		expect(existsSync(worktree)).toBe(false);
		expect(readFileSync(join(artifactsOf(lane.name), sha256("four\n")), "utf8")).toBe("four\n");
		h.close();
	});

	test("gc removes a closed lane's kept evidence past the retention window, never a fresh one", () => {
		const old = join(lanesDir(), "L-old", "artifacts");
		const fresh = join(lanesDir(), "L-fresh", "artifacts");
		for (const dir of [old, fresh]) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "x"), "x");
		}
		const now = Date.now();
		const past = new Date(now - 40 * 24 * 60 * 60 * 1000);
		for (const path of [join(old, "x"), old, join(lanesDir(), "L-old")]) utimesSync(path, past, past);
		const h = laneHarness(home.dir);
		h.close();
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now });
		expect(result.laneArtifactsRemoved).toEqual([join(lanesDir(), "L-old")]);
		expect(existsSync(join(lanesDir(), "L-old"))).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		rmSync(lanesDir(), { recursive: true, force: true });
	});

	test("gc reports a lane it cannot read as skipped instead of silently dropping it", () => {
		const deep = join(lanesDir(), "L-deep");
		mkdirSync(deep, { recursive: true });
		// Paths past PATH_MAX make lstat throw (root cannot chmod a directory unreadable):
		// 25 levels of 200-char names push the walk past 4096 bytes. The tree is built by
		// bash cds down one relative name at a time: neither an absolute path past PATH_MAX
		// nor Node's chdir (which getcwd's afterwards) can go that deep, and dash's cd cannot.
		const name = "d".repeat(200);
		expect(
			Bun.spawnSync(["bash", "-c", 'for i in $(seq 1 25); do mkdir "$1" && cd "$1" || exit 1; done', "bash", name], {
				cwd: deep,
			}).exitCode,
		).toBe(0);
		const h = laneHarness(home.dir);
		h.close();
		const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: Date.now() });
		expect(result.laneArtifactsRemoved).toEqual([]);
		expect(result.laneArtifactsSkipped).toEqual([deep]);
		expect(existsSync(deep)).toBe(true);
		rmSync(lanesDir(), { recursive: true, force: true });
	});
});
