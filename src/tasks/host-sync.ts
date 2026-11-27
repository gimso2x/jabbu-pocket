import { existsSync } from "node:fs";
import { type ProcessRunner, remoteShellQuote } from "../dispatch/omp";
import { githubRepoOfUrl } from "../lanes/pr";
import { redactThenClip } from "../redact";
import { TASK_PATH_PATTERN } from "./docs";
import { sshCommand } from "./host";

/**
 * What the core does on a `dispatchHosts` host after a task's PR was merged:
 * remove the worktree and branch, bring the host's checkout of the base branch up to date. Apart from `TaskHostOps`
 * (whose `removeWorktree` is a best-effort rollback). Each call returns what could not be done as one line, or
 * `undefined`; a re-run after a cut-off one finds nothing left to do.
 */

const GIT_TIMEOUT_MS = 60_000;
/** ssh's own failure code (connection, auth). */
const SSH_FAILURE = 255;
const LINE_MAX = 200;
const REMOTE_NAME = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_CHARS = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** What git says of a worktree or branch that is gone already: for this call that is the wanted state. */
const ALREADY_GONE = /is not a working tree|not found|No such file or directory|does not exist/i;
/** A shell that could not even start git (`git: command not found`, exit 127) says nothing about the worktree or branch. */
const GIT_MISSING = /command not found|not recognized as an internal or external command/i;
/** `ls-files` on a worktree directory that is gone: only git's `cannot change to` means that, not any "No such file". */
const WORKTREE_DIR_GONE = /cannot change to .*No such file or directory|is not a working tree/i;
const alreadyGone = (lines: string[], gone: RegExp = ALREADY_GONE): boolean =>
	!lines.some((line) => GIT_MISSING.test(line)) && lines.some((line) => gone.test(line));

interface RemoteResult {
	code: number | null;
	/** stdout, then stderr, as lines. */
	lines: string[];
	/** ssh itself failed (the host could not be reached): nothing ran. */
	down: boolean;
}

const safePath = (path: string): boolean => TASK_PATH_PATTERN.test(path) && !path.includes("..");

/** A branch name that reaches git: plain characters, no `..`, `//`, empty or `.lock` part, no trailing `/`. */
function safeBranch(branch: string): boolean {
	if (!BRANCH_CHARS.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/"))
		return false;
	return branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith("."));
}

/** One command on the host: every word single-quoted for the remote shell, stderr folded into the output. */
async function remote(run: ProcessRunner, ssh: string, argv: string[]): Promise<RemoteResult> {
	const result = await run(sshCommand(ssh, [...argv.map(remoteShellQuote), "2>&1"]), { timeoutMs: GIT_TIMEOUT_MS });
	const lines = `${result.stdout}\n${result.stderr ?? ""}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return { code: result.code, lines, down: result.timedOut || result.code === null || result.code === SSH_FAILURE };
}

const unreachable = (result: RemoteResult): string =>
	`원격 호스트에 닿지 못함: ${redactThenClip(result.lines[0] ?? "응답 없음", 120)}`;

/** The line of a failed call worth showing: the one that says error or fatal, else the first. */
const failureOf = (result: RemoteResult, what: string): string =>
	`${what} 실패: ${redactThenClip(result.lines.find((line) => /error|fatal/i.test(line)) ?? result.lines[0] ?? `exit ${result.code}`, LINE_MAX)}`;

/** `git ls-files` listing every path git ignores in a worktree; a wholly ignored directory is one `dir/` line. */
const IGNORED_LIST_ARGS = ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"];
/** Ignored paths a cleanup may delete: dependency, build and cache output that is made again from the sources. */
const REBUILT_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".cache",
	".turbo",
	".next",
	"dist",
	"build",
	"target",
	"coverage",
]);
const REBUILT_FILE = /(?:\.pyc|\.pyo|\.tsbuildinfo|(?:^|\/)\.DS_Store)$/;
const KEPT_SHOWN = 5;

/**
 * The paths of an `IGNORED_LIST_ARGS` listing a cleanup must not delete unseen (a `.env`, local data, a worker's
 * notes): every ignored path but rebuilt output (`REBUILT_DIRS` anywhere in the path, `REBUILT_FILE`).
 */
function keptIgnoredOf(listing: string): string[] {
	return listing
		.split("\n")
		.map((line) => line.trim())
		.filter((path) => path !== "")
		.filter((path) => !REBUILT_FILE.test(path) && !path.split("/").some((part) => REBUILT_DIRS.has(part)));
}

/** Why the worktree stays: the kept ignored paths (count and the first few). */
const keptReason = (kept: string[], where: string): string =>
	`git이 무시하는 파일 ${kept.length}건(${redactThenClip(kept.slice(0, KEPT_SHOWN).join("; "), LINE_MAX)}${kept.length > KEPT_SHOWN ? "; …" : ""})이 있어 worktree를 지우지 않았습니다: ${where} — 옮길 것을 옮긴 뒤 손으로 지우세요`;

/**
 * The local twin of `removeRemoteWorktree`'s ignored-file check, for a lane or task landing on this machine: why its
 * cleanup must leave the worktree at `dir`, or `undefined` (nothing to keep, or no worktree at that path).
 */
export async function keptIgnoredNote(
	git: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
	dir: string,
): Promise<string | undefined> {
	if (!existsSync(dir)) return undefined;
	const listed = await git(["-C", dir, ...IGNORED_LIST_ARGS]);
	if (listed.code !== 0)
		return `git ls-files 실패(${dir}): ${redactThenClip(listed.stderr.trim().split("\n")[0] ?? "", LINE_MAX)} — worktree를 지우지 않았습니다. 확인 뒤 손으로 지우세요`;
	const kept = keptIgnoredOf(listed.stdout);
	return kept.length === 0 ? undefined : keptReason(kept, dir);
}

/**
 * `git worktree remove --force` and `git branch -D` in the task's repository on the host, both always tried (a worktree
 * that is gone must not leave its branch); a worktree or branch that is gone already counts as done. Neither runs while
 * the worktree holds ignored files that are not rebuilt output (`keptIgnoredOf`). Returns the first
 * failure line (an unreachable host: that), `undefined` when both are gone.
 */
export async function removeRemoteWorktree(
	run: ProcessRunner,
	sshTarget: string,
	input: { repo: string; worktree: string; branch: string },
): Promise<string | undefined> {
	const { repo, worktree, branch } = input;
	if (!safePath(repo) || !safePath(worktree) || !safeBranch(branch))
		return `원격 정리 거절: 위험한 경로·브랜치 이름(${repo} ${worktree} ${branch})`;
	const ignored = await remote(run, sshTarget, ["git", "-C", worktree, ...IGNORED_LIST_ARGS]);
	if (ignored.down) return unreachable(ignored);
	if (ignored.code !== 0 && !alreadyGone(ignored.lines, WORKTREE_DIR_GONE))
		return `${failureOf(ignored, "git ls-files")} — worktree를 지우지 않았습니다`;
	const kept = ignored.code === 0 ? keptIgnoredOf(ignored.lines.join("\n")) : [];
	if (kept.length > 0) return keptReason(kept, worktree);
	let first: string | undefined;
	const steps: [string, string[]][] = [
		["worktree 제거", ["git", "-C", repo, "worktree", "remove", "--force", worktree]],
		["branch -D", ["git", "-C", repo, "branch", "-D", branch]],
	];
	for (const [what, argv] of steps) {
		const result = await remote(run, sshTarget, argv);
		if (result.down) return first ?? unreachable(result);
		if (result.code === 0 || alreadyGone(result.lines)) continue;
		first ??= failureOf(result, what);
	}
	return first;
}

export interface RemoteBaseSync {
	/** The `dispatchHosts` key (names the host in the note). */
	host: string;
	/** The repository's path on the host. */
	repo: string;
	baseBranch: string;
	/** The host repository's remote the base branch is fetched from (`lanes.land` `remote`, default `origin`). */
	remote: string;
	/** `owner/name` the merge went into: the host repository's remote must be that one, or it is left alone. */
	expectedSlug: string;
}

/** The checkout of `refs/heads/<branch>` among `git worktree list --porcelain` blocks. */
function checkoutOfBranch(lines: string[], branch: string): string | undefined {
	let path: string | undefined;
	for (const line of lines) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
	}
	return undefined;
}

/**
 * Brings the host repository's base branch up to the remote's after the merge: a checkout of it that is clean gets
 * `merge --ff-only`, no checkout gets `update-ref`. The merge stands whatever happens here; what was not done is the
 * returned `merged-not-synced` line (a dirty checkout, a remote of another repository, a branch that is not an
 * ancestor, an unreachable host). Input with shell-special characters is refused before anything runs.
 */
export async function syncRemoteBase(
	run: ProcessRunner,
	sshTarget: string,
	input: RemoteBaseSync,
): Promise<string | undefined> {
	const { host, repo, baseBranch, remote: name, expectedSlug } = input;
	if (!safePath(repo) || !safeBranch(baseBranch) || !REMOTE_NAME.test(name)) {
		return `merged-not-synced: 원격 ${host} 갱신 거절 — 위험한 저장소·브랜치·원격 이름`;
	}
	const note = (why: string) => `merged-not-synced: 원격 ${host} ${repo} 갱신 필요 — ${why}`;
	const git = (...args: string[]) => remote(run, sshTarget, ["git", "-C", repo, ...args]);
	const url = await git("remote", "get-url", name);
	if (url.down) return note(unreachable(url));
	const slug = url.code === 0 ? githubRepoOfUrl(url.lines[0] ?? "") : undefined;
	if (slug?.toLowerCase() !== expectedSlug.toLowerCase())
		return note(`원격 ${name}가 ${expectedSlug}가 아님(${slug ?? "알 수 없음"})`);
	const fetched = await git("fetch", name, baseBranch);
	if (fetched.down) return note(unreachable(fetched));
	if (fetched.code !== 0) return note(failureOf(fetched, `fetch ${name} ${baseBranch}`));
	const tracking = `${name}/${baseBranch}`;
	const listed = await git("worktree", "list", "--porcelain");
	if (listed.code !== 0) return note(failureOf(listed, "worktree list"));
	const checkout = checkoutOfBranch(listed.lines, baseBranch);
	if (checkout !== undefined) {
		const status = await remote(run, sshTarget, [
			"git",
			"-C",
			checkout,
			"status",
			"--porcelain",
			"--untracked-files=all",
		]);
		if (status.code !== 0) return note(failureOf(status, "status"));
		if (status.lines.length > 0) return note(`${checkout}에 미커밋 변경 ${status.lines.length}건`);
		const merged = await remote(run, sshTarget, ["git", "-C", checkout, "merge", "--ff-only", tracking]);
		return merged.code === 0 ? undefined : note(failureOf(merged, "merge --ff-only"));
	}
	const rev = async (ref: string) => {
		const result = await git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
		return result.code === 0 ? result.lines[0] : undefined;
	};
	const current = await rev(`refs/heads/${baseBranch}`);
	const target = await rev(`refs/remotes/${tracking}`);
	if (current === undefined || target === undefined || current === target) return undefined;
	if ((await git("merge-base", "--is-ancestor", current, target)).code !== 0) {
		return note(`${baseBranch}가 ${tracking}의 조상이 아님`);
	}
	const moved = await git("update-ref", `refs/heads/${baseBranch}`, target, current);
	return moved.code === 0 ? undefined : note(failureOf(moved, "update-ref"));
}
