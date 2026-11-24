import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrLanding } from "../src/lanes/pr-land";
import type { PrLandCrashPoint, PrLandDeps, PrLandInput } from "../src/lanes/pr-land-steps";
import type { LanePrLand, PrLandOutcome } from "../src/lanes/pr-land-types";
import { checkLeaks } from "../src/release/leak-check";
import { FakeGh } from "./helpers/fake-gh";
import { git, makeRepo } from "./helpers/git-fixtures";

// AC-11: a PR landing whose process dies at any point finishes on the next run from what was saved, without a second
// PR, a second merge or a lost cleanup. The death is the `crash` hook throwing; the
// next run gets a fresh input and fresh deps and only the `LanePrLand` that `save` received last. The fake `gh` and the
// bare repository (the remote) live on.
//
// Moment of §5                              crash point         what the saved record has when the process dies
// 1 during the gate                         leak-passed         nothing (leak check done, not recorded)
// 2 after the push, before its step         push-done           step leak-checked (push done, not recorded)
// 3 after pr create, before its number      create-done         step pushed (PR exists remotely, number not recorded)
// 4 PR open (the poll path)                 pr-created          step pr-created (number recorded)
// 5 after the merge, before `merged`        merge-done          step merging (remote merged, not recorded)
// 6 before the local fast-forward           merged              step merged (nothing synced yet)
// 7 after the fast-forward, before cleanup  ff-done             step merged, local base moved (not recorded)
//   (extra) after `synced`, before cleanup  synced              step synced (worktree and branch still there)

const SLUG = "acme/widgets";
const GITHUB_URL = `https://github.com/${SLUG}.git`;

/** The process death: a distinct error so a test can tell it from a real failure. */
class Died extends Error {
	constructor(readonly point: PrLandCrashPoint) {
		super(`process died at ${point}`);
	}
}

let scratch: string[];
let repos: string[];

beforeEach(() => {
	scratch = [];
	repos = [];
});

afterEach(() => {
	for (const dir of [...scratch, ...repos]) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

interface World {
	repo: string;
	bare: string;
	worktree: string;
	fake: FakeGh;
	input: Omit<PrLandInput, "prLand">;
	gitleaks: string;
	sha: string;
}

/** A repository on `main` with a GitHub-address remote backed by a bare repository, and a closed lane worktree. */
function world(): World {
	const repo = makeRepo(repos);
	const bare = tempDir("jabbu-recovery-bare-");
	git(bare, "init", "-q", "--bare");
	git(repo, "remote", "add", "origin", GITHUB_URL);
	git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
	git(repo, "push", "-q", "origin", "main");
	const records = tempDir("jabbu-recovery-records-");
	const denylistFile = join(records, "denylist.txt");
	writeFileSync(denylistFile, "# none\nplanted-owner-marker-7310\n");
	const gitleaks = join(records, "gitleaks");
	writeFileSync(gitleaks, "#!/bin/sh\nexit 0\n");
	chmodSync(gitleaks, 0o755);
	const worktree = join(tempDir("jabbu-recovery-wt-"), "lane");
	const branch = "lane/recovery";
	git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	writeFileSync(join(worktree, "a.txt"), "a\n");
	git(worktree, "add", "--", "a.txt");
	git(worktree, "commit", "-q", "-m", "add a.txt");
	const sha = git(worktree, "rev-parse", "HEAD");
	const fake = new FakeGh({ slug: SLUG, bare });
	fake.setCi(sha, "success");
	return {
		repo,
		bare,
		worktree,
		fake,
		gitleaks,
		sha,
		input: {
			repo,
			worktree,
			branch,
			baseBranch: "main",
			sha,
			checksHead: sha,
			title: "land",
			summary: "a.txt 추가",
			config: { mode: "pr" },
			denylistFile,
			frozen: false,
		},
	};
}

/** What the "process" keeps outside its memory: the last record `save` was given. */
interface Disk {
	saved: LanePrLand | undefined;
	saves: number;
}

/** Fresh deps over the shared fake and disk; `crashAt` throws `Died` once the named point is reached. */
function depsOf(w: World, disk: Disk, crashAt: PrLandCrashPoint | undefined): PrLandDeps {
	return {
		git: (args) => w.fake.tools.git(args, { cwd: w.repo, signal: AbortSignal.timeout(60_000) }),
		tools: w.fake.tools,
		signal: new AbortController().signal,
		checkLeaks,
		gitleaks: w.gitleaks,
		removeWorktree: async ({ repo, worktree, branch }) => {
			git(repo, "worktree", "remove", "--force", worktree);
			git(repo, "branch", "-D", branch);
		},
		now: () => Date.now(),
		save: (prLand) => {
			disk.saved = prLand;
			disk.saves += 1;
		},
		crash: (point) => {
			if (point === crashAt) throw new Died(point);
		},
	};
}

/**
 * Runs the landing to its end. The first run dies at `crashAt`; every later run is a new "process" that starts from
 * `disk.saved` alone. A `pr-open` outcome is the end of the open run: the next run (the poll) follows at once.
 */
async function landThroughDeath(
	w: World,
	crashAt: PrLandCrashPoint,
): Promise<{ outcome: PrLandOutcome; runs: number }> {
	const disk: Disk = { saved: undefined, saves: 0 };
	let died = 0;
	for (let runs = 1; runs <= 6; runs++) {
		const crash = died === 0 ? crashAt : undefined;
		try {
			const outcome = await runPrLanding({ ...w.input, prLand: disk.saved }, depsOf(w, disk, crash));
			if (outcome.kind === "pr-open") continue;
			expect(died).toBe(1);
			return { outcome, runs };
		} catch (error) {
			if (!(error instanceof Died)) throw error;
			expect(error.point).toBe(crashAt);
			died += 1;
		}
	}
	throw new Error(`the landing did not end after the death at ${crashAt}`);
}

const POINTS: ReadonlyArray<{ moment: string; point: PrLandCrashPoint }> = [
	{ moment: "1 게이트 중(누출 검사 통과, 기록 전)", point: "leak-passed" },
	{ moment: "2 push 직후, step 기록 전", point: "push-done" },
	{ moment: "3 pr create 직후, 번호 기록 전", point: "create-done" },
	{ moment: "4 pr-open(번호 기록 후, poll 경로)", point: "pr-created" },
	{ moment: "5 merge 직후, merged 기록 전", point: "merge-done" },
	{ moment: "6 로컬 ff 전(merged 기록 후)", point: "merged" },
	{ moment: "7 ff 후, synced 기록·정리 전", point: "ff-done" },
	{ moment: "추가: synced 기록 후, 정리 전", point: "synced" },
];

describe("AC-11 복구: 프로세스가 죽어도 다시 실행하면 한 번만 착지한다", () => {
	for (const { moment, point } of POINTS) {
		test(`AC-11 ${moment} (${point})`, async () => {
			const w = world();
			const baseBefore = git(w.bare, "rev-parse", "main");
			const { outcome, runs } = await landThroughDeath(w, point);

			expect(outcome.kind).toBe("landed");
			expect(runs).toBeGreaterThanOrEqual(2);
			// One PR, created once; one successful merge, so no duplicate merge commit on the remote base.
			expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
			expect(w.fake.prs).toHaveLength(1);
			const merged = w.fake.prs.filter((pr) => pr.state === "MERGED");
			expect(merged).toHaveLength(1);
			expect(merged[0]?.mergeCommit).toBeDefined();
			expect(git(w.bare, "rev-list", "--count", `${baseBefore}..main`)).toBe("1");
			if (outcome.kind === "landed") expect(outcome.mergedSha).toBe(merged[0]?.mergeCommit as string);
			// The lane branch was pushed without force and the remote base is the squash commit.
			expect(w.fake.callsOf("git", "push").every((call) => !call.argv.includes("--force"))).toBe(true);
			expect(git(w.bare, "rev-parse", "main")).toBe(merged[0]?.mergeCommit as string);
			// Local base == remote base; worktree and local lane branch are gone.
			expect(git(w.repo, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
			expect(existsSync(w.worktree)).toBe(false);
			expect(git(w.repo, "branch", "--list", w.input.branch)).toBe("");
			if (outcome.kind === "landed") expect(outcome.cleanup).toBeUndefined();
		});
	}
});
