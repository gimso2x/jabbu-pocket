import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneLandRepoConfig } from "../config-validate";
import type { LeakCheckInput, LeakCheckResult } from "../release/leak-check";
import { checkoutOf, type LanderDeps, statusOf, type worktreeDrift } from "./land";
import type { ProcResult, PrTools } from "./pr";
import type { LanePrLand, PrStep } from "./pr-land-types";
import type { GitRunner } from "./verify";

/** What a PR landing is given (a lane's `meta` and the repository's `lanes.land` entry) and what it may use. */
export interface PrLandInput {
	repo: string;
	worktree: string;
	branch: string;
	baseBranch: string;
	/** The lane's claim commit. */
	sha: string;
	/** `meta.checks.head`: the commit the re-run checks passed on. */
	checksHead: string | undefined;
	title: string;
	/** The claim's summary (redacted by the caller): the PR body is made of it, never of a file of the lane. */
	summary: string;
	config: LaneLandRepoConfig;
	/** `<recordsRepo>/release/denylist.txt`; absent = no leak check is possible. */
	denylistFile: string | undefined;
	frozen: boolean;
	prLand?: LanePrLand | undefined;
}

/**
 * Test-only crash points: a step's own name is right after it was saved; the others are after a side effect and before
 * its record (`leak-passed`, `push-done`, `create-done`, `merge-done`, `ff-done`).
 */
export type PrLandCrashPoint = PrStep | "leak-passed" | "push-done" | "create-done" | "merge-done" | "ff-done";

export interface PrLandDeps {
	/** Local git queries (no network). */
	git: GitRunner;
	/** fetch, push and gh (`signal` cuts reads; the write steps are re-entered through the saved step). */
	tools: PrTools;
	signal: AbortSignal;
	checkLeaks(input: LeakCheckInput): Promise<LeakCheckResult>;
	gitleaks: string | undefined;
	removeWorktree: LanderDeps["removeWorktree"];
	/** The worktree the landing is about when it is not a local directory (a task on a `dispatchHosts` host); absent = the local one. */
	worktree?: {
		/** `worktreeDrift` of that worktree at the claim commit. */
		drift(): Promise<Awaited<ReturnType<typeof worktreeDrift>>>;
		/** `cleanUp` of it after the merge (`beforeCleanup` is the caller's to run inside); `undefined` = gone. */
		cleanUp(): Promise<string | undefined>;
	};
	/** Awaited right before the lane's worktree is removed. */
	beforeCleanup?: () => Promise<void>;
	now(): number;
	/** Persists `prLand` (called after every step). */
	save(prLand: LanePrLand): void;
	crash?: (point: PrLandCrashPoint) => void;
}

/** How one repository's lanes land (`lanes.land`) and where its leak-check denylist is (`recordsRepo`). */
export interface LaneLandMode {
	config: LaneLandRepoConfig;
	denylistFile?: string;
}

/** Test seams of the PR landing: the local git, the leak check, the gitleaks binary, the crash hook and the `fetch` address of a host repository. */
export interface PrLandSeams {
	git?: GitRunner;
	/** The address `git fetch` takes a task branch of a `dispatchHosts` host from (default `<ssh>:<path>`). */
	address?: (ssh: string, repo: string) => string;
	checkLeaks?: PrLandDeps["checkLeaks"];
	gitleaks?: string | undefined;
	crash?: PrLandDeps["crash"];
}

/** One run: the input, the remote, and the state as saved so far. */
export interface PrRun {
	input: PrLandInput;
	deps: PrLandDeps;
	remote: string;
	state: LanePrLand;
}

/** How often an open pull request of a landing is read. */
export const PR_LAND_POLL_MS = 60_000;
const BODY_MAX = 20_000;
const TITLE_MAX = 200;
const REASON_MAX = 300;

export const shortSha = (sha: string): string => sha.slice(0, 12);

/** The line of a failed call worth showing: the one that says rejected/error/fatal, else the first. */
export function failureOf(result: ProcResult): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const telling = lines.find((line) => /rejected|error|fatal|denied/i.test(line));
	return (telling ?? lines[0] ?? `exit ${result.code}`).slice(0, REASON_MAX);
}

export function newRun(input: PrLandInput, deps: PrLandDeps): PrRun {
	return {
		input,
		deps,
		remote: input.config.remote ?? "origin",
		state: input.prLand ?? { branch: input.branch },
	};
}

/** Saves `patch` onto the state; `before` is a crash point between the side effect and this record. */
export function advance(run: PrRun, patch: Partial<LanePrLand>, before?: PrLandCrashPoint): void {
	if (before !== undefined) run.deps.crash?.(before);
	run.state = { ...run.state, ...patch };
	run.deps.save(run.state);
	if (patch.step !== undefined) run.deps.crash?.(patch.step);
}

/** git (network: fetch, push, ls-remote) or gh in the repository; a program that cannot run rejects. */
export const tool = (run: PrRun, program: keyof PrTools, argv: string[]): Promise<ProcResult> =>
	run.deps.tools[program](argv, { cwd: run.input.repo, signal: run.deps.signal });

/** `git fetch <remote> <base>`; a failure rejects (the caller runs the step again). */
export async function fetchBase(run: PrRun): Promise<void> {
	const result = await tool(run, "git", ["-C", run.input.repo, "fetch", run.remote, run.input.baseBranch]);
	if (result.code !== 0) throw new Error(`git fetch ${run.remote} ${run.input.baseBranch} 실패: ${failureOf(result)}`);
}

export const trackingRef = (run: PrRun): string => `${run.remote}/${run.input.baseBranch}`;

/** `gh <argv> --json` read as JSON; a failure or a non-JSON answer rejects. */
export async function ghJson(run: PrRun, argv: string[]): Promise<unknown> {
	const result = await tool(run, "gh", argv);
	if (result.code !== 0) throw new Error(`gh ${argv.slice(0, 2).join(" ")} 실패: ${failureOf(result)}`);
	try {
		return JSON.parse(result.stdout) as unknown;
	} catch {
		throw new Error(`gh ${argv.slice(0, 2).join(" ")}: JSON이 아님`);
	}
}

export interface PrView {
	state: string;
	headRefOid: string;
	mergeCommit: string | undefined;
	title: string;
	body: string;
}

/** `gh pr view` of the landing's PR; rejects when gh fails or answers something else. */
export async function viewPr(run: PrRun): Promise<PrView> {
	const { number, slug } = run.state;
	const raw = await ghJson(run, [
		"pr",
		"view",
		String(number),
		"--repo",
		String(slug),
		"--json",
		"state,headRefOid,mergeCommit,title,body",
	]);
	const view = (raw ?? {}) as Record<string, unknown>;
	if (typeof view.state !== "string") throw new Error("gh pr view: state 없음");
	const oid = (view.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
	return {
		state: view.state,
		headRefOid: typeof view.headRefOid === "string" ? view.headRefOid : "",
		mergeCommit: typeof oid === "string" && oid !== "" ? oid : undefined,
		title: typeof view.title === "string" ? view.title : "",
		body: typeof view.body === "string" ? view.body : "",
	};
}

/** The PR's title and body: made of the lane's title and the claim's summary, no file path and no lane file. */
export function prTextOf(input: PrLandInput): { title: string; body: string } {
	const title = input.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
	const body = `${input.summary.trim().slice(0, BODY_MAX)}\n\n---\n레인 \`${input.branch}\` · 커밋 \`${shortSha(input.sha)}\``;
	return { title: title === "" ? input.branch : title, body };
}

/** The `gh pr create` call: the body goes through a private temporary file that is removed afterwards. */
export async function createPr(run: PrRun, slug: string, text: { title: string; body: string }): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-prland-"));
	try {
		const file = join(dir, "body.md");
		writeFileSync(file, text.body, { mode: 0o600 });
		const result = await tool(run, "gh", [
			"pr",
			"create",
			"--repo",
			slug,
			"--base",
			run.input.baseBranch,
			"--head",
			run.input.branch,
			"--title",
			text.title,
			"--body-file",
			file,
		]);
		const url = /https:\/\/[^\s]+\/pull\/\d+/.exec(result.stdout)?.[0];
		if (result.code !== 0 || url === undefined) throw new Error(`gh pr create 실패: ${failureOf(result)}`);
		return url;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The check names a green CI must have: `requiredChecks`, else the jobs of the pushed commit's `ci.yml`. */
export async function requiredChecksOf(run: PrRun, sha: string): Promise<string[]> {
	const configured = run.input.config.requiredChecks;
	if (configured !== undefined && configured.length > 0) return configured;
	const shown = await run.deps.git(["-C", run.input.repo, "show", `${sha}:.github/workflows/ci.yml`]);
	if (shown.code !== 0) return [];
	try {
		const jobs = (Bun.YAML.parse(shown.stdout) as { jobs?: Record<string, { name?: unknown } | null> } | null)?.jobs;
		const names = Object.entries(jobs ?? {}).map(([key, job]) => (typeof job?.name === "string" ? job.name : key));
		// A name that is built at run time (a matrix) cannot be waited for by name.
		return names.filter((name) => !name.includes("${{"));
	} catch {
		return [];
	}
}

async function revParse(git: GitRunner, repo: string, ref: string): Promise<string | undefined> {
	const result = await git(["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Brings the local base branch up to the remote one after the merge (a checkout of it: `merge --ff-only`; none:
 * `update-ref`). The merge stands whatever happens here: what could not be done is the returned `syncNote`.
 */
export async function syncLocalBase(run: PrRun): Promise<string | undefined> {
	const { git } = run.deps;
	const { repo, baseBranch } = run.input;
	await fetchBase(run);
	const tracking = trackingRef(run);
	// The base before the sync is saved first: a run cut off after the ff would otherwise read the moved one.
	if (run.state.preSha === undefined) {
		advance(run, { preSha: (await revParse(git, repo, `refs/heads/${baseBranch}`)) ?? "unknown" });
	}
	const note = (why: string) => `merged-not-synced: 로컬 ${baseBranch} 갱신 필요 — ${why}`;
	const checkout = await checkoutOf(git, repo, baseBranch);
	if (checkout !== undefined) {
		const status = await statusOf(git, checkout);
		if ("failed" in status) return note(status.failed);
		if (status.dirty.length > 0) return note(`${checkout}에 미커밋 변경 ${status.dirty.length}건`);
		const merged = await git(["-C", checkout, "merge", "--ff-only", tracking]);
		return merged.code === 0 ? undefined : note(failureOf(merged));
	}
	const current = await revParse(git, repo, `refs/heads/${baseBranch}`);
	const target = await revParse(git, repo, tracking);
	if (current === undefined || target === undefined || current === target) return undefined;
	if ((await git(["-C", repo, "merge-base", "--is-ancestor", current, target])).code !== 0) {
		return note(`로컬 ${baseBranch}가 ${tracking}의 조상이 아님`);
	}
	const moved = await git(["-C", repo, "update-ref", `refs/heads/${baseBranch}`, target, current]);
	return moved.code === 0 ? undefined : note(failureOf(moved));
}
