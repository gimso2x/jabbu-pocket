import { afterEach, expect, test } from "bun:test";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { taskChangedPaths } from "../src/tasks/progress-evidence";
import { git, makeRepo } from "./helpers/git-fixtures";

const repos: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const realRun: ProcessRunner = async (cmd, opts) => {
	const run = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
	return { code: run.exitCode ?? 1, stdout: run.stdout.toString(), timedOut: false };
};

const BODY = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

test("a staged rename lists the new and the old path, once each", async () => {
	const dir = makeRepo(repos);
	writeFileSync(join(dir, "a.txt"), BODY);
	git(dir, "add", "a.txt");
	git(dir, "commit", "-q", "-m", "a");
	git(dir, "mv", "a.txt", "b.txt");
	const changed = await taskChangedPaths(dir, realRun);
	expect(changed).toEqual({ ok: true, paths: ["a.txt", "b.txt"] });
});

test("an intent-to-add rename (the rename flag sits in the worktree column) adds no clipped path", async () => {
	const dir = makeRepo(repos);
	writeFileSync(join(dir, "a.txt"), BODY);
	git(dir, "add", "a.txt");
	git(dir, "commit", "-q", "-m", "a");
	renameSync(join(dir, "a.txt"), join(dir, "b.txt"));
	git(dir, "add", "-N", "b.txt");
	expect(git(dir, "status", "--porcelain", "-z").startsWith(" R b.txt\0a.txt\0")).toBe(true);
	const changed = await taskChangedPaths(dir, realRun);
	expect(changed).toEqual({ ok: true, paths: ["a.txt", "b.txt"] });
});
