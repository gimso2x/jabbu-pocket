import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { PR_LAND_POLL_MS, type PrLandCrashPoint } from "../src/lanes/pr-land-steps";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { checkLeaks } from "../src/release/leak-check";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { landTask } from "../src/tasks/land";
import type { TaskLandRecord } from "../src/tasks/ledger-schema";
import { discordBinding, GUILD, makeHome, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";
import { FakeGh } from "./helpers/fake-gh";
import { git, makeRepo } from "./helpers/git-fixtures";

// AC-10: a [TASK] PR landing whose process dies at any point finishes on the next daemon from its saved `land_json`,
// through the sweep's tick alone (no owner button, no new reach), with no second PR, no second merge and no judgement
// again (the death is `prLand.seams.crash` throwing, as in
// test/lane-pr-land-recovery.test.ts). The fake `gh`, the bare repository (the remote) and the daemon's home live on.

const SLUG = "acme/widgets";
const GITHUB_URL = `https://github.com/${SLUG}.git`;
const CHANNEL = "111111111111111111";
const THREAD = "222222222222222222";

/** The process death: a distinct error so a test can tell it from a real failure. */
class Died extends Error {
	constructor(readonly point: PrLandCrashPoint) {
		super(`process died at ${point}`);
	}
}

let scratch: string[];
let repos: string[];
let homes: TestHome[];
let daemons: Daemon[];

beforeEach(() => {
	scratch = [];
	repos = [];
	homes = [];
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	for (const home of homes) home.remove();
	for (const dir of [...scratch, ...repos]) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

/** What a daemon of this test needs from its world. */
interface World {
	home: TestHome;
	repo: string;
	bare: string;
	recordsRepo: string;
	gitleaks: string;
	fake: FakeGh;
	taskId: string;
	worktree: string;
	branch: string;
	sha: string;
}

const clockState = { skew: 0 };
const clock = { now: () => Date.now() + clockState.skew };
const judged = { calls: 0 };
/** The crash points that fired (each run dies at most once). */
const deaths: PrLandCrashPoint[] = [];

/** A repository on `main` whose `origin` is a GitHub address backed by a bare repository, with one [TASK] reached in review. */
async function boot(): Promise<{ world: World; start: (crashAt: PrLandCrashPoint | undefined) => Promise<Daemon> }> {
	clockState.skew = 0;
	judged.calls = 0;
	deaths.length = 0;
	const home = makeHome("jabbu-task-pr-recovery-");
	homes.push(home);
	const repo = makeRepo(repos);
	// A `.git` suffix: the task landing refuses a `origin` that may be a live checkout.
	const bare = join(tempDir("jabbu-task-pr-bare-"), "origin.git");
	mkdirSync(bare);
	git(bare, "init", "-q", "--bare");
	git(repo, "remote", "add", "origin", GITHUB_URL);
	git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
	git(repo, "push", "-q", "origin", "main");
	const recordsRepo = makeRepo(repos, "jabbu-task-pr-records-");
	mkdirSync(join(recordsRepo, "release"));
	writeFileSync(join(recordsRepo, "release", "denylist.txt"), "# none\nplanted-owner-marker-7310\n");
	const gitleaks = join(tempDir("jabbu-task-pr-gitleaks-"), "gitleaks");
	writeFileSync(gitleaks, "#!/bin/sh\nexit 0\n");
	chmodSync(gitleaks, 0o755);
	const fake = new FakeGh({ slug: SLUG, bare });
	const sessions = new FakeSessionStore();
	const config = {
		...home.config,
		herdr: {},
		recordsRepo,
		lanes: { land: { [repo]: { mode: "pr" as const } } },
	};
	const transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	const start = async (crashAt: PrLandCrashPoint | undefined): Promise<Daemon> => {
		const daemon = new Daemon({
			...daemonTestOptions(),
			config,
			channels: [discordBinding(transport)],
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			taskSweepMs: 0,
			gateSweepMs: 0,
			herdrRun: async () => ({ code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false }),
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
			// The re-judgement is counted: a recovery must never run it.
			taskLand: (row, deps) =>
				landTask(row, {
					...deps,
					judge: async () => {
						judged.calls += 1;
						return {
							ok: true,
							judgement: { problems: [], integrityWarnings: [] } as Partial<TaskJudgement> as TaskJudgement,
						};
					},
				}),
			prLand: {
				tools: fake.tools,
				seams: {
					git: (args) => fake.tools.git(args, { cwd: repo, signal: AbortSignal.timeout(60_000) }),
					checkLeaks,
					gitleaks,
					crash: (point) => {
						if (point === crashAt && deaths.length === 0) {
							deaths.push(point);
							throw new Died(point);
						}
					},
				},
			},
		});
		daemons.push(daemon);
		await daemon.start();
		return daemon;
	};
	const first = await start(undefined);
	const row = first.store.tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: `${CHANNEL}:${THREAD}`,
		host: null,
		repo,
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	git(repo, "worktree", "add", "-q", "-b", row.branch, row.worktree, "main");
	writeFileSync(join(row.worktree, "a.txt"), "a\n");
	git(row.worktree, "add", "--", "a.txt");
	git(row.worktree, "commit", "-q", "-m", "add a.txt");
	const sha = git(row.worktree, "rev-parse", "HEAD");
	first.store.tasks.setBaseSha(row.taskId, git(repo, "rev-parse", "main"));
	first.store.tasks.transition(row.taskId, "review", "bot");
	fake.setCi(sha, "success");
	scratch.push(row.worktree);
	await first.stop();
	daemons.splice(daemons.indexOf(first), 1);
	return {
		world: {
			home,
			repo,
			bare,
			recordsRepo,
			gitleaks,
			fake,
			taskId: row.taskId,
			worktree: row.worktree,
			branch: row.branch,
			sha,
		},
		start,
	};
}

/** Ticks the sweep with the clock moved past the poll interval each time, until `done` or the bound. */
async function sweepUntil(daemon: Daemon, done: () => boolean, max = 8): Promise<number> {
	for (let ticks = 1; ticks <= max; ticks++) {
		clockState.skew += PR_LAND_POLL_MS * 2;
		await daemon.sweepTasks();
		if (done()) return ticks;
	}
	return max;
}

// What the saved record has when the process dies at the point, and whether it carries `pushedSha`.
const POINTS: ReadonlyArray<{
	point: PrLandCrashPoint;
	step: NonNullable<TaskLandRecord["prLand"]["step"]>;
	pushedSha: boolean;
	moment: string;
}> = [
	{ point: "leak-checked", step: "leak-checked", pushedSha: false, moment: "누출 검사 기록 직후, push 전" },
	{ point: "push-done", step: "leak-checked", pushedSha: false, moment: "push 직후, 기록 전" },
	{ point: "pushed", step: "pushed", pushedSha: true, moment: "pushed 기록 직후, PR 만들기 전" },
	{ point: "create-done", step: "pushed", pushedSha: true, moment: "pr create 직후, 번호 기록 전" },
	{ point: "pr-created", step: "pr-created", pushedSha: true, moment: "PR 번호 기록 직후" },
	{ point: "ci-green", step: "ci-green", pushedSha: true, moment: "CI 초록 기록 직후" },
	{ point: "merging", step: "merging", pushedSha: true, moment: "머지 기록 직후, gh pr merge 전" },
	{ point: "merge-done", step: "merging", pushedSha: true, moment: "머지 직후, merged 기록 전" },
	{ point: "merged", step: "merged", pushedSha: true, moment: "merged 기록 직후, 로컬 ff 전" },
	{ point: "ff-done", step: "merged", pushedSha: true, moment: "로컬 ff 직후, synced 기록 전" },
	{ point: "synced", step: "synced", pushedSha: true, moment: "synced 기록 직후, 정리 전" },
];

describe("AC-10 복구: 죽었다 살아난 데몬이 스위퍼 틱만으로 한 번만 착지한다", () => {
	for (const { point, step, pushedSha, moment } of POINTS) {
		test(`AC-10 ${moment} (${point}, step ${step})`, async () => {
			const { world: w, start } = await boot();
			const baseBefore = git(w.bare, "rev-parse", "main");

			// The first process: the landing call, then sweep ticks until it dies at `point`.
			const doomed = await start(point);
			const row = doomed.store.tasks.require(w.taskId);
			await doomed.autoLand(row);
			for (let ticks = 0; ticks < 8 && deaths.length === 0; ticks++) {
				clockState.skew += PR_LAND_POLL_MS * 2;
				await doomed.sweepTasks();
			}
			expect(deaths).toEqual([point]);
			const record = doomed.store.tasks.require(w.taskId).land;
			expect(record).not.toBeNull();
			expect(record).toMatchObject({ mode: "pr", state: "active", sha: w.sha, baseBranch: "main" });
			expect(record?.prLand.step).toBe(step);
			expect(record?.prLand.pushedSha !== undefined).toBe(pushedSha);
			expect(doomed.store.tasks.require(w.taskId).status).toBe("review");
			await doomed.stop();
			daemons.splice(daemons.indexOf(doomed), 1);

			// The next process: nothing but the sweep tick (no button, no new reach).
			const judgedBefore = judged.calls;
			const revived = await start(undefined);
			const ticks = await sweepUntil(revived, () => revived.store.tasks.require(w.taskId).status === "done");
			expect(ticks).toBeLessThan(8);
			const finished = revived.store.tasks.require(w.taskId);
			expect(finished.status).toBe("done");
			expect(revived.store.tasks.history(w.taskId).at(-1)).toMatchObject({ toStatus: "done", actor: "core-land" });
			// No re-judgement, and nothing went in as an owner turn ("머지해" or a button).
			expect(judged.calls).toBe(judgedBefore);
			expect(revived.store.listInbound()).toHaveLength(0);
			// One PR, created once; one successful merge, so one squash commit on the remote base.
			expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
			expect(w.fake.prs).toHaveLength(1);
			const merged = w.fake.prs.filter((pr) => pr.state === "MERGED");
			expect(merged).toHaveLength(1);
			expect(w.fake.callsOf("gh", "pr", "merge")).toHaveLength(1);
			expect(git(w.bare, "rev-list", "--count", `${baseBefore}..main`)).toBe("1");
			expect(git(w.bare, "rev-parse", "main")).toBe(merged[0]?.mergeCommit as string);
			// The branch was pushed without force; local base == remote base; worktree and branch are gone.
			expect(w.fake.callsOf("git", "push").every((call) => !call.argv.includes("--force"))).toBe(true);
			expect(git(w.repo, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
			expect(existsSync(w.worktree)).toBe(false);
			expect(git(w.repo, "branch", "--list", w.branch)).toBe("");
		});
	}
});
