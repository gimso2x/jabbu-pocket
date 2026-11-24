import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneLandRepoConfig } from "../src/config-validate";
import { pollPrLanding } from "../src/lanes/pr-land";
import { PR_LAND_POLL_MS, type PrLandDeps, type PrLandInput } from "../src/lanes/pr-land-steps";
import type { LanePrLand } from "../src/lanes/pr-land-types";
import type { LaneRow } from "../src/lanes/status";
import { checkLeaks } from "../src/release/leak-check";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { FakeGh } from "./helpers/fake-gh";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// Own-repository PR landing: real git in temp directories, a local bare repository as the
// GitHub copy of the repository (the remote URL is a GitHub address that `insteadOf` points at it), a fake `gh`.

const SLUG = "acme/widgets";
const GITHUB_URL = `https://github.com/${SLUG}.git`;
// Planted denylist marker (not an owner identifier: the real denylist is never read here).
const PLANTED = "planted-owner-marker-7310";
const CHECK_A = 'a.txt가 있다 [check: command ["sh","-c","test -f a.txt"]]';

let home: TestHome;
let repos: string[];
let scratch: string[];

beforeEach(() => {
	home = makeHome("ompbot-pr-land-home-");
	repos = [];
	scratch = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

const headOf = (dir: string, ref = "HEAD"): string => git(dir, "rev-parse", ref);

/** Commits `files` in `dir`, each with `content` (default: its name); returns the new HEAD. */
function commitIn(dir: string, files: string[], content?: string, ...config: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), content ?? `${file}\n`);
	git(dir, "add", "--", ...files);
	git(dir, ...config, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return headOf(dir);
}

interface Fixture {
	repo: string;
	bare: string;
	fake: FakeGh;
	config: LaneLandRepoConfig;
	denylistFile: string;
	gitleaks: string;
	/** `requestApproval` calls: a PR landing never asks. */
	approvals: number;
	/** Calls of the real leak check. */
	leakChecks: number;
}

/** A repository whose `origin` is a GitHub address backed by a local bare repository, plus the fake `gh` over it. */
function fixture(config: Partial<LaneLandRepoConfig> = {}): Fixture {
	const repo = makeRepo(repos);
	const bare = tempDir("ompbot-pr-land-bare-");
	git(bare, "init", "-q", "--bare");
	git(repo, "remote", "add", "origin", GITHUB_URL);
	git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
	git(repo, "push", "-q", "origin", "main");
	const records = tempDir("ompbot-pr-land-records-");
	const denylistFile = join(records, "denylist.txt");
	writeFileSync(denylistFile, `# planted\n${PLANTED}\n`);
	// A gitleaks that finds nothing: the leak check itself (git, denylist) is the real one.
	const gitleaks = join(records, "gitleaks");
	writeFileSync(gitleaks, "#!/bin/sh\nexit 0\n");
	chmodSync(gitleaks, 0o755);
	return {
		repo,
		bare,
		fake: new FakeGh({ slug: SLUG, bare }),
		config: { mode: "pr", ...config },
		denylistFile,
		gitleaks,
		approvals: 0,
		leakChecks: 0,
	};
}

function prHarness(fx: Fixture, extra: Parameters<typeof laneHarness>[1] = {}): LaneHarness {
	return laneHarness(home.dir, {
		prTools: fx.fake.tools,
		landMode: async () => ({ config: fx.config, denylistFile: fx.denylistFile }),
		prLandSeams: {
			gitleaks: fx.gitleaks,
			checkLeaks: (input) => {
				fx.leakChecks += 1;
				return checkLeaks(input);
			},
		},
		requestApproval: async () => {
			fx.approvals += 1;
			throw new Error("a PR landing must not ask for an approval");
		},
		...extra,
	});
}

function requireLane(h: LaneHarness, name: string): LaneRow {
	const lane = h.store.getLane(name);
	if (lane === undefined) throw new Error(`no lane ${name}`);
	return lane;
}

interface Closed {
	name: string;
	originKey: string;
	cwd: string;
	branch: string;
	sha: string;
}

async function startLane(
	h: LaneHarness,
	repo: string,
): Promise<Closed & { claim(files: string[], content?: string): Promise<string> }> {
	const started = await h.manager.start({
		title: "land",
		cwd: repo,
		channel: CHANNEL,
		acceptance: [CHECK_A],
		risk: "L2",
	});
	await h.settle();
	const claim = async (files: string[], content?: string): Promise<string> => {
		const sha = commitIn(started.cwd, files, content);
		const answer = await h.manager.claimDone(started.originKey, {
			repo: started.cwd,
			commit: "HEAD",
			summary: "a.txt 추가",
		});
		expect(answer).toContain("검증 통과");
		await h.settle();
		return sha;
	};
	const branch = requireLane(h, started.name).meta.branch ?? "";
	return { name: started.name, originKey: started.originKey, cwd: started.cwd, branch, sha: "", claim };
}

/** A lane with one commit (`a.txt`) claimed and closed, its landing pending. */
async function closeLane(h: LaneHarness, repo: string): Promise<Closed> {
	const lane = await startLane(h, repo);
	return { ...lane, sha: await lane.claim(["a.txt"]) };
}

/** The owner asks for the merge and the background work settles. */
async function land(h: LaneHarness, name: string): Promise<void> {
	await h.manager.requestLand(name, "owner");
	await h.settle();
}

/** The next poll: past the interval, one tick, background work settled. */
async function poll(h: LaneHarness): Promise<void> {
	h.advance(PR_LAND_POLL_MS + 1);
	await h.manager.tick();
	await h.settle();
}

/** The lane after `land`: its PR is open. */
async function openLane(fx: Fixture, h: LaneHarness): Promise<Closed> {
	const lane = await closeLane(h, fx.repo);
	await land(h, lane.name);
	expect(requireLane(h, lane.name).meta.land?.state).toBe("pr-open");
	return lane;
}

const landOf = (h: LaneHarness, name: string) => requireLane(h, name).meta.land;
const pushes = (fx: Fixture) => fx.fake.callsOf("git", "push");
const ghCalls = (fx: Fixture) => fx.fake.calls.filter((call) => call.program === "gh");
const reasonOf = (h: LaneHarness, name: string): string => landOf(h, name)?.reason ?? "";

/** Nothing the planted text matched is in the lane, its logs, the thread or the fake's records. */
function expectNoPlanted(fx: Fixture, h: LaneHarness, name: string): void {
	const seen = JSON.stringify([requireLane(h, name), h.logs, h.transport.calls, fx.fake.calls.map((c) => c.argv)]);
	expect(seen).not.toContain(PLANTED);
}

describe("AC-3 게이트: push·gh 호출 0회로 blocked", () => {
	test("AC-3 meta.checks.head가 claim과 다르면 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await closeLane(h, fx.repo);
		const { checks } = requireLane(h, lane.name).meta;
		h.store.patchLane(lane.name, undefined, {
			checks: { ...checks, head: "0".repeat(40), results: checks?.results ?? [] },
		});
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("재실행 검사");
		expect(pushes(fx)).toHaveLength(0);
		expect(ghCalls(fx)).toHaveLength(0);
		h.close();
	});

	test("AC-3 worktree에 미커밋 변경이 있으면 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await closeLane(h, fx.repo);
		writeFileSync(join(lane.cwd, "wip.txt"), "wip\n");
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("미커밋 변경");
		expect(pushes(fx)).toHaveLength(0);
		expect(ghCalls(fx)).toHaveLength(0);
		h.close();
	});

	test("AC-3 누출 검사에 걸리면 blocked: 일치한 글자는 어디에도 없다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await startLane(h, fx.repo);
		await lane.claim(["a.txt"], `${PLANTED}\n`);
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("누출 검사 실패 1건");
		expect(reasonOf(h, lane.name)).toContain("a.txt:1 (denylist)");
		expect(pushes(fx)).toHaveLength(0);
		expect(ghCalls(fx)).toHaveLength(0);
		expectNoPlanted(fx, h, lane.name);
		h.close();
	});

	test("AC-3 base가 앞서 있으면 레인으로 되돌린다(`git merge`로 합치라고, rebase·force push 금지): push·gh 0회", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await closeLane(h, fx.repo);
		commitIn(fx.repo, ["elsewhere.txt"]);
		git(fx.repo, "push", "-q", "origin", "main");
		await land(h, lane.name);
		expect(requireLane(h, lane.name).status).toBe("working");
		expect(pushes(fx)).toHaveLength(0);
		expect(ghCalls(fx)).toHaveLength(0);
		const prompts = h.drivers.get(lane.originKey)?.calls.filter((call) => call.includes("git merge origin/main")) ?? [];
		expect(prompts.length).toBeGreaterThan(0);
		expect(landOf(h, lane.name)?.prLand?.step).toBeUndefined();
		h.close();
	});
});

describe("AC-6 PR 생성", () => {
	test("AC-6 origin에 레인 브랜치를 force 없이 push하고, 본문은 임시 파일로 넘기고, 끝나면 그 디렉터리가 없다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		const pushed = pushes(fx);
		expect(pushed).toHaveLength(1);
		expect(pushed[0]?.argv.slice(-3)).toEqual(["push", "origin", `${lane.sha}:refs/heads/${lane.branch}`]);
		expect(pushed[0]?.argv.some((arg) => arg.includes("force") || arg.startsWith("+") || arg === "-f")).toBe(false);
		expect(headOf(fx.bare, `refs/heads/${lane.branch}`)).toBe(lane.sha);
		expect(fx.fake.callsOf("gh", "fork")).toHaveLength(0);
		const created = fx.fake.callsOf("gh", "pr", "create");
		expect(created).toHaveLength(1);
		expect(created[0]?.argv).toContain("--body-file");
		const body = created[0]?.bodyFile;
		expect(body?.text).toContain("a.txt 추가");
		expect(body?.text).not.toContain(lane.cwd);
		expect(fx.fake.bodyDirs).toHaveLength(1);
		expect(existsSync(fx.fake.bodyDirs[0] ?? "")).toBe(false);
		expect(landOf(h, lane.name)).toMatchObject({
			state: "pr-open",
			mode: "pr",
			prLand: { number: 1, step: "pr-created" },
		});
		h.close();
	});

	test("AC-6 이미 열린 PR이 있으면 `gh pr create`를 부르지 않고 그 번호를 쓴다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await closeLane(h, fx.repo);
		git(lane.cwd, "push", "-q", "origin", `${lane.sha}:refs/heads/${lane.branch}`);
		fx.fake.prs.push({
			number: 7,
			url: `https://github.com/${SLUG}/pull/7`,
			head: lane.branch,
			base: "main",
			title: "land",
			body: "",
			state: "OPEN",
			headSha: lane.sha,
		});
		await land(h, lane.name);
		expect(fx.fake.callsOf("gh", "pr", "create")).toHaveLength(0);
		expect(landOf(h, lane.name)?.prLand).toMatchObject({ number: 7, step: "pr-created" });
		h.close();
	});
});

describe("AC-7·AC-10·AC-12 착지 전체", () => {
	test("AC-7 승인 카드 0회, AC-10 squash 머지는 검사한 sha에 고정, AC-12 로컬 base == origin/base·worktree·브랜치 제거", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		const before = headOf(fx.repo);
		fx.fake.setCi(lane.sha, "success");
		await poll(h);
		const landed = landOf(h, lane.name);
		expect(landed).toMatchObject({ state: "landed", pushed: "origin/main", preSha: before });
		expect(fx.approvals).toBe(0);
		const merges = fx.fake.callsOf("gh", "merge");
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toEqual(
			expect.arrayContaining(["--squash", "--delete-branch", "--match-head-commit", lane.sha]),
		);
		expect(merges[0]?.argv.some((arg) => arg === "--subject" || arg === "--body")).toBe(false);
		const remoteBase = headOf(fx.bare, "refs/heads/main");
		expect(landed?.prLand?.mergedSha).toBe(remoteBase);
		expect(headOf(fx.repo, "refs/heads/main")).toBe(remoteBase);
		expect(headOf(fx.repo)).toBe(remoteBase);
		expect(existsSync(join(fx.repo, "a.txt"))).toBe(true);
		expect(existsSync(lane.cwd)).toBe(false);
		expect(git(fx.repo, "branch", "--list", lane.branch)).toBe("");
		expect(landed?.cleanup).toBeUndefined();
		h.close();
	});

	test("AC-10 PR head가 바뀌었으면 merge 0회로 held", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		fx.fake.setCi(lane.sha, "success");
		// A foreign commit on the PR branch.
		const foreign = commitIn(lane.cwd, ["foreign.txt"]);
		git(fx.repo, "push", "-q", "origin", `${foreign}:refs/heads/${lane.branch}`);
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toMatch(/^보류: PR head가 바뀜/);
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		h.close();
	});

	test("AC-10 merge가 종료코드 ≠ 0이어도 PR이 MERGED면 성공으로 이어 간다", async () => {
		const fx = fixture();
		fx.fake.mergeExit = 1;
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		fx.fake.setCi(lane.sha, "success");
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("landed");
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(1);
		h.close();
	});

	test("AC-12 체크아웃이 dirty면 머지는 두고 cleanup에 merged-not-synced, worktree·브랜치는 지운다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		const before = headOf(fx.repo);
		writeFileSync(join(fx.repo, "README.md"), "edited by somebody\n");
		fx.fake.setCi(lane.sha, "success");
		await poll(h);
		const landed = landOf(h, lane.name);
		expect(landed?.state).toBe("landed");
		expect(landed?.cleanup).toContain("merged-not-synced");
		expect(landed?.cleanup).toContain("미커밋 변경 1건");
		expect(headOf(fx.repo, "refs/heads/main")).toBe(before);
		expect(fx.fake.prs[0]?.state).toBe("MERGED");
		expect(existsSync(lane.cwd)).toBe(false);
		expect(git(fx.repo, "branch", "--list", lane.branch)).toBe("");
		h.close();
	});
});

describe("AC-8 CI 판정표(호출자 쪽)", () => {
	test("AC-8 check-run이 하나도 없으면 ciGraceMs 안에서만 pending이고, 넘으면 held", async () => {
		const fx = fixture({ ciGraceMs: 10 * 60_000 });
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("pr-open");
		expect(landOf(h, lane.name)?.prLand?.ci?.verdict).toBe("none");
		h.advance(10 * 60_000);
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toMatch(/^보류: CI가 돌지 않음/);
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		h.close();
	});

	test("AC-8 도는 중이면 기다리고 ciTimeoutMs를 넘으면 held", async () => {
		const fx = fixture({ ciTimeoutMs: 3 * 60_000 });
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		fx.fake.setCi(lane.sha, "pending");
		await poll(h);
		expect(landOf(h, lane.name)).toMatchObject({ state: "pr-open", prLand: { ci: { verdict: "pending" } } });
		h.advance(3 * 60_000);
		await poll(h);
		expect(reasonOf(h, lane.name)).toBe("보류: CI 시간 초과");
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		h.close();
	});

	test("AC-8 GitHub Actions가 아닌 앱의 success로는 머지하지 않고, 필수 체크가 하나라도 빠지면 기다린다", async () => {
		const fx = fixture({ requiredChecks: ["test", "e2e"] });
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		fx.fake.ci.set(lane.sha, [{ name: "test", status: "completed", conclusion: "success", appId: 99 }]);
		await poll(h);
		expect(landOf(h, lane.name)?.prLand?.ci?.verdict).toBe("none");
		fx.fake.setCi(lane.sha, "success", ["test"]);
		await poll(h);
		expect(landOf(h, lane.name)).toMatchObject({ state: "pr-open", prLand: { ci: { verdict: "pending" } } });
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		h.close();
	});

	test("AC-8 CI 읽기가 실패하면 상태를 그대로 두고 경고는 사유당 한 번만 올린다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		const realGh = fx.fake.tools.gh;
		fx.fake.tools.gh = async (argv, options) =>
			argv[0] === "api" ? { code: 1, stdout: "", stderr: "boom" } : realGh(argv, options);
		await poll(h);
		await poll(h);
		const warnings = h.transport.posts().filter((post) => (post.content ?? "").includes("PR 착지 읽기 실패"));
		expect(warnings).toHaveLength(1);
		expect(landOf(h, lane.name)?.state).toBe("pr-open");
		h.close();
	});
});

describe("AC-9 빨강 반송", () => {
	async function redLane(fx: Fixture, h: LaneHarness) {
		const lane = await startLane(h, fx.repo);
		lane.sha = await lane.claim(["a.txt"]);
		await land(h, lane.name);
		fx.fake.setCi(lane.sha, "failure", ["test", "lint"]);
		await poll(h);
		return lane;
	}

	test("AC-9 스레드에 실패 잡 요약을 한 번 올리고 레인을 working으로 돌린다. 이어진 push는 같은 브랜치·같은 PR", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await redLane(fx, h);
		const back = requireLane(h, lane.name);
		expect(back.status).toBe("working");
		const notices = h.transport.posts().filter((post) => (post.content ?? "").includes("CI가 실패했습니다"));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.content).toContain("test");
		expect(notices[0]?.content).toContain("lint");
		expect(notices[0]?.content).toContain(`https://github.com/${SLUG}/actions/runs/`);
		expect(back.meta.land?.prLand).toMatchObject({ number: 1, bounces: 1 });
		expect(back.meta.land?.prLand?.failedSig).toBeString();
		expect(back.meta.land?.prLand?.step).toBeUndefined();
		const prompts =
			h.drivers.get(lane.originKey)?.calls.filter((call) => call.includes(`같은 브랜치 \`${lane.branch}\``)) ?? [];
		expect(prompts.length).toBeGreaterThan(0);
		expect(prompts.join("\n")).toContain("force push");

		const fixed = await lane.claim(["b.txt"]);
		await land(h, lane.name);
		expect(landOf(h, lane.name)).toMatchObject({ state: "pr-open", prLand: { number: 1, pushedSha: fixed } });
		expect(fx.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(fx.fake.prs).toHaveLength(1);
		expect(headOf(fx.bare, `refs/heads/${lane.branch}`)).toBe(fixed);
		expect(pushes(fx)).toHaveLength(2);
		expect(pushes(fx).every((call) => !call.argv.some((arg) => arg.includes("force") || arg.startsWith("+")))).toBe(
			true,
		);
		h.close();
	});

	test("AC-9 레인이 이력을 고쳐 쓰면(비-ff) force push 없이 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await redLane(fx, h);
		git(lane.cwd, "commit", "-q", "--amend", "-m", "rewritten");
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" });
		await h.settle();
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("비-ff");
		expect(fx.fake.prs).toHaveLength(1);
		expect(headOf(fx.bare, `refs/heads/${lane.branch}`)).toBe(lane.sha);
		h.close();
	});

	test("AC-9 같은 CI 실패가 고쳐지지 않으면 반송하지 않고 blocked, 반송이 3번을 넘어도 blocked", async () => {
		const fx = fixture();
		const lane = "lane/x";
		const input: PrLandInput = {
			repo: fx.repo,
			worktree: join(fx.repo, "none"),
			branch: lane,
			baseBranch: "main",
			sha: "a".repeat(40),
			checksHead: "a".repeat(40),
			title: "t",
			summary: "s",
			config: { mode: "pr", requiredChecks: ["test"] },
			denylistFile: fx.denylistFile,
			frozen: false,
		};
		const saved = (over: Partial<LanePrLand>): LanePrLand => ({
			branch: lane,
			number: 1,
			slug: SLUG,
			pushedSha: "a".repeat(40),
			pushedAt: 0,
			step: "pr-created",
			...over,
		});
		const deps = (): PrLandDeps => ({
			git: async () => ({ code: 0, stdout: "", stderr: "" }),
			tools: {
				git: async () => ({ code: 0, stdout: "", stderr: "" }),
				gh: async (argv) =>
					argv[0] === "api"
						? {
								code: 0,
								stderr: "",
								stdout: JSON.stringify({
									total_count: 1,
									check_runs: [
										{
											id: 5,
											name: "test",
											status: "completed",
											conclusion: "failure",
											head_sha: "a".repeat(40),
											app: { id: 15368 },
											html_url: "https://x/y",
										},
									],
								}),
							}
						: {
								code: 0,
								stderr: "",
								stdout: JSON.stringify({
									state: "OPEN",
									headRefOid: "a".repeat(40),
									mergeCommit: null,
									title: "t",
									body: "b",
								}),
							},
			},
			signal: new AbortController().signal,
			checkLeaks: async () => ({ ok: true }),
			gitleaks: undefined,
			removeWorktree: async () => {},
			now: () => 10,
			save: () => {},
		});
		const first = await pollPrLanding({ ...input, prLand: saved({}) }, deps());
		expect(first.kind).toBe("rework");
		const sig = first.kind === "rework" ? first.prLand.failedSig : undefined;
		const again = await pollPrLanding({ ...input, prLand: saved({ failedSig: sig, bounces: 1 }) }, deps());
		expect(again).toMatchObject({ kind: "blocked", reason: expect.stringContaining("같은 CI 실패") });
		const many = await pollPrLanding({ ...input, prLand: saved({ failedSig: "other", bounces: 3 }) }, deps());
		expect(many).toMatchObject({ kind: "blocked", reason: expect.stringContaining("3번") });
	});
});

describe("AC-13 동결", () => {
	test("AC-13 동결 중에는 ci-green 레인을 머지하지 않고, 풀리면 이어서 머지한다", async () => {
		const fx = fixture();
		let frozen = false;
		const h = prHarness(fx, {
			frozen: () => (frozen ? { since: "2027-01-15T00:00:00.000Z", reason: "", by: "test" } : undefined),
		});
		const lane = await openLane(fx, h);
		fx.fake.setCi(lane.sha, "success");
		frozen = true;
		await poll(h);
		expect(landOf(h, lane.name)).toMatchObject({ state: "pr-open", prLand: { step: "ci-green" } });
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		frozen = false;
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("landed");
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(1);
		h.close();
	});
});

describe("AC-18·AC-19 누출 재검사", () => {
	test("AC-18 반송 재검사: 새 커밋으로 다시 claim하면 step이 비어 있고 누출 검사가 다시 돈다 — denylist 줄이 있으면 push 0회로 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await startLane(h, fx.repo);
		lane.sha = await lane.claim(["a.txt"]);
		await land(h, lane.name);
		const checksBefore = fx.leakChecks;
		fx.fake.setCi(lane.sha, "failure");
		await poll(h);
		const back = landOf(h, lane.name);
		expect(requireLane(h, lane.name).status).toBe("working");
		expect(back?.prLand).toMatchObject({ number: 1 });
		expect(back?.prLand?.step).toBeUndefined();
		expect(back?.prLand?.ci).toBeUndefined();

		await lane.claim(["b.txt"], `${PLANTED}\n`);
		expect(landOf(h, lane.name)?.prLand?.step).toBeUndefined();
		const pushesBefore = pushes(fx).length;
		await land(h, lane.name);
		expect(fx.leakChecks).toBeGreaterThan(checksBefore);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("누출 검사 실패");
		expect(pushes(fx)).toHaveLength(pushesBefore);
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		expectNoPlanted(fx, h, lane.name);
		h.close();
	});

	test("AC-19 중간 커밋에만 있다 지운 denylist 줄은 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await startLane(h, fx.repo);
		commitIn(lane.cwd, ["leak.txt"], `${PLANTED}\n`);
		git(lane.cwd, "rm", "-q", "--", "leak.txt");
		git(lane.cwd, "commit", "-q", "-m", "remove it again");
		await lane.claim(["a.txt"]);
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("leak.txt:1 (denylist)");
		expect(pushes(fx)).toHaveLength(0);
		expectNoPlanted(fx, h, lane.name);
		h.close();
	});

	test("AC-19 커미터 이메일에 denylist가 있으면 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await startLane(h, fx.repo);
		commitIn(lane.cwd, ["a.txt"], undefined, "-c", `user.email=dev@${PLANTED}.example`);
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "a.txt 추가" });
		await h.settle();
		await land(h, lane.name);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("committer (denylist)");
		expect(pushes(fx)).toHaveLength(0);
		expectNoPlanted(fx, h, lane.name);
		h.close();
	});

	test("AC-19 머지 직전에 편집된 PR 본문의 denylist는 merge 0회로 blocked", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const lane = await openLane(fx, h);
		fx.fake.setCi(lane.sha, "success");
		const pr = fx.fake.prs[0];
		if (pr !== undefined) pr.body += `\n${PLANTED}\n`;
		await poll(h);
		expect(landOf(h, lane.name)?.state).toBe("blocked");
		expect(reasonOf(h, lane.name)).toContain("머지 직전 누출 검사 실패");
		expect(reasonOf(h, lane.name)).toContain("pr-body:");
		expect(fx.fake.callsOf("gh", "merge")).toHaveLength(0);
		expectNoPlanted(fx, h, lane.name);
		h.close();
	});
});

describe("AC-1·AC-14 기존 경로", () => {
	test("AC-1 lanes.land 설정이 없으면 PR 경로를 타지 않는다: fake gh 호출 0회, land.mode 없음", async () => {
		const fx = fixture();
		const h = prHarness(fx, { landMode: async () => undefined });
		const lane = await closeLane(h, fx.repo);
		await land(h, lane.name);
		expect(ghCalls(fx)).toHaveLength(0);
		expect(landOf(h, lane.name)?.mode).toBeUndefined();
		expect(["landed", "merged-not-pushed", "blocked"]).toContain(landOf(h, lane.name)?.state ?? "");
		h.close();
	});

	test("AC-14 externalPr 레인은 mode와 무관하게 requestLand를 거절한다", async () => {
		const fx = fixture();
		const h = prHarness(fx);
		const started = await h.manager.start({
			title: "ext",
			cwd: fx.repo,
			channel: CHANNEL,
			acceptance: [CHECK_A],
			risk: "L2",
			externalPr: { repo: "o/r", base: "main" },
		});
		await h.settle();
		const outcome = await h.manager.requestLand(started.name, "owner");
		expect(outcome.handled).toBe(false);
		expect(outcome.text).toContain("외부 PR 레인");
		expect(ghCalls(fx)).toHaveLength(0);
		h.close();
	});
});
