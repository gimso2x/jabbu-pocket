/**
 * [TASK] records outside the code repository: with `recordsRepo` set, a task's four
 * documents live in that checkout's `docs/tasks/<id>` (a remote task: its host's plain `recordsDir`, mirrored here) and
 * only the bot commits them there. A worker never commits them, and no task branch ever carries them.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planPathsIn } from "../lanes/declared";
import { defaultGit, type GitRunner } from "../lanes/verify";
import { redactThenClip } from "../redact";
import { docsDirUnder, taskDocsCommitTitle } from "./docs";
import { readRegularFile, resolveTaskHost, type TaskHostOps } from "./host";
import type { TaskRow } from "./ledger";

/** The four documents of a task, in the order they are written. */
export const TASK_DOC_NAMES = ["context.md", "spec.md", "PROGRESS.md", "outcome.md"] as const;
/** A working task's records are committed at most this often (when their content changed). */
export const RECORDS_COMMIT_INTERVAL_MS = 30 * 60_000;
/** `index.lock` held by somebody else (the owner committing a spec in the same checkout): tries before giving up. */
const LOCK_TRIES = 3;

/** The one switch between the two modes: the documents sit inside the worktree (committed on the branch) or not. */
export const insideWorktree = (row: Pick<TaskRow, "worktree" | "docsDir">): boolean =>
	row.docsDir.startsWith(`${row.worktree}/`);

/** The records root a task's `docsDir` is under: `recordsRepo` for a local task, a host's `recordsDir` for a remote one. */
export function recordsRootOf(row: Pick<TaskRow, "taskId" | "docsDir">): string {
	return row.docsDir.slice(0, row.docsDir.length - docsDirUnder("", row.taskId).length);
}

export type RecordsCommit =
	| { state: "committed"; sha: string }
	| { state: "clean" }
	| { state: "failed"; error: string };

/** One records commit at a time in this process: two tasks committing to one checkout would race on `index.lock`. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Commits `docs/tasks/<taskId>` of the records checkout as `message`, path-limited (the owner's other changes there are
 * never touched); nothing to commit is `clean`. Refuses unless `main` is checked out. Never throws: a records commit
 * failing must not fail the task, so the caller only logs it.
 */
export function commitRecords(
	input: { recordsRepo: string; taskId: string; message: string },
	git: GitRunner = defaultGit,
): Promise<RecordsCommit> {
	const run = queue.then(() => commitNow(input, git));
	queue = run.catch(() => undefined);
	return run;
}

async function commitNow(
	{ recordsRepo, taskId, message }: { recordsRepo: string; taskId: string; message: string },
	git: GitRunner,
): Promise<RecordsCommit> {
	if (!/^T-\d{8}-\d{2,}$/.test(taskId)) return { state: "failed", error: `unsafe task id: ${taskId}` };
	const dir = `docs/tasks/${taskId}`;
	const failed = (step: string, out: { stdout: string; stderr: string }): RecordsCommit => ({
		state: "failed",
		error: `git ${step}: ${redactThenClip(`${out.stderr}${out.stdout}`.trim(), 200)}`,
	});
	try {
		const head = await git(["-C", recordsRepo, "symbolic-ref", "-q", "--short", "HEAD"]);
		if (head.code !== 0 || head.stdout.trim() !== "main")
			return { state: "failed", error: `기록 저장소가 main이 아님(${head.stdout.trim() || "detached"})` };
		const status = await git(["-C", recordsRepo, "status", "--porcelain", "--untracked-files=all", "--", dir]);
		if (status.code !== 0) return failed("status", status);
		if (status.stdout.trim() === "") return { state: "clean" };
		for (let attempt = 1; ; attempt++) {
			const added = await git(["-C", recordsRepo, "add", "-A", "--", dir]);
			const committed =
				added.code === 0
					? await git(["-C", recordsRepo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", dir])
					: added;
			if (committed.code === 0) break;
			if (attempt >= LOCK_TRIES || !`${committed.stderr}${committed.stdout}`.includes("index.lock"))
				return failed(added.code === 0 ? "commit" : "add", committed);
			await Bun.sleep(200 * attempt); // sleep-ok: backing off another process's index.lock, not a test wait
		}
		const sha = await git(["-C", recordsRepo, "rev-parse", "HEAD"]);
		return sha.code === 0 ? { state: "committed", sha: sha.stdout.trim() } : failed("rev-parse", sha);
	} catch (error) {
		return { state: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A remote task's records (its host's `recordsDir`) copied over `<recordsRepo>/docs/tasks/<id>` and committed there. The
 * remote copy is the original; a host that cannot be read skips this round (`skipped`), the local snapshot stays.
 */
export async function mirrorRecords(
	row: Pick<TaskRow, "taskId" | "docsDir">,
	ops: Pick<TaskHostOps, "readFile">,
	input: { recordsRepo: string; message: string },
	git: GitRunner = defaultGit,
): Promise<RecordsCommit | { state: "skipped"; error: string }> {
	const local = docsDirUnder(input.recordsRepo, row.taskId);
	const texts: Array<[string, string]> = [];
	for (const name of TASK_DOC_NAMES) {
		const read = await ops.readFile(`${row.docsDir}/${name}`);
		if (!read.ok) return { state: "skipped", error: read.error };
		if (read.value !== undefined) texts.push([name, read.value]);
	}
	try {
		mkdirSync(local, { recursive: true });
		for (const [name, text] of texts) writeFileSync(join(local, name), text);
	} catch (error) {
		return { state: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	return await commitRecords({ recordsRepo: input.recordsRepo, taskId: row.taskId, message: input.message }, git);
}

/** The records of a task right now: the local checkout's copy, or a mirror of a remote task's. */
export function recordNow(
	row: Pick<TaskRow, "taskId" | "docsDir" | "host">,
	ops: Pick<TaskHostOps, "readFile">,
	input: { recordsRepo: string; message: string },
	git: GitRunner = defaultGit,
): Promise<RecordsCommit | { state: "skipped"; error: string }> {
	return row.host === null
		? commitRecords({ recordsRepo: input.recordsRepo, taskId: row.taskId, message: input.message }, git)
		: mirrorRecords(row, ops, input, git);
}

/**
 * The sweep's records commits of a records-mode task: at once when its status differs from the one last recorded
 * (`review`, `blocked`, a resume), otherwise at most every `RECORDS_COMMIT_INTERVAL_MS` (a clean directory commits
 * nothing), reading `recordsRepo` from the live config. A failed or skipped commit is only logged; the next round tries
 * again. Memory only: a restart records once.
 */
export function recordsTicker(
	ctx: {
		options: { config: { recordsRepo?: string } };
		clock: { now(): number };
		log: { warn(event: string, fields?: Record<string, unknown>): void };
	},
	ops: (row: TaskRow) => Pick<TaskHostOps, "readFile">,
	git: GitRunner = defaultGit,
): (row: TaskRow) => Promise<void> {
	const last = new Map<string, { status: string; at: number }>();
	return async (row) => {
		const repo = ctx.options.config.recordsRepo;
		if (repo === undefined || insideWorktree(row)) return;
		const seen = last.get(row.taskId);
		const at = ctx.clock.now();
		if (seen?.status === row.status && at - seen.at < RECORDS_COMMIT_INTERVAL_MS) return;
		last.set(row.taskId, { status: row.status, at });
		const result = await recordStatus(row, ops(row), repo, git);
		if (result?.state === "failed" || result?.state === "skipped")
			ctx.log.warn("records_commit_failed", { task: row.taskId, ...result });
	};
}

/** The task host ops of `host` under a config's `dispatchHosts`, reading `doc/plans` from its `recordsRepo`. */
export const taskHostOf = (
	config: { dispatchHosts?: Record<string, { ssh: string }>; recordsRepo?: string },
	host: string | null,
) => resolveTaskHost(host, config.dispatchHosts, { recordsRepo: config.recordsRepo });

/** `recordStatus` with the ops and `recordsRepo` of a config: the last commit of a closed task (`closeTaskAgent`). */
export const recordWithConfig = (config: Parameters<typeof taskHostOf>[0], row: TaskRow) =>
	recordStatus(row, taskHostOf(config, row.host), config.recordsRepo);

/**
 * One records commit of a records-mode task as it is now (`docs(task): <id> <status> 기록`); `undefined` outside records
 * mode. Never throws: a host that cannot be reached is a `failed` result. Also the last commit at a close (`done` by
 * the core landing, `tasks close`).
 */
export async function recordStatus(
	row: TaskRow,
	ops: Pick<TaskHostOps, "readFile">,
	recordsRepo: string | undefined,
	git: GitRunner = defaultGit,
): Promise<RecordsCommit | { state: "skipped"; error: string } | undefined> {
	if (recordsRepo === undefined || insideWorktree(row)) return undefined;
	const message = `docs(task): ${row.taskId} ${row.status} 기록`;
	return await recordNow(row, ops, { recordsRepo, message }, git).catch((error: unknown) => ({
		state: "failed" as const,
		error: String(error),
	}));
}

/**
 * Undoes the records of a task whose start failed (records mode only; the worktree's own copy goes with the worktree):
 * the documents (the remote copy too) are removed, and when they were already committed, a commit removing them follows
 * (history is never rewritten).
 */
export async function rollbackRecords(
	row: Pick<TaskRow, "taskId" | "docsDir" | "worktree">,
	ops: Pick<TaskHostOps, "removeRecords">,
	recordsRepo: string | undefined,
	committed: boolean,
	git: GitRunner = defaultGit,
): Promise<RecordsCommit | undefined> {
	if (recordsRepo === undefined || insideWorktree(row)) return undefined;
	await ops.removeRecords(row.docsDir);
	rmSync(docsDirUnder(recordsRepo, row.taskId), { recursive: true, force: true });
	if (!committed) return undefined;
	const message = `docs(task): ${row.taskId} 시작 실패로 기록 되돌림`;
	return await commitRecords({ recordsRepo, taskId: row.taskId, message }, git);
}

/**
 * Where a new task's records go: `undefined` = its worktree (no `recordsRepo`), the records root otherwise, `null` =
 * refused (a remote host without `recordsDir`: records mode never falls back to a docs commit on the branch).
 */
export function recordsRootFor(
	recordsRepo: string | undefined,
	host: string | null,
	entry: { recordsDir?: string } | undefined,
): string | null | undefined {
	if (recordsRepo === undefined) return undefined;
	return host === null ? recordsRepo : (entry?.recordsDir ?? null);
}

/** The worker prompt's view of the documents: where they are and whether the worker commits them with its steps. */
export const promptDocsOf = (row: Pick<TaskRow, "worktree" | "docsDir">) => ({
	docsDir: row.docsDir,
	recordsInRepo: insideWorktree(row),
});

/** What an agy worker trusts: its worktree, and the records directory when the documents are outside it. */
export const agyWorkspacesOf = (row: Pick<TaskRow, "worktree" | "docsDir">): string[] =>
	insideWorktree(row) ? [row.worktree] : [row.worktree, row.docsDir];

/**
 * Writes a new task's four documents to its `docsDir` and records them: the branch's first commit (`commitDocs`), or in
 * records mode the spec plans copied beside them and a records commit (only logged when it fails: the task goes on).
 * `recorded`: a records commit exists that a failed start must undo.
 */
export async function writeTaskDocs(
	row: TaskRow,
	ops: Pick<TaskHostOps, "writeFile" | "readFile" | "commitDocs">,
	input: {
		docs: ReadonlyArray<readonly [string, string]>;
		recordsRepo: string | undefined;
		log: { warn(event: string, fields?: Record<string, unknown>): void };
	},
	git: GitRunner = defaultGit,
): Promise<{ ok: true; plans: string[]; recorded: boolean } | { ok: false; error: string }> {
	for (const [name, content] of input.docs) {
		const written = await ops.writeFile(`${row.docsDir}/${name}`, content);
		if (!written.ok) return written;
	}
	const { recordsRepo } = input;
	if (recordsRepo === undefined || insideWorktree(row)) {
		const committed = await ops.commitDocs({ worktree: row.worktree, taskId: row.taskId });
		return committed.ok ? { ok: true, plans: [], recorded: false } : committed;
	}
	const named = planPathsIn(input.docs.map(([, content]) => content).join("\n"));
	const plans = await copyPlans(named, row.docsDir, recordsRepo, ops);
	const records = await recordNow(row, ops, { recordsRepo, message: taskDocsCommitTitle(row.taskId) }, git);
	if (records.state !== "committed") input.log.warn("records_commit_failed", { task: row.taskId, ...records });
	return { ok: true, plans, recorded: records.state === "committed" };
}

/**
 * The `doc/plans/<name>.md` files a task names, read from the records checkout (a regular file inside it) and copied to
 * `<docsDir>/plans/<name>.md` so the worker reads the spec beside its documents. Returns the copied paths; a plan that
 * cannot be read or written is left out (the integrity check still reads it from `recordsRepo`).
 */
export async function copyPlans(
	paths: readonly string[],
	docsDir: string,
	recordsRepo: string,
	ops: Pick<TaskHostOps, "writeFile">,
): Promise<string[]> {
	const copied: string[] = [];
	for (const path of paths) {
		const text = await readRegularFile(join(recordsRepo, path), recordsRepo).catch(() => undefined);
		if (text === undefined) continue;
		const target = `${docsDir}/plans/${path.slice("doc/plans/".length)}`;
		if ((await ops.writeFile(target, text.toString("utf8"))).ok) copied.push(target);
	}
	return copied;
}
