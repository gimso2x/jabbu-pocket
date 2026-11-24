import { cleanUp, worktreeDrift } from "./land";
import { githubRepoOfUrl } from "./pr";
import { type CiRead, readCi } from "./pr-ci";
import {
	advance,
	createPr,
	failureOf,
	fetchBase,
	ghJson,
	newRun,
	type PrLandDeps,
	type PrLandInput,
	type PrRun,
	prTextOf,
	requiredChecksOf,
	shortSha,
	syncLocalBase,
	tool,
	trackingRef,
	viewPr,
} from "./pr-land-steps";
import type { LanePrLand, PrLandOutcome, PrStep } from "./pr-land-types";
import { ghApiOf } from "./pr-watch";

/**
 * A closed lane's own-repository landing as a pull request: leak check, push of the
 * lane branch, `gh pr create`, CI wait, squash merge pinned to the checked commit, local base sync, cleanup. Plain
 * functions over injected git/gh: each step is saved the moment it is done (`deps.save`) and a run continues from the
 * saved step, so a process cut off anywhere finds its way on without a second push, PR or merge.
 */

const CI_GRACE_MS = 300_000;
const CI_TIMEOUT_MS = 3_600_000;
export const BOUNCES_MAX = 3;
const HITS_SHOWN = 5;
const POLL_STEPS: ReadonlySet<PrStep | undefined> = new Set(["pr-created", "ci-green", "merging", "merged", "synced"]);

const blocked = (reason: string): PrLandOutcome => ({ kind: "blocked", reason });
const held = (reason: string): PrLandOutcome => ({ kind: "held", reason: `보류: ${reason}` });

/** What a lane sent back for a new commit keeps: the PR and the failure it was sent back for, no step. */
export function reworkedPrLand(prLand: LanePrLand): LanePrLand {
	const { number, url, branch, slug, pushedSha, failedSig, bounces } = prLand;
	return {
		branch,
		...(number === undefined ? {} : { number }),
		...(url === undefined ? {} : { url }),
		...(slug === undefined ? {} : { slug }),
		...(pushedSha === undefined ? {} : { pushedSha }),
		...(failedSig === undefined ? {} : { failedSig }),
		...(bounces === undefined ? {} : { bounces }),
	};
}

/** Whether `prLand` is past the open (the PR exists): the next run polls instead of opening. */
export const isPollStep = (prLand: LanePrLand | undefined): boolean => POLL_STEPS.has(prLand?.step);

/** Gate: re-run checks on this commit, a clean worktree at the claim, the base not ahead, the leak check. */
async function gate(run: PrRun): Promise<PrLandOutcome | undefined> {
	const { input, deps } = run;
	if (input.checksHead !== input.sha)
		return blocked("재실행 검사가 이 커밋에서 돌지 않았습니다 — 레인이 다시 완료를 주장해야 합니다.");
	const drift = await (deps.worktree === undefined
		? worktreeDrift(deps.git, input.worktree, input.sha)
		: deps.worktree.drift());
	if (drift !== undefined) {
		if ("failed" in drift) return blocked(drift.failed);
		return blocked(
			"dirty" in drift
				? `worktree에 미커밋 변경 ${drift.dirty.length}건이 있습니다.`
				: `worktree HEAD(${shortSha(drift.head)})가 claim 커밋이 아닙니다.`,
		);
	}
	await fetchBase(run);
	const tracking = trackingRef(run);
	const ancestor = await deps.git(["-C", input.repo, "merge-base", "--is-ancestor", tracking, input.sha]);
	if (ancestor.code === 1) {
		return {
			kind: "rework",
			reason: `\`${tracking}\`가 앞서 있습니다`,
			notice: `\`${tracking}\`가 앞서 있음: 같은 브랜치에서 \`git merge ${tracking}\`로 합친 뒤(rebase·amend·force push 금지) 다시 완료를 주장하세요.`,
			prLand: run.state,
		};
	}
	if (ancestor.code !== 0) throw new Error(`git merge-base 실패: ${failureOf(ancestor)}`);
	if (input.denylistFile === undefined) return blocked("recordsRepo가 없어 누출 검사를 할 수 없습니다.");
	const leaks = await deps.checkLeaks({
		repo: input.repo,
		base: `refs/remotes/${tracking}`,
		sha: input.sha,
		denylistFile: input.denylistFile,
		gitleaks: deps.gitleaks,
		texts: { "pr-title": prTextOf(input).title, "pr-body": prTextOf(input).body },
	});
	if (!leaks.ok) {
		const shown = leaks.hits.slice(0, HITS_SHOWN).join(", ");
		return blocked(
			`누출 검사 실패 ${leaks.hits.length}건${shown === "" ? "" : `: ${shown}`}${leaks.reason === undefined ? "" : ` (${leaks.reason})`}`,
		);
	}
	deps.crash?.("leak-passed");
	advance(run, { step: "leak-checked" });
	return undefined;
}

/** Pushes the lane branch to the remote (never forced), unless the remote has the commit already. */
async function pushBranch(run: PrRun): Promise<PrLandOutcome | undefined> {
	const { input, remote } = run;
	const url = await run.deps.git(["-C", input.repo, "config", "--get", `remote.${remote}.url`]);
	const slug = url.code === 0 ? githubRepoOfUrl(url.stdout.trim()) : undefined;
	if (slug === undefined) return blocked(`원격 ${remote}가 GitHub 저장소 주소가 아닙니다.`);
	const ref = `refs/heads/${input.branch}`;
	const listed = await tool(run, "git", ["-C", input.repo, "ls-remote", remote, ref]);
	if (listed.code !== 0) throw new Error(`git ls-remote ${remote} 실패: ${failureOf(listed)}`);
	if (listed.stdout.trim().split(/\s+/)[0] !== input.sha) {
		const pushed = await tool(run, "git", ["-C", input.repo, "push", remote, `${input.sha}:${ref}`]);
		if (pushed.code !== 0) {
			if (/rejected|non-fast-forward|fetch first/i.test(`${pushed.stderr}${pushed.stdout}`)) {
				return blocked(
					"원격 브랜치가 앞서 있음(비-ff): 레인 브랜치를 force push하지 않습니다. `!reopen`으로 새 커밋을 쌓거나 폐기하세요.",
				);
			}
			throw new Error(`git push ${remote} 실패: ${failureOf(pushed)}`);
		}
	}
	advance(run, { pushedSha: input.sha, pushedAt: run.deps.now(), slug }, "push-done");
	advance(run, { step: "pushed" });
	return undefined;
}

/** The lane's PR: the number kept from before, an open PR of the branch, or a new one. */
async function ensurePr(run: PrRun): Promise<void> {
	const { input } = run;
	const slug = String(run.state.slug);
	if (run.state.number !== undefined) {
		advance(run, { step: "pr-created" });
		return;
	}
	const listed = await ghJson(run, [
		"pr",
		"list",
		"--repo",
		slug,
		"--head",
		input.branch,
		"--state",
		"open",
		"--json",
		"number,url",
	]);
	const open = Array.isArray(listed) ? (listed[0] as { number?: unknown; url?: unknown } | undefined) : undefined;
	if (typeof open?.number === "number" && typeof open.url === "string") {
		advance(run, { number: open.number, url: open.url, createdAt: run.deps.now(), step: "pr-created" });
		return;
	}
	const url = await createPr(run, slug, prTextOf(input));
	advance(
		run,
		{ number: Number(/\/(\d+)$/.exec(url)?.[1]), url, createdAt: run.deps.now(), step: "pr-created" },
		"create-done",
	);
}

/** Opens the landing: gate, push, PR; ends with `pr-open` (CI to be waited for) or why it stopped. */
export async function openPrLanding(input: PrLandInput, deps: PrLandDeps): Promise<PrLandOutcome> {
	const run = newRun(input, deps);
	if (run.state.step === undefined) {
		const stop = await gate(run);
		if (stop !== undefined) return stop;
	}
	if (run.state.step === "leak-checked") {
		const stop = await pushBranch(run);
		if (stop !== undefined) return stop;
	}
	if (run.state.step === "pushed") await ensurePr(run);
	return { kind: "pr-open", prLand: run.state };
}

const failureSig = (ci: CiRead): string =>
	ci.failed
		.map((job) => `${job.name}#${ci.jobs.find((entry) => entry.name === job.name)?.id ?? 0}`)
		.sort()
		.join("|");

/** What a CI read means for a PR that is still waiting for it. */
function judgeCi(run: PrRun, ci: CiRead): PrLandOutcome | undefined {
	const { state, deps, input } = run;
	const now = deps.now();
	const waited = now - (state.pushedAt ?? 0);
	const keep = (): PrLandOutcome => {
		deps.save({ ...state, lastPolledAt: now, ci: { verdict: ci.verdict, sha: ci.sha } });
		return { kind: "waiting" };
	};
	switch (ci.verdict) {
		case "success":
			advance(run, { lastPolledAt: now, ci: { verdict: "success", sha: ci.sha }, step: "ci-green" });
			return undefined;
		case "none":
			return waited < (input.config.ciGraceMs ?? CI_GRACE_MS)
				? keep()
				: held("CI가 돌지 않음 — 이 커밋에 체크가 하나도 없습니다.");
		case "pending":
			return waited >= (input.config.ciTimeoutMs ?? CI_TIMEOUT_MS) ? held("CI 시간 초과") : keep();
		case "failure": {
			const sig = failureSig(ci);
			const bounces = (state.bounces ?? 0) + 1;
			if (sig === state.failedSig)
				return blocked("같은 CI 실패가 고쳐지지 않음 — 레인이 새 커밋 없이 다시 완료를 주장했습니다.");
			if (bounces > BOUNCES_MAX) return blocked(`CI가 ${BOUNCES_MAX}번 반송된 뒤에도 빨강입니다.`);
			const lines = ci.failed.map((job) => `• ${job.name} (${job.conclusion})${job.url === "" ? "" : ` ${job.url}`}`);
			return {
				kind: "rework",
				reason: `CI 실패: ${ci.failed.map((job) => job.name).join(", ")}`,
				notice: ["🔴 CI가 실패했습니다:", ...lines].join("\n"),
				prLand: { ...state, failedSig: sig, bounces },
			};
		}
	}
}

/** `pr-created`: the PR's state and head, then the CI of the pushed commit. */
async function watchCi(run: PrRun): Promise<PrLandOutcome | undefined> {
	const { state, deps, input } = run;
	let ci: CiRead;
	try {
		const view = await viewPr(run);
		if (view.state === "MERGED") {
			advance(run, { ...(view.mergeCommit === undefined ? {} : { mergedSha: view.mergeCommit }), step: "merged" });
			return undefined;
		}
		if (view.state === "CLOSED") return held("PR이 머지 없이 닫혔습니다.");
		if (view.headRefOid !== state.pushedSha)
			return held(`PR head가 바뀜(${shortSha(view.headRefOid)}) — 검사한 커밋이 아닙니다.`);
		const api = ghApiOf(deps.tools, { cwd: input.repo, signal: deps.signal });
		ci = await readCi(api, String(state.slug), String(state.pushedSha), {
			required: await requiredChecksOf(run, String(state.pushedSha)),
		});
	} catch (error) {
		return { kind: "waiting", warn: String(error).slice(0, 300) };
	}
	return judgeCi(run, ci);
}

/** `ci-green` and `merging`: the leak check once more, then the squash merge pinned to the checked commit. */
async function mergePr(run: PrRun): Promise<PrLandOutcome | undefined> {
	const { input, deps } = run;
	const pinned = String(run.state.pushedSha);
	if (input.frozen) return { kind: "waiting" };
	const view = await viewPr(run);
	if (view.state === "MERGED") {
		advance(run, { ...(view.mergeCommit === undefined ? {} : { mergedSha: view.mergeCommit }), step: "merged" });
		return undefined;
	}
	if (view.state === "CLOSED") return held("PR이 머지 없이 닫혔습니다.");
	if (run.state.step === "ci-green") {
		if (view.headRefOid !== pinned)
			return held(`PR head가 바뀜(${shortSha(view.headRefOid)}) — 검사한 커밋이 아닙니다.`);
		if (input.denylistFile === undefined) return blocked("recordsRepo가 없어 누출 검사를 할 수 없습니다.");
		await fetchBase(run);
		const leaks = await deps.checkLeaks({
			repo: input.repo,
			base: `refs/remotes/${trackingRef(run)}`,
			sha: pinned,
			denylistFile: input.denylistFile,
			gitleaks: deps.gitleaks,
			texts: { "pr-title": view.title, "pr-body": view.body },
		});
		if (!leaks.ok) {
			const shown = leaks.hits.slice(0, HITS_SHOWN).join(", ");
			return blocked(
				`머지 직전 누출 검사 실패 ${leaks.hits.length}건${shown === "" ? "" : `: ${shown}`}${leaks.reason === undefined ? "" : ` (${leaks.reason})`}`,
			);
		}
		advance(run, { step: "merging" });
	}
	const merged = await tool(run, "gh", [
		"pr",
		"merge",
		String(run.state.number),
		"--repo",
		String(run.state.slug),
		"--squash",
		"--delete-branch",
		"--match-head-commit",
		pinned,
	]);
	deps.crash?.("merge-done");
	// The exit code is not trusted (`--delete-branch` may fail on the local branch after the merge): the PR says.
	const after = await viewPr(run);
	if (after.state !== "MERGED") return held(`머지 실패: ${failureOf(merged)}`);
	advance(run, { ...(after.mergeCommit === undefined ? {} : { mergedSha: after.mergeCommit }), step: "merged" });
	return undefined;
}

/** Continues a landing whose PR exists, step by step, up to `landed` or the point it has to wait or stop. */
export async function pollPrLanding(input: PrLandInput, deps: PrLandDeps): Promise<PrLandOutcome> {
	const run = newRun(input, deps);
	if (run.state.number === undefined || run.state.slug === undefined || run.state.pushedSha === undefined) {
		return blocked("PR 착지 기록에 번호·저장소·커밋이 없습니다.");
	}
	for (;;) {
		let stop: PrLandOutcome | undefined;
		switch (run.state.step) {
			case "pr-created":
				stop = await watchCi(run);
				break;
			case "ci-green":
			case "merging":
				stop = await mergePr(run);
				break;
			case "merged": {
				const syncNote = await syncLocalBase(run);
				deps.crash?.("ff-done");
				advance(run, { ...(syncNote === undefined ? {} : { syncNote }), step: "synced" });
				break;
			}
			case "synced":
				return await finish(run);
			default:
				return blocked(`PR 착지 단계를 알 수 없습니다: ${String(run.state.step)}`);
		}
		if (stop !== undefined) return stop;
	}
}

/** `synced`: the lane's worktree and branch go; what could not be done is told to the owner next to the sync note. */
async function finish(run: PrRun): Promise<PrLandOutcome> {
	const { input, deps, state } = run;
	const left = await (deps.worktree === undefined
		? cleanUp(
				deps.git,
				{
					repo: input.repo,
					baseBranch: input.baseBranch,
					branch: input.branch,
					worktree: input.worktree,
					sha: String(state.pushedSha),
					push: false,
				},
				{ removeWorktree: deps.removeWorktree },
				deps.beforeCleanup === undefined ? {} : { beforeCleanup: deps.beforeCleanup },
			)
		: deps.worktree.cleanUp());
	const cleanup = [state.syncNote, left].filter((part): part is string => part !== undefined).join(" · ");
	return {
		kind: "landed",
		mergedSha: state.mergedSha ?? "unknown",
		pushed: trackingRef(run),
		preSha: state.preSha ?? "unknown",
		...(cleanup === "" ? {} : { cleanup }),
	};
}

/** The one entry the lane manager calls: continues the landing from its saved step. */
export const runPrLanding = (input: PrLandInput, deps: PrLandDeps): Promise<PrLandOutcome> =>
	isPollStep(input.prLand) ? pollPrLanding(input, deps) : openPrLanding(input, deps);
