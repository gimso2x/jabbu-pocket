// A process can die between any two steps of an apply or a landing (an OOM, a reboot, a `kill -9`). These tests kill a
// real child at each boundary and prove that the run after it either finishes the work or leaves the repository alone —
// never a half-applied checkout holding the lock nobody releases.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashHook } from "../src/daemon/crash";
import { git, makeRepo } from "./helpers/git-fixtures";
import { treeSnapshot } from "./helpers/tree-snapshot";

const REPO_ROOT = join(import.meta.dir, "..");
const APPLY_CHILD = join(REPO_ROOT, "test", "fixtures", "apply-crash-child.ts");
const LAND_CHILD = join(REPO_ROOT, "test", "fixtures", "land-crash-child.ts");
const STAMP = "20261124-090000";

const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface ChildRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Runs a fixture child to its end; `env` overrides are the only way a test arms a crash point. */
async function runChild(script: string, arg: string, env: Record<string, string> = {}): Promise<ChildRun> {
	const proc = Bun.spawn(["bun", script, arg], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

interface World {
	spec: { root: string; home: string; repo: string; stamp: string };
	arg: string;
	/** The receipt of the apply, once a run finished one. */
	receipt: () => Record<string, unknown>;
	lockPath: string;
}

/** A fresh world for one apply crash test: a home and a checkout on main, both empty until the child builds them. */
function makeWorld(): World {
	const root = scratch("ompbot-crash-apply-");
	const spec = { root, home: join(root, "home"), repo: join(root, "repo"), stamp: STAMP };
	mkdirSync(spec.home, { recursive: true, mode: 0o700 });
	mkdirSync(spec.repo, { recursive: true });
	const receiptPath = join(spec.home, "logs", `apply-${STAMP}.json`);
	return {
		spec,
		arg: JSON.stringify(spec),
		receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>,
		lockPath: join(spec.home, "apply.lock"),
	};
}

const APPLY_POINTS = ["apply_after_backup", "apply_after_drain", "apply_after_deps", "apply_after_restart"] as const;

describe("an apply killed at a step boundary", () => {
	for (const point of APPLY_POINTS) {
		test(`${point}: the process dies, the re-run applies, and no lock is left behind`, async () => {
			const world = makeWorld();
			const killed = await runChild(APPLY_CHILD, world.arg, {
				OMPBOT_TEST_HOOKS: "1",
				OMPBOT_TEST_CRASH_AT: point,
			});
			expect(killed.exitCode).toBe(137);
			// The dead process never released its lock: the re-run has to take it over instead of waiting on it.
			expect(existsSync(world.lockPath)).toBe(true);
			expect(existsSync(join(world.spec.home, "logs", `apply-${STAMP}.json`))).toBe(false);

			const again = await runChild(APPLY_CHILD, world.arg);
			expect(again.exitCode).toBe(0);
			expect(JSON.parse(again.stdout.trim())).toEqual({ status: "ok", exitCode: 0 });
			expect(existsSync(world.lockPath)).toBe(false);
			expect(world.receipt().status).toBe("ok");
		}, 60_000);
	}

	test("a stray OMPBOT_TEST_CRASH_AT without OMPBOT_TEST_HOOKS=1 changes nothing", async () => {
		const world = makeWorld();
		const run = await runChild(APPLY_CHILD, world.arg, { OMPBOT_TEST_CRASH_AT: "apply_after_backup" });
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout.trim())).toEqual({ status: "ok", exitCode: 0 });
		expect(world.receipt().status).toBe("ok");
	}, 60_000);

	test("an unknown crash point is refused instead of silently never firing", async () => {
		const world = makeWorld();
		const run = await runChild(APPLY_CHILD, world.arg, {
			OMPBOT_TEST_HOOKS: "1",
			OMPBOT_TEST_CRASH_AT: "apply_after_nothing",
		});
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("unknown crash point apply_after_nothing");
		// It refused before touching the home: no receipt, and the checkout was never applied.
		expect(existsSync(join(world.spec.home, "logs", `apply-${STAMP}.json`))).toBe(false);
	}, 60_000);
});

interface Landing {
	repo: string;
	worktree: string;
	branch: string;
	sha: string;
	request: string;
	originMain: () => string;
}

/**
 * A repository on `main` with `origin` (a bare copy), one lane worktree with one commit on top of main, and the request
 * that lands that commit. The lane branch is named as the host's own rule requires.
 */
function makeLanding(): Landing {
	const root = scratch("ompbot-crash-land-");
	const repo = makeRepo([], "repo-");
	const origin = join(root, "origin.git");
	git(repo, "init", "-q", "--bare", origin);
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	const worktree = join(root, "wt");
	const branch = "lane/L-20261124-01";
	git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
	writeFileSync(join(worktree, "lane.txt"), "lane work\n");
	git(worktree, "add", "--", "lane.txt");
	git(worktree, "commit", "-q", "-m", "lane work");
	const sha = git(worktree, "rev-parse", "HEAD");
	return {
		repo,
		worktree,
		branch,
		sha,
		request: JSON.stringify({ repo, baseBranch: "main", branch, worktree, sha, push: true }),
		originMain: () => git(origin, "rev-parse", "main"),
	};
}

const LAND_POINTS = ["land_after_merge_before_push", "land_after_push_before_cleanup"] as const;

/** `git rev-parse --verify -q <ref>` as "" when the ref is gone (the fixture `git` throws on any non-zero exit). */
function refOrEmpty(dir: string, ref: string): string {
	try {
		return git(dir, "rev-parse", "--verify", "-q", ref);
	} catch {
		return "";
	}
}

describe("a landing killed between its steps", () => {
	for (const point of LAND_POINTS) {
		test(`${point}: the re-run finishes the landing and removes the worktree`, async () => {
			const landing = makeLanding();
			const killed = await runChild(LAND_CHILD, landing.request, {
				OMPBOT_TEST_HOOKS: "1",
				OMPBOT_TEST_CRASH_AT: point,
			});
			expect(killed.exitCode).toBe(137);
			expect(git(landing.repo, "rev-parse", "main")).toBe(landing.sha);

			const again = await runChild(LAND_CHILD, landing.request);
			expect(again.exitCode).toBe(0);
			const result = JSON.parse(again.stdout.trim()) as { state: string; cleanup?: string };
			expect(result.state).toBe("landed");
			expect(result.cleanup).toBeUndefined();
			expect(existsSync(landing.worktree)).toBe(false);
			expect(refOrEmpty(landing.repo, `refs/heads/${landing.branch}`)).toBe("");
			expect(landing.originMain()).toBe(landing.sha);
		}, 60_000);
	}

	test("a landing refused before it starts leaves the repository exactly as it was", async () => {
		const landing = makeLanding();
		const before = treeSnapshot(landing.repo, [".git"]);
		const missing = JSON.stringify({ ...JSON.parse(landing.request), sha: "f".repeat(40) });
		const run = await runChild(LAND_CHILD, missing);
		expect(run.exitCode).toBe(0);
		const result = JSON.parse(run.stdout.trim()) as { state: string; reason: string };
		expect(result.state).toBe("blocked");
		expect(result.reason).toContain("없습니다");
		expect(treeSnapshot(landing.repo, [".git"])).toEqual(before);
		expect(git(landing.repo, "rev-parse", "main")).toBe(git(landing.repo, "rev-parse", "origin/main"));
		expect(existsSync(landing.worktree)).toBe(true);
		expect(git(landing.repo, "rev-parse", `refs/heads/${landing.branch}`)).toBe(landing.sha);
	}, 60_000);
});

describe("the crash helper itself", () => {
	const allPoints = [
		"after_dispatch",
		"after_final_before_answered",
		"after_answered",
		"after_post_before_confirm",
		"apply_after_backup",
		"apply_after_drain",
		"apply_after_deps",
		"apply_after_restart",
		"land_after_merge_before_push",
		"land_after_push_before_cleanup",
	];

	test("only OMPBOT_TEST_HOOKS=1 arms it, and only for the named point", () => {
		const exits: number[] = [];
		const record = (code: number): never => {
			exits.push(code);
			throw new Error(`exit ${code}`);
		};
		const armed = crashHook({ OMPBOT_TEST_HOOKS: "1", OMPBOT_TEST_CRASH_AT: "apply_after_drain" }, record);
		expect(() => armed("apply_after_backup")).not.toThrow();
		expect(exits).toEqual([]);
		expect(() => armed("apply_after_drain")).toThrow("exit 137");
		expect(exits).toEqual([137]);

		const stray = crashHook({ OMPBOT_TEST_CRASH_AT: "apply_after_drain" }, record);
		expect(() => stray("apply_after_drain")).not.toThrow();
		expect(exits).toEqual([137]);
	});

	test("every declared point is accepted, and one the type does not declare is refused", () => {
		const never = (): never => {
			throw new Error("must not exit");
		};
		for (const point of allPoints) {
			expect(() => crashHook({ OMPBOT_TEST_HOOKS: "1", OMPBOT_TEST_CRASH_AT: point }, never)).not.toThrow();
		}
		expect(() => crashHook({ OMPBOT_TEST_HOOKS: "1", OMPBOT_TEST_CRASH_AT: "apply_after_nothing" }, never)).toThrow(
			"unknown crash point apply_after_nothing",
		);
	});
});
