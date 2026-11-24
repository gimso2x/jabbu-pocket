import { describe, expect, test } from "bun:test";
import { type CiApi, GITHUB_ACTIONS_APP_ID, readCi } from "../src/lanes/pr-ci";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "owner/repo";

interface Run {
	id: number;
	name: string;
	status?: string;
	conclusion?: string | null;
	head_sha?: string;
	app?: number;
}

function run(id: number, name: string, conclusion: string | null, extra: Partial<Run> = {}): Run {
	return { id, name, status: conclusion === null ? "in_progress" : "completed", conclusion, ...extra };
}

/** A fake `gh api` over `runs` (`perPage` rows a page); `total` overrides the reported `total_count`. */
function apiOf(runs: Run[], opts: { total?: number; perPage?: number } = {}): CiApi & { calls: string[] } {
	const calls: string[] = [];
	const perPage = opts.perPage ?? 100;
	const api = async (endpoint: string) => {
		calls.push(endpoint);
		const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
		const rows = runs.slice((page - 1) * perPage, page * perPage).map((r) => ({
			id: r.id,
			name: r.name,
			status: r.status,
			conclusion: r.conclusion,
			head_sha: r.head_sha ?? SHA,
			html_url: `https://github.com/${REPO}/actions/runs/${r.id}`,
			app: { id: r.app ?? GITHUB_ACTIONS_APP_ID },
		}));
		return { total_count: opts.total ?? runs.length, check_runs: rows };
	};
	return Object.assign(api, { calls });
}

describe("readCi verdicts", () => {
	test("success: every latest Actions run passed (neutral and skipped pass)", async () => {
		const read = await readCi(apiOf([run(1, "test", "success"), run(2, "lint", "skipped")]), REPO, SHA);
		expect(read.verdict).toBe("success");
		expect(read.sha).toBe(SHA);
		expect(read.jobs.map((job) => [job.name, job.state])).toEqual([
			["test", "success"],
			["lint", "neutral"],
		]);
	});

	test("failure names the failed job and its URL", async () => {
		const read = await readCi(apiOf([run(1, "test", "failure"), run(2, "lint", null)]), REPO, SHA);
		expect(read.verdict).toBe("failure");
		expect(read.failed).toEqual([
			{ name: "test", conclusion: "failure", url: `https://github.com/${REPO}/actions/runs/1` },
		]);
	});

	test("pending while one runs", async () => {
		expect((await readCi(apiOf([run(1, "test", "success"), run(2, "e2e", null)]), REPO, SHA)).verdict).toBe("pending");
	});

	test("none when there is no run", async () => {
		expect((await readCi(apiOf([]), REPO, SHA)).verdict).toBe("none");
	});

	test("a required job without a run is pending; jobs outside required are not counted", async () => {
		const api = apiOf([run(1, "test", "success"), run(2, "docs", "failure")]);
		expect((await readCi(api, REPO, SHA, { required: ["test", "e2e"] })).verdict).toBe("pending");
		expect((await readCi(api, REPO, SHA, { required: ["test"] })).verdict).toBe("success");
	});

	test("runs of another head_sha are strangers and do not count", async () => {
		const api = apiOf([run(1, "test", "success", { head_sha: OTHER }), run(2, "test", "failure", { head_sha: OTHER })]);
		expect((await readCi(api, REPO, SHA)).verdict).toBe("none");
		const mixed = apiOf([run(1, "test", null), run(2, "test", "success", { head_sha: OTHER })]);
		expect((await readCi(mixed, REPO, SHA)).verdict).toBe("pending");
	});

	test("a partial answer (total_count not reached) throws", async () => {
		await expect(readCi(apiOf([run(1, "test", "success")], { total: 3 }), REPO, SHA)).rejects.toThrow(
			"incomplete check runs",
		);
	});

	test("a malformed page throws", async () => {
		await expect(readCi(async () => ({ check_runs: "x" }), REPO, SHA)).rejects.toThrow("incomplete check runs");
	});

	test("pages are read until total_count", async () => {
		const runs = [run(1, "a", "success"), run(2, "b", "success"), run(3, "c", "failure")];
		const api = apiOf(runs, { perPage: 2 });
		expect((await readCi(api, REPO, SHA)).verdict).toBe("failure");
		expect(api.calls).toHaveLength(2);
		expect(api.calls[0]).toContain(`repos/${REPO}/commits/${SHA}/check-runs?filter=latest`);
	});

	test("AC-19: a success from another app (not GitHub Actions) never makes it green", async () => {
		expect((await readCi(apiOf([run(1, "test", "success", { app: 99 })]), REPO, SHA)).verdict).toBe("none");
		const required = await readCi(apiOf([run(1, "test", "success", { app: 99 })]), REPO, SHA, { required: ["test"] });
		expect(required.verdict).not.toBe("success");
		const mixed = apiOf([run(1, "test", "success", { app: 99 }), run(2, "lint", "success")]);
		expect((await readCi(mixed, REPO, SHA, { required: ["test", "lint"] })).verdict).toBe("pending");
	});

	test("the latest run of a name wins", async () => {
		const read = await readCi(apiOf([run(5, "test", "success"), run(3, "test", "failure")]), REPO, SHA);
		expect(read.verdict).toBe("success");
		expect(read.jobs).toHaveLength(1);
	});
});
