import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchEnv } from "../src/dispatch/omp";
import { createTaskHostOps } from "../src/tasks/host";

const git = (dir: string, ...args: string[]): string =>
	execFileSync("git", ["-C", dir, ...args], { env: dispatchEnv(process.env), encoding: "utf8" }).trim();

let root: string;
let repo: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-host-hidden-")));
	repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo], { env: dispatchEnv(process.env) });
	git(repo, "config", "user.name", "t");
	git(repo, "config", "user.email", "t@example.test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "a.txt"), "task a\n");
	writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n");
	chmodSync(join(repo, "run.sh"), 0o755);
	git(repo, "add", "a.txt", "run.sh");
	git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("headOf hidden changes (the remote landing's cleanliness gate)", () => {
	const headOf = () => createTaskHostOps().headOf(repo);

	test("a clean worktree reads clean", async () => {
		const head = await headOf();
		expect(head.clean).toBe(true);
		expect(head.sha).toBe(git(repo, "rev-parse", "HEAD"));
	});

	test("a plain uncommitted edit reads not clean (as before)", async () => {
		writeFileSync(join(repo, "a.txt"), "edited\n");
		expect((await headOf()).clean).toBe(false);
	});

	test("an --assume-unchanged edit status hides reads not clean", async () => {
		git(repo, "update-index", "--assume-unchanged", "a.txt");
		writeFileSync(join(repo, "a.txt"), "hidden edit\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect((await headOf()).clean).toBe(false);
	});

	test("a --skip-worktree edit status hides reads not clean", async () => {
		git(repo, "update-index", "--skip-worktree", "a.txt");
		writeFileSync(join(repo, "a.txt"), "hidden edit\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect((await headOf()).clean).toBe(false);
	});

	test("a flag without an edit still reads clean", async () => {
		git(repo, "update-index", "--assume-unchanged", "a.txt");
		git(repo, "update-index", "--skip-worktree", "run.sh");
		expect((await headOf()).clean).toBe(true);
	});

	test("an execute-bit change under --assume-unchanged reads not clean", async () => {
		git(repo, "update-index", "--assume-unchanged", "a.txt");
		chmodSync(join(repo, "a.txt"), 0o755);
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect((await headOf()).clean).toBe(false);
	});
});
