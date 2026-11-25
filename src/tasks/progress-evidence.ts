import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dispatchEnv, type ProcessRunner } from "../dispatch/omp";

/** A task's own docs never count as a file overlap: every task writes its own `docs/tasks/<ID>/`. */
export const TASK_DOCS_PREFIX = "docs/tasks/";
/** `git -C <worktree> …` for the sweep's read-only questions: stdout, or `undefined` on a failure or timeout. */
const worktreeGit =
	(worktree: string, run: ProcessRunner) =>
	async (...args: string[]): Promise<string | undefined> => {
		const result = await run(["git", "-C", worktree, ...args], {
			timeoutMs: 10_000,
			stdoutCap: 1_000_000,
			env: dispatchEnv(process.env),
		});
		// A capped read is a prefix of the real output: hashing or parsing it as complete would freeze the
		// evidence key (or invent partial paths), so it counts as unreadable like any other git failure.
		return result.code === 0 && !result.timedOut && result.truncated !== true ? result.stdout : undefined;
	};

/**
 * Files a local task worktree changes against its base: the branch diff since the merge base plus uncommitted and
 * untracked files, `docs/tasks/**` left out, sorted. The base is `origin/HEAD`, else `main`, else `master`.
 */
export async function taskChangedPaths(
	worktree: string,
	run: ProcessRunner,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
	const git = worktreeGit(worktree, run);
	let base = (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD"))?.trim();
	for (const candidate of ["main", "master"]) {
		if (base !== undefined) break;
		if ((await git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`)) !== undefined) base = candidate;
	}
	if (base === undefined) return { ok: false, reason: "no_base_branch" };
	const mergeBase = (await git("merge-base", base, "HEAD"))?.trim();
	if (mergeBase === undefined) return { ok: false, reason: "merge_base_failed" };
	const diff = await git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", mergeBase);
	if (diff === undefined) return { ok: false, reason: "diff_failed" };
	const status = await git("status", "--porcelain", "-z", "--untracked-files=all");
	if (status === undefined) return { ok: false, reason: "status_failed" };
	const paths = new Set(diff.split("\0").filter((path) => path !== ""));
	// `XY path` records; a rename or copy is followed by its source path as its own record.
	const records = status.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record === "") continue;
		paths.add(record.slice(3));
		if (/^(?:[RC]|.[RC])/.test(record)) {
			i += 1;
			const source = records[i];
			if (source) paths.add(source);
		}
	}
	return { ok: true, paths: [...paths].filter((path) => !path.startsWith(TASK_DOCS_PREFIX)).sort() };
}

/** PROGRESS.md text without its `updated` line: a worker that only rewrote the clock moved nothing else. */
export function progressWithoutUpdated(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*updated:/.test(line))
		.join("\n");
}

/**
 * A local task's progress evidence: one hash over what moved in its worktree since the last sweep - `HEAD`, the
 * uncommitted diff, the untracked files' paths·sizes·mtimes, and PROGRESS.md without its `updated` line. A worker
 * that rewrites only `updated` leaves the key unchanged, so the stale clock is not pushed back by it
 *. `ok: false` when the worktree cannot be read (remote task, no worktree, a
 * git failure): the caller then keeps the old time-based behavior. Its PROGRESS.md (under `docsDir`) is left out of the
 * diff only when it is inside the worktree (records mode keeps it outside).
 */
export async function taskProgressEvidence(
	{ worktree, docsDir }: { worktree: string; docsDir: string },
	run: ProcessRunner,
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
	const progressFile = `${docsDir}/PROGRESS.md`;
	const inside = progressFile.startsWith(`${worktree}/`);
	const progressPath = relative(worktree, progressFile);
	const git = worktreeGit(worktree, run);
	const head = (await git("rev-parse", "HEAD"))?.trim();
	if (head === undefined) return { ok: false, reason: "no_head" };
	// The whole diff, so that a change to a file's content alone moves the key even with the path unchanged.
	const diff = await git(
		"diff",
		"HEAD",
		"--no-ext-diff",
		"--no-textconv",
		"--",
		".",
		...(inside ? [`:(exclude)${progressPath}`] : []),
	);
	if (diff === undefined) return { ok: false, reason: "diff_failed" };
	const untracked = await git("ls-files", "--others", "--exclude-standard", "-z");
	if (untracked === undefined) return { ok: false, reason: "untracked_failed" };
	// PROGRESS.md is left out here (its mtime moves with every write), counted through its content below instead.
	const files = untracked
		.split("\0")
		.filter((path) => path !== "" && path !== progressPath)
		.sort()
		.map((path) => {
			try {
				const stat = statSync(join(worktree, path));
				return `${path}\t${stat.size}\t${Math.floor(stat.mtimeMs)}`;
			} catch {
				return path;
			}
		});
	let body: string;
	try {
		body = progressWithoutUpdated(readFileSync(progressFile, "utf8"));
	} catch {
		// No PROGRESS.md yet: HEAD, the diff and the untracked files are all the evidence there is.
		body = "";
	}
	const key = createHash("sha256")
		.update([head, diff, files.join("\n"), body].join("\0"))
		.digest("hex");
	return { ok: true, key };
}
