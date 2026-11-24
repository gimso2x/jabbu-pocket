import { safeText, safeUrl } from "./pr-watch";

/**
 * The CI of one pushed commit as a PR landing judges it: the latest GitHub Actions
 * check runs of exactly that commit. Read-only; a partial or malformed answer throws (the caller keeps its state).
 */

export type CiVerdict = "success" | "failure" | "pending" | "none";
export interface CiJob {
	name: string;
	state: "success" | "failure" | "pending" | "neutral";
	url: string;
	id: number;
}
export interface CiRead {
	/** The commit read; the caller compares it with the PR head. */
	sha: string;
	verdict: CiVerdict;
	/** Latest run per name. */
	jobs: CiJob[];
	failed: Array<{ name: string; conclusion: string; url: string }>;
}

/** `gh api --method GET <endpoint>` as JSON (`ghApiOf`). */
export type CiApi = (endpoint: string) => Promise<unknown>;

/** The GitHub Actions app: a check run of any other app never makes a commit green. */
export const GITHUB_ACTIONS_APP_ID = 15368;
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const PASSING = new Set(["success", "neutral", "skipped"]);
const PAGE = 100;
const PAGES_MAX = 5;

const rec = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Every check run of `sha` (`filter=latest`), all pages; throws when the pages do not add up to `total_count`. */
async function checkRuns(api: CiApi, repo: string, sha: string): Promise<Record<string, unknown>[]> {
	const runs: Record<string, unknown>[] = [];
	let total: number | undefined;
	for (let page = 1; page <= PAGES_MAX && (total === undefined || runs.length < total); page++) {
		const body = rec(await api(`repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${PAGE}&page=${page}`));
		if (body === undefined || !Array.isArray(body.check_runs) || typeof body.total_count !== "number") {
			throw new Error("incomplete check runs");
		}
		total ??= body.total_count;
		if (body.check_runs.length === 0) break;
		for (const raw of body.check_runs) {
			const run = rec(raw);
			if (run === undefined || typeof run.id !== "number" || typeof run.name !== "string") {
				throw new Error("incomplete check runs");
			}
			runs.push(run);
		}
	}
	if (runs.length !== total) throw new Error("incomplete check runs");
	return runs;
}

function stateOf(run: Record<string, unknown>): CiJob["state"] {
	if (run.status !== "completed") return "pending";
	const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
	if (FAILING.has(conclusion)) return "failure";
	if (conclusion === "success") return "success";
	return PASSING.has(conclusion) ? "neutral" : "pending";
}

/**
 * The verdict of `sha`: only GitHub Actions runs whose `head_sha` is `sha` count, the latest per name. `failure` =
 * a counted job failed; `pending` = one still runs, or a `required` name has no run; `none` = no run at all;
 * `success` = everything counted passed. With `required` only those names are counted.
 */
export async function readCi(
	api: CiApi,
	repo: string,
	sha: string,
	opts: { required?: readonly string[] } = {},
): Promise<CiRead> {
	const latest = new Map<string, { job: CiJob; conclusion: string }>();
	for (const run of await checkRuns(api, repo, sha)) {
		if (run.head_sha !== sha || rec(run.app)?.id !== GITHUB_ACTIONS_APP_ID) continue;
		const name = safeText(String(run.name), 200);
		const id = run.id as number;
		const held = latest.get(name);
		if (held !== undefined && held.job.id > id) continue;
		const url = safeUrl(typeof run.html_url === "string" ? run.html_url : null);
		const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
		latest.set(name, { job: { name, state: stateOf(run), url, id }, conclusion });
	}
	const jobs = [...latest.values()].map((entry) => entry.job);
	const required = opts.required ?? [];
	const counted =
		required.length === 0 ? [...latest.values()] : [...latest.values()].filter((e) => required.includes(e.job.name));
	const failed = counted
		.filter((entry) => entry.job.state === "failure")
		.map((entry) => ({ name: entry.job.name, conclusion: entry.conclusion, url: entry.job.url }));
	let verdict: CiVerdict;
	if (jobs.length === 0) verdict = "none";
	else if (failed.length > 0) verdict = "failure";
	else if (counted.some((entry) => entry.job.state === "pending") || required.some((name) => !latest.has(name))) {
		verdict = "pending";
	} else verdict = "success";
	return { sha, verdict, jobs, failed };
}
