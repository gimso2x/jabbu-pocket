import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BranchRule, loadConfig } from "../src/config";
import type { ProcessRunner } from "../src/dispatch/omp";
import { branchProblem, branchRuleFor, resolveTaskBranch } from "../src/tasks/branch";
import { createTaskHostOps } from "../src/tasks/host";
import { removeRemoteWorktree } from "../src/tasks/host-sync";
import { makeHome, type TestHome } from "./helpers/bot-home";

const HANGUL = "feature/202611-배너교체";
const COMPANY: BranchRule = {
	repoPrefix: "/home/dev/repo/",
	exclude: ["/home/dev/repo/personal"],
	pattern: "^(feature/\\d{6}|hotfix/\\d{8})-[^\\s/]+$",
	example: "feature/YYYYMM-기능명",
};

describe("AC-6: repoPrefix path boundary and exclude", () => {
	test("a repository matches on a path boundary only", () => {
		expect(branchRuleFor([COMPANY], "/home/dev/repo/web-app")).toBe(COMPANY);
		expect(branchRuleFor([COMPANY], "/home/dev/repo")).toBe(COMPANY);
		expect(branchRuleFor([COMPANY], "/home/dev/repo-x")).toBeUndefined();
		expect(branchRuleFor([COMPANY], "/home/dev/repository/app")).toBeUndefined();
	});

	test("exclude leaves a repository (and what is under it) out, on a boundary too", () => {
		expect(branchRuleFor([COMPANY], "/home/dev/repo/personal")).toBeUndefined();
		expect(branchRuleFor([COMPANY], "/home/dev/repo/personal/")).toBeUndefined();
		expect(branchRuleFor([COMPANY], "/home/dev/repo/personal-2")).toBe(COMPANY);
	});

	test("the longest matching prefix wins", () => {
		const inner: BranchRule = { ...COMPANY, repoPrefix: "/home/dev/repo/web", pattern: "^web/.+$" };
		expect(branchRuleFor([COMPANY, inner], "/home/dev/repo/web/app")).toBe(inner);
		expect(branchRuleFor([inner, COMPANY], "/home/dev/repo/other")).toBe(COMPANY);
	});
});

describe("AC-2/AC-3: resolveTaskBranch", () => {
	const repo = "/home/dev/repo/web-app";
	test("a rule demands a matching branch and shows its example", () => {
		expect(() => resolveTaskBranch([COMPANY], repo, undefined)).toThrow("feature/YYYYMM-기능명");
		expect(() => resolveTaskBranch([COMPANY], repo, "task/x")).toThrow("feature/YYYYMM-기능명");
		expect(resolveTaskBranch([COMPANY], repo, HANGUL)).toBe(HANGUL);
		expect(resolveTaskBranch([COMPANY], repo, "hotfix/20261127-긴급")).toBe("hotfix/20261127-긴급");
	});
	test("without a rule: absent → default, given → that name, unsafe → refused", () => {
		expect(resolveTaskBranch([COMPANY], "/home/dev/repo/personal", undefined)).toBeUndefined();
		expect(resolveTaskBranch(undefined, repo, "my/branch")).toBe("my/branch");
		expect(() => resolveTaskBranch(undefined, repo, "a;b")).toThrow("taskSpec.branch");
	});
	test("a matching pattern still passes the common safety check", () => {
		const loose: BranchRule = { ...COMPANY, pattern: ".*" };
		expect(() => resolveTaskBranch([loose], repo, "feature/202611-a$(id)")).toThrow("taskSpec.branch");
	});
});

describe("AC-5: one branch safety check for worktree, land and cleanup", () => {
	test("Hangul and the old task/lane names pass", () => {
		for (const ok of [HANGUL, "task/T-20261127-04", "lane/L-20261127-01", "main", "release/1.2"]) {
			expect(branchProblem(ok), ok).toBeUndefined();
		}
	});
	test("shell metacharacters, options, whitespace and bad ref shapes are refused", () => {
		for (const bad of [
			"",
			"-D",
			"a b",
			"a\tb",
			"a\nb",
			"a;b",
			"a&b",
			"a|b",
			"a<b",
			"a>b",
			"a'b",
			'a"b',
			"a`b",
			"a$(id)",
			"a\\b",
			"a..b",
			"a//b",
			"a/",
			"/a",
			"a.lock",
			"a/.b",
			"a.",
			"a@{1}",
			"a:b",
			"a~b",
			"a*b",
			`feature/${"가".repeat(201)}`,
		]) {
			expect(branchProblem(bad), JSON.stringify(bad)).toBeDefined();
		}
	});

	const record = () => {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", timedOut: false };
		};
		return { calls, run };
	};

	test("ssh worktree create, cleanup and diff carry the Hangul branch single-quoted", async () => {
		const { calls, run } = record();
		const ops = createTaskHostOps({ run, sshTarget: "wsl" });
		const git = { repo: "/home/dev/repo/app", worktree: "/home/dev/repo/app-t-1", branch: HANGUL };
		expect(await ops.createWorktree(git)).toEqual({ ok: true, value: null });
		await ops.removeWorktree(git);
		expect(calls[0]?.slice(7, -1)).toEqual([
			"'git'",
			"'-C'",
			"'/home/dev/repo/app'",
			"'worktree'",
			"'add'",
			"'-b'",
			`'${HANGUL}'`,
			"'/home/dev/repo/app-t-1'",
			"'HEAD'",
		]);
		expect(calls.some((c) => c.includes(`'${HANGUL}'`) && c.includes("'-D'"))).toBe(true);
		// Every remote word is quoted: nothing but the trailing `2>&1` reaches the remote shell bare.
		for (const cmd of calls) for (const word of cmd.slice(7, -1)) expect(word).toMatch(/^'.*'$/s);
	});

	test("an unsafe branch never reaches ssh", async () => {
		const { calls, run } = record();
		const ops = createTaskHostOps({ run, sshTarget: "wsl" });
		const git = { repo: "/r/app", worktree: "/r/app-t-1" };
		for (const branch of ["a;rm -rf ~", "x$(id)", "-b", "a b"]) {
			await expect(ops.createWorktree({ ...git, branch })).rejects.toThrow("unsafe branch");
			await expect(ops.removeWorktree({ ...git, branch })).rejects.toThrow("unsafe branch");
		}
		expect(calls).toEqual([]);
	});

	test("remote cleanup accepts the Hangul branch and refuses a metacharacter one", async () => {
		const { calls, run } = record();
		const input = { repo: "/home/dev/repo/app", worktree: "/home/dev/repo/app-t-1", branch: HANGUL };
		expect(await removeRemoteWorktree(run, "wsl", input)).toBeUndefined();
		expect(calls.length).toBeGreaterThan(0);
		const before = calls.length;
		expect(await removeRemoteWorktree(run, "wsl", { ...input, branch: "x;id" })).toContain("거절");
		expect(calls).toHaveLength(before);
	});
});

describe("AC-4: invalid branchRules are config errors", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("jabbu-branch-rules-");
	});
	afterEach(() => home.remove());

	function write(branchRules: unknown): void {
		const path = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...config, herdr: {}, dispatchHosts: { h: { ssh: "h", branchRules } } }), {
			mode: 0o600,
		});
	}

	test("a valid rule loads", () => {
		write([COMPANY]);
		expect(loadConfig(home.dir).dispatchHosts?.h?.branchRules).toEqual([COMPANY]);
	});

	test("regex error, relative or unsafe prefix, unknown key, wrong shapes are refused", () => {
		for (const bad of [
			[{ ...COMPANY, pattern: "(" }],
			[{ ...COMPANY, pattern: "" }],
			[{ ...COMPANY, repoPrefix: "repo/" }],
			[{ ...COMPANY, repoPrefix: "/home/../etc" }],
			[{ ...COMPANY, exclude: ["rel"] }],
			[{ ...COMPANY, exclude: "/a" }],
			[{ ...COMPANY, prefix: "/x" }],
			[{ ...COMPANY, example: "" }],
			[{ repoPrefix: "/a/", pattern: "x" }],
			["rule"],
			{ repoPrefix: "/a/" },
		]) {
			write(bad);
			expect(() => loadConfig(home.dir), JSON.stringify(bad)).toThrow("dispatchHosts.h.branchRules");
		}
	});
});

describe("commitDocs under a repository commit-msg hook", () => {
	let root: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-branch-hook-")));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function repoWithHook(hook: string): string {
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", "-C", root, ...args]);
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		git("init", "-q", "-b", HANGUL);
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		const target = join(root, ".git", "hooks", "commit-msg");
		writeFileSync(target, hook);
		chmodSync(target, 0o755);
		mkdirSync(join(root, "docs", "tasks", "T-20261127-04"), { recursive: true });
		writeFileSync(join(root, "docs", "tasks", "T-20261127-04", "spec.md"), "x\n");
		return git("rev-parse", "--show-toplevel");
	}

	// A company hook: the message must open with `[<branch>]`.
	const HOOK = `#!/bin/sh\ncase "$(head -n1 "$1")" in "[$(git symbolic-ref --short HEAD)]"*) exit 0;; esac\necho "message must start with [branch]" >&2\nexit 1\n`;

	test("a hook that demands a [branch] head is met on the second try, with the Hangul branch", async () => {
		const worktree = repoWithHook(HOOK);
		const ops = createTaskHostOps({});
		const done = await ops.commitDocs({ worktree, taskId: "T-20261127-04", branch: HANGUL });
		expect(done.ok).toBe(true);
		const subject = Bun.spawnSync(["git", "-C", worktree, "log", "-1", "--format=%s"]).stdout.toString().trim();
		expect(subject).toBe(`[${HANGUL}] docs(task): T-20261127-04 4문서`);
	});

	test("without a hook the plain title is kept", async () => {
		const worktree = repoWithHook("#!/bin/sh\nexit 0\n");
		const done = await createTaskHostOps({}).commitDocs({ worktree, taskId: "T-20261127-04", branch: HANGUL });
		expect(done.ok).toBe(true);
		expect(Bun.spawnSync(["git", "-C", worktree, "log", "-1", "--format=%s"]).stdout.toString().trim()).toBe(
			"docs(task): T-20261127-04 4문서",
		);
	});

	test("a hook that refuses both messages is a failure, not a swallowed error", async () => {
		const worktree = repoWithHook("#!/bin/sh\necho nope >&2\nexit 1\n");
		const done = await createTaskHostOps({}).commitDocs({ worktree, taskId: "T-20261127-04", branch: HANGUL });
		expect(done).toMatchObject({ ok: false });
	});
});
