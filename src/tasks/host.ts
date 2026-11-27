import { constants, existsSync, realpathSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
	DEFAULT_STDOUT_CAP,
	dispatchEnv,
	type ProcessRunner,
	realProcessRunner,
	remoteShellQuote,
} from "../dispatch/omp";
import { redactThenClip } from "../redact";
import type { CommitCheck } from "./checker";
import { TASK_PATH_PATTERN, taskDocsCommitTitle } from "./docs";
import { isFullTestArgv } from "./full-test";
import { hiddenOnHost } from "./host-hidden";

export type HostResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Task-branch diffs are collected whole (still `--unified=0`, still without `docs/tasks`): the integrity classifier
 * is local string work with no model context, and a real task branch (T-20261109-04) measured ~150 KB. Past this a
 * task keeps the commit-unit review hand-off instead of an ever-larger read.
 */
const DIFF_STDOUT_CAP = 512_000;
const GIT_TIMEOUT_MS = 60_000;
const IO_TIMEOUT_MS = 20_000;
const HEX_HASH = /^[0-9a-f]{7,40}$/;
/** A full object name (sha1 or sha256) as `rev-parse` and `log --format=%H` print it. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TASK_ID = /^T-\d{8}-\d{2,}$/;

/** ssh's own failure code (connection, auth); a remote command's code never is 255 here. */
const SSH_FAILURE = 255;

/** File and git operations of a task on one machine (the bot's own, or a `dispatchHosts` entry over ssh). */
export interface TaskHostOps {
	pathExists(path: string): Promise<HostResult<boolean>>;
	/** `git -C <repo> worktree add -b <branch> <worktree> HEAD`; fails when the branch or path already exists. */
	createWorktree(input: { repo: string; worktree: string; branch: string }): Promise<HostResult<null>>;
	/** Best-effort removal of a worktree and its branch (a failed registration, a landed or discarded lane). */
	removeWorktree(input: { repo: string; worktree: string; branch: string }): Promise<void>;
	/** Best-effort removal of a failed start's records directory (a `…/docs/tasks/<id>` path only). */
	removeRecords(dir: string): Promise<void>;
	/** Creates parent directories; refuses to overwrite an existing file. */
	writeFile(path: string, content: string): Promise<HostResult<null>>;
	/** `value: undefined` = the file does not exist; an unreachable host is a failure, never "missing". */
	readFile(path: string): Promise<HostResult<string | undefined>>;
	/**
	 * `readFile` as the file's bytes (a `sha256` file check hashes them); over ssh they travel as base64. On the local host only
	 * a regular file is read (a symlink, FIFO or device is a failure, never a wait) and `within` keeps the read inside
	 * that directory.
	 */
	readBytes(path: string, within?: string): Promise<HostResult<Uint8Array | undefined>>;
	/**
	 * Whether `hash` is a commit in `baseSha..branch` (the task row's base, never the base itself); throws when the host
	 * cannot be asked or git fails unexpectedly (never answers "no" for "unknown").
	 */
	commitOnTaskBranch(input: { worktree: string; branch: string; baseSha: string; hash: string }): Promise<CommitCheck>;
	/**
	 * `git diff <baseSha>..<branch> --unified=0` (the range `commitOnTaskBranch` measures). `diff too large` at its own
	 * (raised) stdout cap, any git or host failure as its error — never an empty diff for "unknown".
	 */
	branchDiff(input: { worktree: string; branch: string; baseSha: string }): Promise<HostResult<string>>;
	/** Commits `docs/tasks/<taskId>` on the worktree's branch as its first commit (`taskDocsCommitTitle`); the value is the hash. */
	commitDocs(input: { worktree: string; taskId: string }): Promise<HostResult<string>>;
	/** A `doc/plans/<name>.md` a task names: a regular file inside `recordsRepo` when set, else `<worktree>/<path>` on its host. */
	readPlan(path: string, worktree: string): Promise<HostResult<string | undefined>>;
	/**
	 * A `[check: command …]`: `argv` without a shell, cwd `worktree` (ssh: `cd` then each argument single-quoted),
	 * killed after `timeoutMs` or when `signal` aborts. `output` is stdout then stderr. Throws when the host cannot be
	 * reached.
	 */
	runCheck(input: { worktree: string; argv: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<CheckRun>;
	/** The worktree's HEAD commit and whether it is clean (status empty, no flag-hidden edit); throws when git cannot answer. */
	headOf(worktree: string): Promise<{ sha: string; clean: boolean }>;
}

/**
 * Resume-time reads of a task worktree (`resumeTask` only), apart from `TaskHostOps` so its read-only fakes elsewhere
 * (the dashboard's) need not answer them.
 */
export interface TaskResumeOps {
	/**
	 * Where PROGRESS.md was last committed and what came after it: `git log -1 -- docs/tasks/<id>/PROGRESS.md`, the
	 * commits since then outside `docs/tasks/`, and `git status --porcelain`. A `progressFile` outside the worktree
	 * (records mode) is measured by its mtime instead. Any git or host failure is `ok: false`.
	 */
	progressLag(input: { worktree: string; taskId: string; progressFile: string }): Promise<HostResult<ProgressLag>>;
}

/** How far PROGRESS.md trails the worktree, measured from its last commit (`progressLag`). */
export interface ProgressLag {
	/** Short hash of the last commit touching `docs/tasks/<id>/PROGRESS.md`; `""` when never committed or outside the worktree. */
	progressCommit: string;
	/** Commits in `progressCommit..HEAD` outside `docs/tasks/` (records mode: commits since PROGRESS.md's mtime). */
	codeCommitsSince: number;
	/** PROGRESS.md has uncommitted changes. */
	progressDirty: boolean;
	/** Other uncommitted paths (`git status --porcelain` entries besides PROGRESS.md). */
	otherDirty: number;
}

export interface CheckRun {
	code: number | null;
	output: string;
	timedOut: boolean;
	/** The output reached the collection cap: what follows the kept head is lost. */
	truncated?: boolean;
}

/** stdout kept of one check: a test runner's summary comes last, so the cap is far above the 64KB default. */
const CHECK_STDOUT_CAP = 8_000_000;

export interface TaskHostOptions {
	/** ssh target; absent = the bot's own machine. */
	sshTarget?: string;
	/** Config `recordsRepo`: `readPlan` reads `doc/plans` from this local checkout. */
	recordsRepo?: string | undefined;
	run?: ProcessRunner;
	inheritedEnv?: Record<string, string | undefined>;
}

/** Seconds a `[check:]` run may wait for the heavy-run lock beyond its own timeout: expiry then always ends as `timedOut`. */
const HEAVY_RUN_WAIT_SLACK_S = 60;
const HEAVY_RUN = "scripts/heavy-run";

/** PATH assignment a remote `[check:]` line exports first; double quotes so the remote shell expands `$HOME`/`$PATH`. */
const REMOTE_CHECK_PATH = 'PATH="$HOME/.local/bin:$PATH"';

export function sshCommand(sshTarget: string, remote: string[]): string[] {
	return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", sshTarget, ...remote];
}

function assertPath(...paths: string[]): void {
	for (const path of paths) if (!TASK_PATH_PATTERN.test(path)) throw new Error(`unsafe path: ${path}`);
}

/** A task branch (`task/T-YYYYMMDD-NN`) or a work lane's branch (`lane/L-YYYYMMDD-NN`); nothing else reaches git. */
function assertBranch(branch: string): void {
	if (!/^(?:task\/T|lane\/L)-\d{8}-\d{2,}$/.test(branch)) throw new Error(`unsafe branch: ${branch}`);
}

/** A task row's `baseSha`: a full object name, never an option or a range. */
function assertSha(sha: string): void {
	if (!FULL_HASH.test(sha)) throw new Error(`unsafe base sha: ${sha}`);
}

/**
 * A regular file's bytes, read without ever blocking or following the last path component: a FIFO opens at once
 * (`O_NONBLOCK`) and is refused by `fstat`, a symlink fails to open (`O_NOFOLLOW`), `/dev/zero` is not a regular file.
 * With `within`, the file's directory must resolve inside that directory (a symlinked directory leads out of it).
 * `undefined` = the path does not exist.
 */
export async function readRegularFile(path: string, within?: string): Promise<Buffer | undefined> {
	if (within !== undefined) {
		let real: string;
		let root: string;
		try {
			real = realpathSync(dirname(path));
			root = realpathSync(within);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (real !== root && !real.startsWith(`${root}${sep}`)) throw new Error(`${path} is outside ${within}`);
	}
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		if (code === "ELOOP") throw new Error(`${path} is a symbolic link, not a regular file`);
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a regular file`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

const fail = (error: unknown): { ok: false; error: string } => ({
	ok: false,
	error: error instanceof Error ? error.message : String(error),
});

export function createTaskHostOps(options: TaskHostOptions = {}): TaskHostOps & TaskResumeOps {
	const run = options.run ?? realProcessRunner;
	const { sshTarget } = options;
	const env = dispatchEnv(options.inheritedEnv ?? process.env);

	/** One command on the host, stderr folded into stdout so a git error reaches the report. */
	const exec = (argv: string[], timeoutMs: number, stdoutCap?: number) =>
		sshTarget === undefined
			? run(["sh", "-c", 'exec "$@" 2>&1', "sh", ...argv], { timeoutMs, env, stdoutCap })
			: run(sshCommand(sshTarget, [...argv, "2>&1"]), { timeoutMs, stdoutCap });
	const unreachable = (result: { code: number | null; timedOut: boolean }): boolean =>
		result.timedOut || result.code === null || (sshTarget !== undefined && result.code === SSH_FAILURE);
	/** ssh writes its own connection errors to stderr; the remote command's output is on stdout. */
	const unreachableReason = (result: { stdout: string; stderr?: string }): string =>
		redactThenClip(result.stderr?.trim() || result.stdout.trim(), 120);
	return {
		async pathExists(path) {
			assertPath(path);
			if (sshTarget === undefined) return { ok: true, value: existsSync(path) };
			const result = await run(sshCommand(sshTarget, ["test", "-e", path]), { timeoutMs: IO_TIMEOUT_MS });
			if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
			return { ok: true, value: result.code === 0 };
		},

		async createWorktree({ repo, worktree, branch }) {
			assertPath(repo, worktree);
			assertBranch(branch);
			const result = await exec(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"], GIT_TIMEOUT_MS);
			if (result.code === 0 && !result.timedOut) return { ok: true, value: null };
			return { ok: false, error: `git worktree add failed: ${redactThenClip(result.stdout.trim(), 200)}` };
		},

		async removeWorktree({ repo, worktree, branch }) {
			assertPath(repo, worktree);
			assertBranch(branch);
			// A read-only dir inside stops `worktree remove` halfway (`.git` gone, tree left): restore u+w first.
			await exec(["chmod", "-R", "u+w", "--", worktree], GIT_TIMEOUT_MS);
			await exec(["git", "-C", repo, "worktree", "remove", "--force", worktree], GIT_TIMEOUT_MS);
			await exec(["git", "-C", repo, "branch", "-D", branch], GIT_TIMEOUT_MS);
		},

		async removeRecords(dir) {
			assertPath(dir);
			if (!/\/docs\/tasks\/T-\d{8}-\d{2,}$/.test(dir)) throw new Error(`unsafe records dir: ${dir}`);
			await exec(["rm", "-rf", "--", dir], IO_TIMEOUT_MS);
		},

		async writeFile(path, content) {
			assertPath(path);
			if (sshTarget === undefined) {
				try {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content, { flag: "wx" });
					return { ok: true, value: null };
				} catch (error) {
					return fail(error);
				}
			}
			const encoded = Buffer.from(content, "utf8").toString("base64");
			// One shell command line: every interpolated piece is a validated path or base64.
			const command = `mkdir -p ${dirname(path)} && test ! -e ${path} && echo ${encoded} | base64 -d > ${path}`;
			const result = await run(sshCommand(sshTarget, [command, "2>&1"]), { timeoutMs: IO_TIMEOUT_MS });
			if (result.code === 0 && !result.timedOut) return { ok: true, value: null };
			return { ok: false, error: `write ${path} failed: ${redactThenClip(result.stdout.trim(), 160)}` };
		},

		async readFile(path) {
			assertPath(path);
			if (sshTarget === undefined)
				return readRegularFile(path).then((bytes) => ({ ok: true as const, value: bytes?.toString("utf8") }), fail);
			const result = await run(sshCommand(sshTarget, ["cat", path]), { timeoutMs: IO_TIMEOUT_MS });
			if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
			if (result.code !== 0) return { ok: true, value: undefined };
			if (result.stdout.length >= DEFAULT_STDOUT_CAP) return { ok: false, error: `${path} is too large to read` };
			return { ok: true, value: result.stdout };
		},

		async readBytes(path, within) {
			assertPath(path);
			if (sshTarget === undefined) {
				try {
					return { ok: true, value: await readRegularFile(path, within) };
				} catch (error) {
					return fail(error);
				}
			}
			// The runner collects stdout as UTF-8 text, which would mangle a binary file: base64 keeps every byte.
			const result = await run(sshCommand(sshTarget, ["base64", path]), { timeoutMs: IO_TIMEOUT_MS });
			if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
			if (result.code !== 0) return { ok: true, value: undefined };
			if (result.stdout.length >= DEFAULT_STDOUT_CAP) return { ok: false, error: `${path} is too large to read` };
			return { ok: true, value: Buffer.from(result.stdout, "base64") };
		},

		async commitOnTaskBranch({ worktree, branch, baseSha: base, hash }) {
			assertPath(worktree);
			assertBranch(branch);
			assertSha(base);
			if (!HEX_HASH.test(hash)) return "missing";
			const git = async (...args: string[]) => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) throw new Error(`cannot check commit ${hash}: host unreachable`);
				return result;
			};
			const failed = (step: string, result: { stdout: string }) =>
				new Error(`cannot check commit ${hash}: git ${step} failed: ${redactThenClip(result.stdout.trim(), 160)}`);
			/** `merge-base --is-ancestor`: 0 yes, 1 no, anything else is git failing, not an answer. */
			const ancestor = async (older: string, newer: string): Promise<boolean> => {
				const result = await git("merge-base", "--is-ancestor", older, newer);
				if (result.code !== 0 && result.code !== 1) throw failed("merge-base", result);
				return result.code === 0;
			};

			if ((await git("cat-file", "-e", `${hash}^{commit}`)).code !== 0) return "missing";
			const parsed = await git("rev-parse", `${hash}^{commit}`);
			const full = parsed.stdout.trim();
			if (parsed.code !== 0 || !FULL_HASH.test(full)) throw failed("rev-parse", parsed);
			if (full === base) return "not_on_branch";
			return (await ancestor(base, full)) && (await ancestor(full, branch)) ? "ok" : "not_on_branch";
		},

		async branchDiff({ worktree, branch, baseSha }) {
			assertPath(worktree);
			assertBranch(branch);
			assertSha(baseSha);
			const diff = await exec(
				[
					"git",
					"-C",
					worktree,
					"-c",
					"core.quotepath=false",
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					`${baseSha}..${branch}`,
					"--no-color",
					"--unified=0",
					// The worker's own status documents are not judged and only eat into the runner's stdout cap.
					// `:!` rather than `:(exclude)`: the argv crosses a remote shell unquoted over ssh.
					"--",
					".",
					":!docs/tasks",
				],
				GIT_TIMEOUT_MS,
				DIFF_STDOUT_CAP,
			);
			if (unreachable(diff)) return { ok: false, error: `host unreachable: ${unreachableReason(diff)}` };
			if (diff.code !== 0) return { ok: false, error: `git diff failed: ${redactThenClip(diff.stdout.trim(), 160)}` };
			if (diff.stdout.length >= DIFF_STDOUT_CAP) return { ok: false, error: "diff too large" };
			return { ok: true, value: diff.stdout };
		},

		async commitDocs({ worktree, taskId }) {
			assertPath(worktree);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const dir = `docs/tasks/${taskId}`;
			const message = taskDocsCommitTitle(taskId);
			// ssh joins its arguments into one remote shell line: the fixed message is quoted there, passed bare locally.
			const steps = [
				["git", "-C", worktree, "add", "--", dir],
				["git", "-C", worktree, "commit", "-q", "-m", sshTarget === undefined ? message : `'${message}'`, "--", dir],
			];
			for (const argv of steps) {
				const result = await exec(argv, GIT_TIMEOUT_MS);
				if (result.code !== 0 || result.timedOut) {
					return { ok: false, error: `git ${argv[3]} failed: ${redactThenClip(result.stdout.trim(), 200)}` };
				}
			}
			const head = await exec(["git", "-C", worktree, "rev-parse", "HEAD"], GIT_TIMEOUT_MS);
			const hash = head.stdout.trim();
			if (head.code !== 0 || head.timedOut || !HEX_HASH.test(hash)) {
				return { ok: false, error: `git rev-parse failed: ${redactThenClip(hash, 200)}` };
			}
			return { ok: true, value: hash };
		},

		async readPlan(path, worktree) {
			const { recordsRepo } = options;
			if (recordsRepo === undefined) return await this.readFile(`${worktree}/${path}`);
			try {
				return { ok: true, value: (await readRegularFile(join(recordsRepo, path), recordsRepo))?.toString("utf8") };
			} catch (error) {
				return fail(error);
			}
		},

		async runCheck({ worktree, argv, timeoutMs, signal }) {
			assertPath(worktree);
			const stop = signal === undefined ? {} : { signal };
			// A whole-suite run queues on the host's heavy-run lock, but only where the worktree has the runner (a repository
			// without it, or an old commit such as proven-red's parent, runs as before). The wait ends after the check's own
			// timeout, so a spent wait is always `timedOut` (inconclusive), never an exit 75 cached as the check's result.
			const queued = isFullTestArgv(argv)
				? [HEAVY_RUN, "--max-wait", String(Math.ceil(timeoutMs / 1000) + HEAVY_RUN_WAIT_SLACK_S), "--", ...argv]
				: undefined;
			// Locally the argv is the process itself; ssh joins its arguments into one remote shell line, so every
			// argument is single-quoted there and the shell only sees `cd <worktree> && <argv>` (a queued run picks the
			// runner or the bare argv with an `if` on the remote worktree). A non-interactive ssh
			// shell skips the profile that puts `~/.local/bin` (npm, node, bun shims) on PATH, so the line adds it first.
			const result =
				sshTarget === undefined
					? await run(queued !== undefined && existsSync(`${worktree}/${HEAVY_RUN}`) ? queued : argv, {
							cwd: worktree,
							timeoutMs,
							env,
							stdoutCap: CHECK_STDOUT_CAP,
							...stop,
						})
					: await run(
							sshCommand(sshTarget, [
								"export",
								REMOTE_CHECK_PATH,
								"&&",
								"cd",
								remoteShellQuote(worktree),
								"&&",
								...(queued === undefined
									? argv.map(remoteShellQuote)
									: [
											"if",
											"[",
											"-x",
											HEAVY_RUN,
											"];",
											"then",
											...queued.map(remoteShellQuote),
											";",
											"else",
											...argv.map(remoteShellQuote),
											";",
											"fi",
										]),
							]),
							{ timeoutMs, stdoutCap: CHECK_STDOUT_CAP, ...stop },
						);
			if (sshTarget !== undefined && !result.timedOut && (result.code === null || result.code === SSH_FAILURE))
				throw new Error(`cannot run check: host unreachable: ${unreachableReason(result)}`);
			const output = [result.stdout, result.stderr ?? ""].filter((part) => part.trim() !== "").join("\n");
			return {
				code: result.code,
				output,
				timedOut: result.timedOut,
				...(result.stdout.length >= CHECK_STDOUT_CAP ? { truncated: true as const } : {}),
			};
		},

		async headOf(worktree) {
			assertPath(worktree);
			const git = async (...args: string[]) => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) throw new Error(`cannot read HEAD of ${worktree}: host unreachable`);
				if (result.code !== 0)
					throw new Error(
						`cannot read HEAD of ${worktree}: git ${args[0]} failed: ${redactThenClip(result.stdout.trim(), 160)}`,
					);
				return result.stdout.trim();
			};
			const sha = await git("rev-parse", "HEAD");
			if (!FULL_HASH.test(sha)) throw new Error(`cannot read HEAD of ${worktree}: ${redactThenClip(sha, 80)}`);
			const status = await git("status", "--porcelain", "--untracked-files=all");
			return { sha, clean: status === "" && !(await hiddenOnHost(exec, worktree, GIT_TIMEOUT_MS)) };
		},

		async progressLag({ worktree, taskId, progressFile }) {
			assertPath(worktree);
			assertPath(progressFile);
			if (!TASK_ID.test(taskId)) throw new Error(`unsafe task id: ${taskId}`);
			const progressPath = `docs/tasks/${taskId}/PROGRESS.md`;
			const inside = progressFile === `${worktree}/${progressPath}`;
			const git = async (...args: string[]): Promise<HostResult<string>> => {
				const result = await exec(["git", "-C", worktree, ...args], GIT_TIMEOUT_MS);
				if (unreachable(result)) return { ok: false, error: `host unreachable: ${unreachableReason(result)}` };
				if (result.code !== 0)
					return { ok: false, error: `git ${args[0]} failed: ${redactThenClip(result.stdout.trim(), 160)}` };
				return { ok: true, value: result.stdout };
			};
			const log = inside ? await git("log", "-1", "--format=%h", "--", progressPath) : { ok: true as const, value: "" };
			if (!log.ok) return log;
			const progressCommit = log.value.trim();
			if (progressCommit !== "" && !HEX_HASH.test(progressCommit))
				return { ok: false, error: `git log: ${redactThenClip(progressCommit, 80)}` };
			let codeCommitsSince = 0;
			if (!inside) {
				// Records mode: PROGRESS.md lives outside the repository, so "since its last commit" is "since its mtime".
				const stat = await exec(["stat", "-c", "%Y", progressFile], IO_TIMEOUT_MS);
				if (unreachable(stat)) return { ok: false, error: `host unreachable: ${unreachableReason(stat)}` };
				const mtime = stat.stdout.trim();
				if (stat.code !== 0 || !/^\d+$/.test(mtime)) return { ok: false, error: `stat ${progressFile} failed` };
				const count = await git("rev-list", "--count", `--since=@${mtime}`, "HEAD");
				if (!count.ok) return count;
				codeCommitsSince = Number.parseInt(count.value.trim(), 10);
			} else if (progressCommit !== "") {
				// Every task's documents are left out, not only this one's: a docs-only commit is never a code commit.
				// `:!` rather than `:(exclude)`: the argv crosses a remote shell unquoted over ssh.
				const count = await git("rev-list", "--count", `${progressCommit}..HEAD`, "--", ".", ":!docs/tasks");
				if (!count.ok) return count;
				codeCommitsSince = Number.parseInt(count.value.trim(), 10);
				if (!Number.isInteger(codeCommitsSince))
					return { ok: false, error: `git rev-list: ${redactThenClip(count.value.trim(), 80)}` };
			}
			const status = await git("status", "--porcelain", "--untracked-files=all");
			if (!status.ok) return status;
			const entries = status.value.split("\n").filter((line) => line.trim() !== "");
			const progressDirty = inside && entries.some((line) => line.slice(3) === progressPath);
			return {
				ok: true,
				value: {
					progressCommit,
					codeCommitsSince,
					progressDirty,
					otherDirty: entries.length - (progressDirty ? 1 : 0),
				},
			};
		},
	};
}

/** Host ops for a task row's `host` (null = local); an unknown host name is an error, not a fallback to local. */
export function resolveTaskHost(
	host: string | null,
	dispatchHosts: Record<string, { ssh: string }> | undefined,
	options: Omit<TaskHostOptions, "sshTarget"> = {},
): TaskHostOps & TaskResumeOps {
	if (host === null) return createTaskHostOps(options);
	// Own keys only: `constructor`/`__proto__` are not configured hosts.
	const entry = dispatchHosts !== undefined && Object.hasOwn(dispatchHosts, host) ? dispatchHosts[host] : undefined;
	if (entry === undefined) throw new Error(`알 수 없는 호스트: ${host}`);
	return createTaskHostOps({ ...options, sshTarget: entry.ssh });
}
