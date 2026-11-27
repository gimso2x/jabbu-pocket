import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BranchRule, loadConfig } from "../src/config";
import type { ProcessRunner } from "../src/dispatch/omp";
import { baseProblem, resolveTaskBase } from "../src/tasks/base-ref";
import { createTaskHostOps } from "../src/tasks/host";
import { makeHome, type TestHome } from "./helpers/bot-home";

const SHA = "c".repeat(40);
const REPO = "/home/dev/repo/web-app";
const WORKTREE = "/home/dev/repo/web-app-t-20261127-01";
const BRANCH = "feature/202611-x";

/** A recording ssh runner: `answer` maps the remote command (words as the remote shell reads them) to a result. */
function recorder(answer: (git: string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: "" })) {
	const calls: string[][] = [];
	const run: ProcessRunner = async (raw) => {
		const words = raw.slice(raw.indexOf("--") + 2).map((w) => (w.startsWith("'") ? w.slice(1, -1) : w));
		const git = words.slice(0, -1); // the trailing `2>&1`
		calls.push(git);
		return { ...answer(git), timedOut: false };
	};
	return { calls, run };
}
const happy = (remotes: string) => (git: string[]) =>
	git[3] === "remote"
		? { code: 0, stdout: remotes }
		: git[3] === "rev-parse"
			? { code: 0, stdout: `${SHA}\n` }
			: { code: 0, stdout: "" };
const create = (run: ProcessRunner, base?: string) =>
	createTaskHostOps({ run, sshTarget: "wsl" }).createWorktree({
		repo: REPO,
		worktree: WORKTREE,
		branch: BRANCH,
		...(base === undefined ? {} : { base }),
	});
const WORKTREE_ADD = ["git", "-C", REPO, "worktree", "add", "--no-track", "-b", BRANCH, WORKTREE, SHA];

describe("AC-1: remote worktree creation order", () => {
	test("origin/master: remote → fetch → rev-parse → worktree add --no-track from the sha", async () => {
		const { calls, run } = recorder(happy("origin\n"));
		expect(await create(run, "origin/master")).toEqual({ ok: true, value: null });
		expect(calls).toEqual([
			["git", "-C", REPO, "remote"],
			["git", "-C", REPO, "fetch", "--quiet", "origin", "+refs/heads/master:refs/remotes/origin/master"],
			["git", "-C", REPO, "rev-parse", "--verify", "--quiet", "origin/master^{commit}"],
			WORKTREE_ADD,
		]);
	});

	test("origin/feature/202611-x fetches the whole branch name after the remote", async () => {
		const { calls, run } = recorder(happy("origin\nupstream\n"));
		await create(run, "origin/feature/202611-x");
		expect(calls[1]).toEqual([
			"git",
			"-C",
			REPO,
			"fetch",
			"--quiet",
			"origin",
			"+refs/heads/feature/202611-x:refs/remotes/origin/feature/202611-x",
		]);
		expect(calls[2]).toEqual([
			"git",
			"-C",
			REPO,
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/feature/202611-x^{commit}",
		]);
	});

	test("the longest remote name wins", async () => {
		const { calls, run } = recorder(happy("team\nteam/fork\n"));
		await create(run, "team/fork/dev");
		expect(calls[1]?.slice(4)).toEqual(["--quiet", "team/fork", "+refs/heads/dev:refs/remotes/team/fork/dev"]);
	});

	test("a local feature/202611-x (no remote prefix) is not fetched", async () => {
		const { calls, run } = recorder(happy("origin\n"));
		await create(run, "feature/202611-x");
		expect(calls.map((c) => c[3])).toEqual(["remote", "rev-parse", "worktree"]);
	});

	test("no base: HEAD, no remote listing, no fetch, still --no-track from the sha", async () => {
		const { calls, run } = recorder(happy(""));
		await create(run);
		expect(calls).toEqual([["git", "-C", REPO, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], WORKTREE_ADD]);
	});

	test("a commit id is resolved like any ref and never fetched", async () => {
		const { calls, run } = recorder(happy(""));
		await create(run, SHA);
		expect(calls.map((c) => c[3])).toEqual(["rev-parse", "worktree"]);
	});

	test("a failed fetch or remote listing is an error, never a fallback to a stale local ref", async () => {
		const failing = (step: string) =>
			recorder((git) => (git[3] === step ? { code: 128, stdout: "fatal: boom" } : happy("origin\n")(git)));
		for (const step of ["remote", "fetch"]) {
			const { calls, run } = failing(step);
			const result = await create(run, "origin/master");
			expect(result).toMatchObject({ ok: false });
			expect((result as { error: string }).error).toContain("boom");
			expect(calls.some((c) => c[3] === "worktree")).toBe(false);
		}
	});

	test("an unresolvable base is an error that names it, and no worktree is added", async () => {
		const { calls, run } = recorder((git) =>
			git[3] === "rev-parse" ? { code: 1, stdout: "" } : { code: 0, stdout: "" },
		);
		expect(await create(run, "feature/missing")).toEqual({
			ok: false,
			error: "기준 ref를 찾을 수 없습니다: feature/missing",
		});
		expect(calls.some((c) => c[3] === "worktree")).toBe(false);
	});

	test("an unsafe base never reaches ssh", async () => {
		const { calls, run } = recorder();
		for (const base of ["a;b", "-x", "a..b", "x@{1}", "$(id)"])
			await expect(create(run, base)).rejects.toThrow("unsafe base");
		expect(calls).toEqual([]);
	});
});

describe("AC-2: base priority and safety", () => {
	const RULE: BranchRule = { repoPrefix: "/home/dev/repo/", pattern: ".*", example: "x", base: "origin/master" };
	test("taskSpec.base beats the rule's base, which beats HEAD", () => {
		expect(resolveTaskBase([RULE], REPO, "origin/develop")).toBe("origin/develop");
		expect(resolveTaskBase([RULE], REPO, undefined)).toBe("origin/master");
		expect(resolveTaskBase([{ ...RULE, base: undefined }], REPO, undefined)).toBe("HEAD");
		expect(resolveTaskBase(undefined, REPO, undefined)).toBe("HEAD");
		expect(resolveTaskBase([RULE], "/elsewhere/app", undefined)).toBe("HEAD");
	});
	test("an unsafe base is refused", () => {
		for (const bad of ["a;b", "-x", "a..b", "x@{1}", "a b", "x`id`"]) {
			expect(baseProblem(bad), bad).toBeDefined();
			expect(() => resolveTaskBase(undefined, REPO, bad)).toThrow("taskSpec.base");
		}
		for (const good of ["origin/master", "HEAD", "feature/202611-배너", SHA])
			expect(baseProblem(good), good).toBeUndefined();
	});
});

describe("AC-5: branchRules[].base in the config", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("jabbu-base-rules-");
	});
	afterEach(() => home.remove());
	const rule = (base: unknown) => ({ repoPrefix: "/home/dev/repo/", pattern: "^x$", example: "x", base });

	function write(branchRules: unknown): void {
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...config, herdr: {}, dispatchHosts: { h: { ssh: "h", branchRules } } }), {
			mode: 0o600,
		});
	}

	test("a valid base loads", () => {
		write([rule("origin/master")]);
		expect(loadConfig(home.dir).dispatchHosts?.h?.branchRules?.[0]?.base).toBe("origin/master");
	});

	test("an empty, metacharacter or non-string base is a config error", () => {
		for (const bad of ["", "a;b", "$(id)", "-x", "a b", 5, null]) {
			write([rule(bad)]);
			expect(() => loadConfig(home.dir), JSON.stringify(bad)).toThrow("dispatchHosts.h.branchRules[0].base");
		}
	});
});
