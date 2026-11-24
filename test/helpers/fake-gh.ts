import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcResult, PrTools } from "../../src/lanes/pr";
import { git } from "./git-fixtures";

/** A GitHub Actions check run as the fake `gh api` lists it for a commit. */
export interface FakeCheckRun {
	name: string;
	status: "completed" | "in_progress";
	conclusion?: "success" | "failure";
	/** Defaults to GitHub Actions (15368). */
	appId?: number;
}

export interface FakePr {
	number: number;
	url: string;
	head: string;
	base: string;
	title: string;
	body: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	/** The branch tip when the PR was last read while the branch existed (a merge deletes the branch). */
	headSha: string;
	mergeCommit?: string;
}

/** One call: `gh` or `git` and its arguments. */
export interface FakeCall {
	program: "gh" | "git";
	argv: string[];
	/** For `gh pr create`: the body file's content when it was read, and its directory. */
	bodyFile?: { path: string; text: string };
}

export interface FakeGhOptions {
	/** `owner/name` the fake serves. */
	slug: string;
	/** The local bare repository that plays GitHub's copy of the repository. */
	bare: string;
	/** `gh pr merge` merges, then answers this exit code (default 0). */
	mergeExit?: number;
}

const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): ProcResult => ({ code, stdout: "", stderr });

/**
 * A fake `gh` over a local bare repository: pull requests live in memory, `gh pr merge --squash` really squashes the
 * branch onto the bare repository's base branch (so `fetch` and the local fast-forward can be checked), and `gh api`
 * answers check runs from `ci`. `tools.git` is the real git with every call recorded; nothing leaves this machine.
 */
export class FakeGh {
	readonly calls: FakeCall[] = [];
	readonly prs: FakePr[] = [];
	/** Check runs by commit; a commit without an entry has none. */
	readonly ci = new Map<string, FakeCheckRun[]>();
	/** Every temporary directory a `--body-file` lived in. */
	readonly bodyDirs: string[] = [];
	mergeExit: number;
	readonly tools: PrTools;
	readonly #options: FakeGhOptions;
	#runId = 1000;

	constructor(options: FakeGhOptions) {
		this.#options = options;
		this.mergeExit = options.mergeExit ?? 0;
		this.tools = {
			git: async (argv, { cwd }) => {
				this.calls.push({ program: "git", argv });
				try {
					return ok(git(cwd, ...argv));
				} catch (error) {
					const failed = error as { status?: number; stderr?: Buffer | string };
					return fail(String(failed.stderr ?? error), failed.status ?? 1);
				}
			},
			gh: async (argv) => this.#gh(argv),
		};
	}

	/** Calls of `program` whose arguments contain all of `words`. */
	callsOf(program: "gh" | "git", ...words: string[]): FakeCall[] {
		return this.calls.filter((call) => call.program === program && words.every((word) => call.argv.includes(word)));
	}

	/** Sets the check runs of `sha`: one run per job, all with one outcome. */
	setCi(sha: string, outcome: "success" | "failure" | "pending", jobs: string[] = ["test"]): void {
		this.ci.set(
			sha,
			jobs.map((name) => ({
				name,
				status: outcome === "pending" ? "in_progress" : "completed",
				...(outcome === "pending" ? {} : { conclusion: outcome }),
			})),
		);
	}

	#bare(...args: string[]): string {
		return git(this.#options.bare, ...args);
	}

	#tip(branch: string): string | undefined {
		try {
			return this.#bare("rev-parse", "--verify", "-q", `refs/heads/${branch}`);
		} catch {
			return undefined;
		}
	}

	#flag(argv: string[], name: string): string {
		return argv[argv.indexOf(name) + 1] ?? "";
	}

	#find(argv: string[]): FakePr | undefined {
		return this.prs.find((pr) => String(pr.number) === argv[2]);
	}

	#gh(argv: string[]): ProcResult {
		const call: FakeCall = { program: "gh", argv };
		this.calls.push(call);
		const [group, verb] = argv;
		if (group === "api") return this.#api(argv.at(-1) ?? "");
		if (group !== "pr") return fail(`fake gh: unknown command ${argv.join(" ")}`);
		if (verb === "list") return this.#list(argv);
		if (verb === "create") return this.#create(argv, call);
		if (verb === "view") return this.#view(argv);
		if (verb === "merge") return this.#merge(argv);
		return fail(`fake gh: unknown pr command ${verb}`);
	}

	#api(endpoint: string): ProcResult {
		const sha = /\/commits\/([0-9a-f]+)\/check-runs/.exec(endpoint)?.[1] ?? "";
		const runs = (this.ci.get(sha) ?? []).map((run) => ({
			id: this.#runId++,
			name: run.name,
			status: run.status,
			conclusion: run.conclusion ?? null,
			html_url: `https://github.com/${this.#options.slug}/actions/runs/${this.#runId}`,
			head_sha: sha,
			app: { id: run.appId ?? 15368 },
		}));
		return ok(JSON.stringify({ total_count: runs.length, check_runs: runs }));
	}

	#list(argv: string[]): ProcResult {
		const head = this.#flag(argv, "--head");
		const open = this.prs.filter((pr) => pr.head === head && pr.state === "OPEN");
		return ok(JSON.stringify(open.map((pr) => ({ number: pr.number, url: pr.url }))));
	}

	#create(argv: string[], call: FakeCall): ProcResult {
		const path = this.#flag(argv, "--body-file");
		call.bodyFile = { path, text: existsSync(path) ? readFileSync(path, "utf8") : "" };
		this.bodyDirs.push(dirname(path));
		const head = this.#flag(argv, "--head");
		const headSha = this.#tip(head);
		if (headSha === undefined) return fail(`fake gh: head branch ${head} is not on the remote`);
		const number = this.prs.length + 1;
		const url = `https://github.com/${this.#options.slug}/pull/${number}`;
		this.prs.push({
			number,
			url,
			head,
			base: this.#flag(argv, "--base"),
			title: this.#flag(argv, "--title"),
			body: call.bodyFile.text,
			state: "OPEN",
			headSha,
		});
		return ok(`${url}\n`);
	}

	#view(argv: string[]): ProcResult {
		const pr = this.#find(argv);
		if (pr === undefined) return fail("fake gh: no such pull request");
		const live = pr.state === "OPEN" ? this.#tip(pr.head) : undefined;
		return ok(
			JSON.stringify({
				state: pr.state,
				headRefOid: live ?? pr.headSha,
				mergeCommit: pr.mergeCommit === undefined ? null : { oid: pr.mergeCommit },
				title: pr.title,
				body: pr.body,
			}),
		);
	}

	/** Squashes the PR branch onto the base branch of the bare repository (a scratch clone does the work). */
	#squash(pr: FakePr): string {
		const scratch = mkdtempSync(join(tmpdir(), "ompbot-fake-gh-"));
		try {
			git(scratch, "clone", "-q", this.#options.bare, "work");
			const work = join(scratch, "work");
			git(work, "merge", "--squash", `origin/${pr.head}`);
			git(work, "commit", "-q", "-m", `${pr.title}\n\n${pr.body}`);
			git(work, "push", "-q", "origin", `HEAD:refs/heads/${pr.base}`);
			return git(work, "rev-parse", "HEAD");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	#merge(argv: string[]): ProcResult {
		const pr = this.#find(argv);
		if (pr === undefined) return fail("fake gh: no such pull request");
		if (pr.state !== "OPEN") return fail(`fake gh: pull request is ${pr.state}`);
		const pinned = this.#flag(argv, "--match-head-commit");
		const tip = this.#tip(pr.head);
		if (pinned !== "" && tip !== pinned) return fail("Head branch was modified. Review and try the merge again.");
		pr.headSha = tip ?? pr.headSha;
		pr.mergeCommit = this.#squash(pr);
		pr.state = "MERGED";
		if (argv.includes("--delete-branch")) this.#bare("update-ref", "-d", `refs/heads/${pr.head}`);
		return this.mergeExit === 0 ? ok("") : fail("failed to delete local branch lane/x", this.mergeExit);
	}
}
