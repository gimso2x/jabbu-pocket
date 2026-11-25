import type { Logger } from "../log";

/**
 * The HEAD of each configured repository before and after a conversation turn: a turn that moved one (it committed)
 * reaches the wiki turn notes. Only `git rev-parse HEAD` runs; the index, HEAD and the work tree are never touched. A
 * failed read is logged and skipped — it never blocks the turn.
 */

export interface GitOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitRunOptions {
	/** Extra environment for this call. */
	env?: Record<string, string>;
	timeoutMs?: number;
}

export type GitRunner = (repo: string, args: readonly string[], options?: GitRunOptions) => Promise<GitOutcome>;

/** How long one git call may take before that repository is skipped. */
const GIT_TIMEOUT_MS = 5_000;

/** No call here means a pathspec pattern: a file named `:(glob)**` is that one file, not every file (qa-d M-1). */
const LITERAL_PATHSPECS = { GIT_LITERAL_PATHSPECS: "1" };

/**
 * Runs git in `repo`; a timeout is a non-zero outcome, never a throw (the caller decides what a failure means). An
 * inherited `GIT_*` (`GIT_DIR`, `GIT_WORK_TREE`) would point git at another repository, so none is passed on; extra
 * environment comes in through `options.env` only (qa-j #23). git runs in its own process group: at the deadline the
 * whole group (a clean filter and what it started, which hold the pipes) is killed and the pipes are abandoned
 * (qa-j #70/#22).
 */
export const runGit: GitRunner = async (repo, args, options = {}) => {
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
	// The daemon's environment without any `GIT_*`: an inherited `GIT_DIR`/`GIT_WORK_TREE` would retarget git.
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	let timer: Timer | undefined;
	try {
		const proc = Bun.spawn(["git", "-C", repo, ...args], {
			env: { ...inherited, ...options.env, ...LITERAL_PATHSPECS },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		const timedOut = Promise.withResolvers<"timeout">();
		timer = setTimeout(() => {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				proc.kill("SIGKILL");
			}
			timedOut.resolve("timeout");
		}, timeoutMs);
		const finished = Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		] as const);
		const outcome = await Promise.race([finished, timedOut.promise]);
		if (outcome === "timeout") {
			finished.catch(() => undefined);
			return { code: 124, stdout: "", stderr: `git ${args[0] ?? ""} timed out after ${timeoutMs}ms` };
		}
		const [stdout, stderr, code] = outcome;
		return { code: code ?? 1, stdout, stderr };
	} catch (error) {
		return { code: 124, stdout: "", stderr: `git ${args[0] ?? ""} failed: ${String(error)}` };
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Only the HEAD of each repository, in parallel (a commit moves the head; uncommitted work does not count). A
 * repository that fails is logged as `turn_head_failed` and left out.
 */
export async function captureHeads(
	repos: readonly string[],
	options: { run?: GitRunner; log?: Logger } = {},
): Promise<Map<string, string>> {
	const run = options.run ?? runGit;
	const heads = new Map<string, string>();
	await Promise.all(
		repos.map(async (repo) => {
			const outcome = await run(repo, ["rev-parse", "HEAD"]);
			if (outcome.code === 0) heads.set(repo, outcome.stdout.trim());
			else
				options.log?.warn("turn_head_failed", {
					repo,
					error: `git rev-parse HEAD: ${outcome.stderr.trim() || `exit ${outcome.code}`}`,
				});
		}),
	);
	return heads;
}
