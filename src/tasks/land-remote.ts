import type { JabbuConfig } from "../config";
import { type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { landModeOf } from "../lanes/manager-pr-land";
import type { PrTools } from "../lanes/pr";
import { landModeOfRemote, type RemoteLandMode } from "../lanes/pr-land-remote";
import { failureOf, type LaneLandMode, type PrLandDeps } from "../lanes/pr-land-steps";
import type { LanePrLand } from "../lanes/pr-land-types";
import type { GitRunner } from "../lanes/verify";
import { redactThenClip } from "../redact";
import { branchProblem } from "./branch";
import { resolveTaskHost, type TaskHostOps } from "./host";
import { removeRemoteWorktree, syncRemoteBase } from "./host-sync";
import { baseBranchOf, isAncestor, rejudge, type TaskLandDeps } from "./land";
import type { TaskRow } from "./ledger";
import { taskHostOf } from "./records";
import { repoMatchesCommonDir } from "./repo-match";

/**
 * The PR landing of a reached [TASK] on a `dispatchHosts` host: its branch is
 * fetched into the bot's own clone of the repository (`refs/jabbu/task/<id>`), judged where it lives, and pushed from
 * the fetched commit; after the merge the host's worktree, branch and base branch are cleaned up over ssh.
 */

/** What a landing takes from the daemon: the host ops' process runner, the local git and the network tools. */
export interface RemoteLandEnv {
	config: Pick<JabbuConfig, "dispatchHosts" | "recordsRepo">;
	/** Runs the ssh commands of the host ops and of the cleanup (`herdrRun` in the daemon); absent = real processes. */
	run: ProcessRunner | undefined;
	tools: PrTools;
	git: GitRunner;
	/** The `fetch` address of the host repository (default `<ssh>:<path>`; a test points it at a local path). */
	address?: ((ssh: string, repo: string) => string) | undefined;
}

/** What the landing's preparation came to: why it stops, a worker to send back, or the commit to open the PR for. */
export type Prepared =
	| { stop: string }
	| { rework: { reason: string; notice: string; prLand: LanePrLand }; sha: string; baseBranch: string }
	| { sha: string; baseBranch: string; repo: string };

const SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=8";
const TASK_ID = /^T-\d{8}-\d{2,}$/;

/** The local temporary ref the host branch is fetched into: the PR push's source, never a branch. */
export const tempRefOf = (taskId: string): string => `refs/jabbu/task/${taskId}`;

/** The `lanes.land` entry a task lands by: its repository's own, or (on a host) the one whose `remotes[host]` is its repository. */
export const landModeOfRow = (
	config: Pick<JabbuConfig, "lanes" | "recordsRepo" | "dispatchHosts">,
	row: TaskRow,
): Promise<LaneLandMode | RemoteLandMode | undefined> =>
	row.host === null ? landModeOf(config, row.repo) : Promise.resolve(landModeOfRemote(config, row.host, row.repo));

/** Whether a landing mode is a task-on-a-host one (`landModeOfRemote`'s). */
export const isRemoteMode = (mode: LaneLandMode | RemoteLandMode): mode is RemoteLandMode => "localRepo" in mode;

/** The repository on this machine the task's commits are pushed from. */
export const localRepoOf = (row: TaskRow, mode: LaneLandMode | RemoteLandMode | undefined): string =>
	mode !== undefined && isRemoteMode(mode) ? mode.localRepo : row.repo;

/** Host ops of a task row's host; a host's commands run through `run` when given. */
export function hostOpsOf(
	config: Pick<JabbuConfig, "dispatchHosts" | "recordsRepo">,
	host: string | null,
	run?: ProcessRunner,
): TaskHostOps {
	if (host === null || run === undefined) return taskHostOf(config, host);
	return resolveTaskHost(host, config.dispatchHosts, { recordsRepo: config.recordsRepo, run });
}

/** Whether the task's repository is one of `repos` (`taskAutoLand.repos`): its local clone for a task on a host. */
export async function repoMatchesTask(
	config: Pick<JabbuConfig, "lanes" | "recordsRepo" | "dispatchHosts">,
	row: TaskRow,
	repos: readonly string[],
): Promise<boolean> {
	return repoMatchesCommonDir(localRepoOf(row, await landModeOfRow(config, row)), repos);
}

/**
 * Fetches the task's branch from the host into the temporary ref of the local clone (`+` refspec: a worker that rebased
 * is followed) and returns the commit. Rejects when ssh or git fails.
 */
export async function fetchTaskBranch(env: RemoteLandEnv, row: TaskRow, mode: RemoteLandMode): Promise<string> {
	if (mode.ssh.startsWith("-")) throw new Error(`dispatchHosts ssh 값이 옵션처럼 보임: ${mode.ssh}`);
	if (branchProblem(row.branch) !== undefined || !TASK_ID.test(row.taskId))
		throw new Error(`위험한 브랜치 이름: ${row.branch}`);
	const ref = tempRefOf(row.taskId);
	const address = (env.address ?? ((ssh, repo) => `${ssh}:${repo}`))(mode.ssh, mode.remoteRepo);
	const fetched = await env.tools.git(
		[
			"-c",
			`core.sshCommand=${SSH_COMMAND}`,
			"-C",
			mode.localRepo,
			"fetch",
			"--",
			address,
			`+refs/heads/${row.branch}:${ref}`,
		],
		{ cwd: mode.localRepo, signal: new AbortController().signal },
	);
	if (fetched.code !== 0) throw new Error(`원격 ${row.host} 브랜치 fetch 실패: ${failureOf(fetched)}`);
	const sha = (await env.git(["-C", mode.localRepo, "rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();
	if (sha === "") throw new Error(`fetch한 ${ref}를 읽을 수 없음`);
	return sha;
}

async function fetchBase(env: RemoteLandEnv, mode: RemoteLandMode, baseBranch: string): Promise<void> {
	const remote = mode.config.remote ?? "origin";
	const fetched = await env.tools.git(["-C", mode.localRepo, "fetch", remote, baseBranch], {
		cwd: mode.localRepo,
		signal: new AbortController().signal,
	});
	if (fetched.code !== 0) throw new Error(`git fetch ${remote} ${baseBranch} 실패: ${failureOf(fetched)}`);
}

/**
 * The first half of a remote task's landing (6.2): the host worktree is clean at its HEAD, the fetched branch tip is
 * that HEAD, and the task is judged again where it lives with the diff base taken from the local clone; a HEAD that
 * moved meanwhile stops it. A base branch that is ahead is left to the gate, which sends the worker back (the core
 * never merges in a worktree on a host). Rejects when ssh or git cannot run.
 */
export async function prepareRemote(
	env: RemoteLandEnv,
	row: TaskRow,
	mode: RemoteLandMode,
	deps: Pick<TaskLandDeps, "judge" | "mode">,
): Promise<Prepared> {
	if (row.status !== "review") return { stop: `TASK 상태가 review가 아님(${row.status})` };
	const ops = hostOpsOf(env.config, row.host, env.run);
	const exists = await ops.pathExists(row.worktree);
	if (!exists.ok) return { stop: `원격 worktree를 확인하지 못함: ${exists.error}` };
	if (!exists.value) return { stop: `원격 worktree 없음: ${row.worktree}` };
	const head = await ops.headOf(row.worktree);
	if (!head.clean) return { stop: `원격 worktree에 커밋 안 된 변경이 있음: ${row.worktree}` };
	const baseBranch = await baseBranchOf(env.git, mode.localRepo);
	if (baseBranch === undefined) return { stop: "기준 브랜치(origin/HEAD·main·master)가 없음" };
	await fetchBase(env, mode, baseBranch);
	const sha = await fetchTaskBranch(env, row, mode);
	if (sha !== head.sha) {
		return { stop: `원격 worktree HEAD가 브랜치 끝이 아님(HEAD ${head.sha.slice(0, 12)}, 브랜치 ${sha.slice(0, 12)})` };
	}
	const tracking = `refs/remotes/${mode.config.remote ?? "origin"}/${baseBranch}`;
	const base = (await env.git(["-C", mode.localRepo, "merge-base", tracking, sha])).stdout.trim();
	const tipOf = async () => {
		const now = await ops.headOf(row.worktree);
		return now.clean ? now.sha : "dirty";
	};
	const judged = await rejudge(row, sha, deps, tipOf, base === "" ? undefined : base);
	return judged === undefined ? { sha, baseBranch, repo: mode.localRepo } : { stop: judged };
}

/**
 * `PrLandDeps.worktree` of a task on a host: `drift` reads the host worktree's HEAD again, `cleanUp` is 6.4 in its
 * order — the temporary ref, the host's worktree and branch, the host's base branch — and returns what was not done.
 */
export function remoteWorktree(
	env: RemoteLandEnv,
	row: TaskRow,
	mode: RemoteLandMode,
	at: { sha: string; baseBranch: string; slug?: string | undefined; beforeCleanup?: PrLandDeps["beforeCleanup"] },
): NonNullable<PrLandDeps["worktree"]> {
	return {
		async drift() {
			try {
				const head = await hostOpsOf(env.config, row.host, env.run).headOf(row.worktree);
				if (!head.clean) return { failed: "원격 worktree에 미커밋 변경이 있습니다." };
				return head.sha === at.sha ? undefined : { head: head.sha };
			} catch (error) {
				return { failed: redactThenClip(error instanceof Error ? error.message : String(error), 200) };
			}
		},
		async cleanUp() {
			await at.beforeCleanup?.();
			const run = env.run ?? realProcessRunner;
			const notes: string[] = [];
			const dropped = await env.git(["-C", mode.localRepo, "update-ref", "-d", tempRefOf(row.taskId)]);
			if (dropped.code !== 0)
				notes.push(`임시 ref ${tempRefOf(row.taskId)} 삭제 실패: ${dropped.stderr.trim().slice(0, 120)}`);
			const input = { repo: mode.remoteRepo, worktree: row.worktree, branch: row.branch };
			const removed = await removeRemoteWorktree(run, mode.ssh, input);
			if (removed !== undefined) {
				notes.push(
					`원격 ${row.host} 정리 필요 — ${removed} (손으로: git -C ${input.repo} worktree remove --force ${input.worktree}; git -C ${input.repo} branch -D ${input.branch})`,
				);
			}
			const synced = await syncRemoteBase(run, mode.ssh, {
				host: String(row.host),
				repo: mode.remoteRepo,
				baseBranch: at.baseBranch,
				remote: mode.config.remote ?? "origin",
				expectedSlug: at.slug ?? "",
			});
			if (synced !== undefined) notes.push(synced);
			return notes.length === 0 ? undefined : notes.join(" · ");
		},
	};
}

/**
 * The diff base of a task on a host (설계 3, `integrityBaseOf`): the merge-base of the base branch and the fetched
 * branch tip, only when the branch carries the base branch's commits (a worker's merge) and `baseSha` is behind it.
 * `undefined` = `baseSha` stands, or nothing could be read.
 */
export async function remoteIntegrityBase(env: RemoteLandEnv, row: TaskRow): Promise<string | undefined> {
	const mode = row.host === null ? undefined : landModeOfRemote(env.config, row.host, row.repo);
	if (mode?.mode !== "pr" || row.baseSha === null) return undefined;
	try {
		const baseBranch = await baseBranchOf(env.git, mode.localRepo);
		if (baseBranch === undefined) return undefined;
		await fetchBase(env, mode, baseBranch);
		const tip = await fetchTaskBranch(env, row, mode);
		const tracking = `refs/remotes/${mode.config.remote ?? "origin"}/${baseBranch}`;
		const merged = (await env.git(["-C", mode.localRepo, "merge-base", tracking, tip])).stdout.trim();
		if (merged === "" || merged === row.baseSha) return undefined;
		return (await isAncestor(env.git, mode.localRepo, row.baseSha, merged)) ? merged : undefined;
	} catch {
		return undefined;
	}
}
