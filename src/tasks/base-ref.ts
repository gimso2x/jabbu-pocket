import type { BranchRule } from "../config";
import { redactThenClip } from "../redact";
import { assertBranchSafe, branchProblem, branchRuleFor, parseBranchArg } from "./branch";
import { TaskSpecError } from "./spec-error";

/** The base a task's worktree forks from when neither `taskSpec.base` nor a branch rule names one. */
export const DEFAULT_BASE = "HEAD";

/** The base a task's worktree forked from: the ref as given and the commit it resolved to. */
export interface BaseInfo {
	ref: string;
	sha: string;
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Why `base` must not reach git, `undefined` when it may: a commit id, or a ref under the branch-name safety rules. */
export function baseProblem(base: string): string | undefined {
	if (COMMIT_ID.test(base)) return undefined;
	return branchProblem(base)?.replace("브랜치 이름", "기준 ref");
}

/** `taskSpec.branch` and `taskSpec.base` as given (new registrations only), each trimmed; absent ones are left out. Safety is judged by {@link resolveTaskBase}. */
export function parseBranchBase(record: Record<string, unknown>): { branch?: string; base?: string } {
	const branch = parseBranchArg(record.branch);
	const { base } = record;
	if (base !== undefined && (typeof base !== "string" || base.trim() === ""))
		throw new TaskSpecError("taskSpec.base는 비어 있지 않은 문자열이어야 합니다");
	return {
		...(branch === undefined ? {} : { branch }),
		...(base === undefined ? {} : { base: (base as string).trim() }),
	};
}

/** The base a new task forks from: `taskSpec.base`, else the covering rule's `base`, else `HEAD`; throws when it is unsafe. */
export function resolveTaskBase(
	rules: readonly BranchRule[] | undefined,
	repo: string,
	base: string | undefined,
): string {
	const ref = base ?? branchRuleFor(rules, repo)?.base ?? DEFAULT_BASE;
	const problem = baseProblem(ref);
	if (problem !== undefined) throw new Error(`taskSpec.base를 쓸 수 없습니다: ${ref} (${problem})`);
	return ref;
}

/** `기준: <ref> (<sha7>)`, the line context.md, the accepted card and the owner read. */
export const baseLine = (base: BaseInfo): string => `기준: ${base.ref} (${base.sha.slice(0, 7)})`;

/** spec.md frontmatter lines for the base (flat YAML keys); none without one. */
export const baseFrontmatter = (base: BaseInfo | undefined): string[] =>
	base === undefined ? [] : [`base: ${base.ref}`, `baseSha: ${base.sha}`];

type GitRun = { code: number | null; stdout: string; timedOut: boolean };

/**
 * Creates the task worktree from `base` (`HEAD` when absent): fetches a remote-tracking base first, resolves it to a
 * commit and forks `branch` from that commit with `--no-track`. A failed fetch or an unresolvable base is an error, never
 * a silent fallback to an older local ref.
 */
export async function createBasedWorktree(
	git: (argv: string[]) => Promise<GitRun>,
	input: { repo: string; worktree: string; branch: string; base?: string },
): Promise<{ ok: true; value: null } | { ok: false; error: string }> {
	const { repo, worktree, branch } = input;
	const base = input.base ?? DEFAULT_BASE;
	assertBranchSafe(branch);
	const problem = baseProblem(base);
	if (problem !== undefined) throw new Error(`unsafe base: ${base} (${problem})`);
	const failure = (what: string, result: GitRun) => ({
		ok: false as const,
		error: `${what} failed: ${redactThenClip(result.stdout.trim(), 200)}`,
	});
	const ok = (result: GitRun) => result.code === 0 && !result.timedOut;
	if (base.includes("/")) {
		const remotes = await git(["git", "-C", repo, "remote"]);
		if (!ok(remotes)) return failure("git remote", remotes);
		const remote = remotes.stdout
			.split("\n")
			.map((name) => name.trim())
			.filter((name) => name !== "" && base.startsWith(`${name}/`))
			.sort((a, b) => b.length - a.length)[0];
		if (remote !== undefined) {
			const name = base.slice(remote.length + 1);
			const fetched = await git([
				"git",
				"-C",
				repo,
				"fetch",
				"--quiet",
				remote,
				`+refs/heads/${name}:refs/remotes/${remote}/${name}`,
			]);
			if (!ok(fetched)) return failure(`git fetch ${remote}`, fetched);
		}
	}
	const resolved = await git(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
	const sha = resolved.stdout.trim().split("\n").pop() ?? "";
	if (!ok(resolved) || !COMMIT_ID.test(sha)) {
		const detail = resolved.stdout.trim();
		return {
			ok: false,
			error: `기준 ref를 찾을 수 없습니다: ${base}${detail === "" ? "" : ` (${redactThenClip(detail, 200)})`}`,
		};
	}
	const added = await git(["git", "-C", repo, "worktree", "add", "--no-track", "-b", branch, worktree, sha]);
	return ok(added) ? { ok: true, value: null } : failure("git worktree add", added);
}
