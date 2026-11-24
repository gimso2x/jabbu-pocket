import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { dispatchEnv, type ProcessRunner, type RunProcessResult, remoteShellQuote } from "../src/dispatch/omp";
import { PR_LAND_POLL_MS, type PrLandCrashPoint } from "../src/lanes/pr-land-steps";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { checkLeaks } from "../src/release/leak-check";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { removeRemoteWorktree, syncRemoteBase } from "../src/tasks/host-sync";
import { landTask } from "../src/tasks/land";
import { discordBinding, GUILD, makeHome, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { FakeGh } from "./helpers/fake-gh";
import { git, makeRepo } from "./helpers/git-fixtures";

// AC-11e / AC-19(원격): a [TASK] on a `dispatchHosts` host that landed through a PR is cleaned up in a fixed order
// (local base ff → local temporary ref → host worktree and branch → host base branch → done, herdr closed), a cleanup
// that cannot be done never takes the landing back, and a process that dies anywhere after `synced` was saved is
// finished by the next daemon's sweep tick without a second PR or merge.
// The host is a second non-bare clone on this machine; "ssh" is a fake runner that runs the remote command line in a
// local shell, so every git command of the cleanup is real.

const SLUG = "acme/widgets";
const GITHUB_URL = `https://github.com/${SLUG}.git`;
const CHANNEL = "111111111111111111";
const THREAD = "222222222222222222";
const SSH_TARGET = "wsl-ssh";
const HOST = "wsl";

/** The process death: a distinct error so a test can tell it from a real failure. */
class Died extends Error {
	constructor(readonly label: string) {
		super(`process died at ${label}`);
	}
}

/** Where a test's process dies (once): a landing step's crash point, right after a host command, right before a local git command. */
type Death =
	| { at: "seam"; point: PrLandCrashPoint }
	| { at: "ssh-after"; label: string; match: (words: string[]) => boolean }
	| { at: "git-before"; label: string; match: (args: string[]) => boolean };

/** The remote side of an ssh call: the words after `ssh -o … -- <target>`, quotes taken off (the trailing `2>&1` stays bare). */
const unquote = (word: string): string =>
	word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word;

const has = (words: readonly string[], ...needle: string[]) => needle.every((word) => words.includes(word));

let scratch: string[];
let repos: string[];
let homes: TestHome[];
let daemons: Daemon[];
let savedPath: string | undefined;

beforeEach(() => {
	scratch = [];
	repos = [];
	homes = [];
	daemons = [];
	// A real `ssh` must never run in this file: the first one on PATH refuses.
	const bin = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-no-ssh-")));
	scratch.push(bin);
	writeFileSync(join(bin, "ssh"), "#!/bin/sh\necho 'ssh disabled in tests' >&2\nexit 255\n");
	chmodSync(join(bin, "ssh"), 0o755);
	savedPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
});

afterEach(async () => {
	process.env.PATH = savedPath;
	for (const daemon of daemons) await daemon.stop();
	for (const home of homes) home.remove();
	for (const dir of [...scratch, ...repos]) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratch.push(dir);
	return dir;
}

const clockState = { skew: 0 };
const clock = { now: () => Date.now() + clockState.skew };

interface World {
	home: TestHome;
	/** The bot's own clone (`lanes.land` key). */
	local: string;
	/** The host's repository (`remotes.wsl`, the task row's `repo`). */
	remote: string;
	bare: string;
	fake: FakeGh;
	taskId: string;
	worktree: string;
	branch: string;
	agent: string;
	sha: string;
	/** Every observable step in the order it happened: local git ff/ref deletion, host commands, herdr calls. */
	events: string[];
	deaths: string[];
	/** The thread posts the bot made, as text. */
	posts: () => string[];
	/** Replies to a host command instead of running it (`undefined`: run it). */
	sshReply: { value: ((words: string[]) => RunProcessResult | undefined) | undefined };
	judged: { calls: number };
	start: (death?: Death) => Promise<Daemon>;
}

/** The bot's clone, the host's clone, one reached [TASK] on the host's repository, a fake GitHub (bare repository + fake `gh`). */
async function build(): Promise<World> {
	clockState.skew = 0;
	const home = makeHome("jabbu-remote-recovery-");
	homes.push(home);
	const root = tempDir("jabbu-remote-world-");
	// The bare repository's name ends in `.git`: the core refuses an origin that may be a live checkout.
	const bare = join(root, "origin.git");
	mkdirSync(bare);
	git(bare, "init", "-q", "--bare");
	const local = makeRepo(repos, "jabbu-remote-local-");
	git(local, "remote", "add", "origin", GITHUB_URL);
	git(local, "config", `url.${bare}.insteadOf`, GITHUB_URL);
	git(local, "push", "-q", "origin", "main");
	git(root, "clone", "-q", bare, "remote");
	const remote = join(root, "remote");
	// The host's origin answers with the GitHub address (a `url.<bare>.insteadOf` would be expanded by `remote get-url`);
	// the fake ssh applies that rewrite to the host's `fetch` only.
	git(remote, "remote", "set-url", "origin", GITHUB_URL);
	const records = makeRepo(repos, "jabbu-remote-records-");
	mkdirSync(join(records, "release"));
	writeFileSync(join(records, "release", "denylist.txt"), "# none\nplanted-owner-marker-7310\n");
	const gitleaks = join(tempDir("jabbu-remote-gitleaks-"), "gitleaks");
	writeFileSync(gitleaks, "#!/bin/sh\nexit 0\n");
	chmodSync(gitleaks, 0o755);

	const fake = new FakeGh({ slug: SLUG, bare });
	const sessions = new FakeSessionStore();
	const events: string[] = [];
	const deaths: string[] = [];
	const judged = { calls: 0 };
	const sshReply: World["sshReply"] = { value: undefined };
	const transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	const agents = new Set<string>();

	const config = {
		...home.config,
		herdr: {},
		recordsRepo: records,
		dispatchHosts: { [HOST]: { ssh: SSH_TARGET, workDir: root } },
		lanes: { land: { [local]: { mode: "pr" as const, remotes: { [HOST]: remote } } } },
	};

	const start = async (death?: Death): Promise<Daemon> => {
		const die = (label: string) => {
			if (deaths.length > 0) return;
			deaths.push(label);
			throw new Died(label);
		};
		const gitSeam: GitRunner = async (args) => {
			if (args.includes("--ff-only") || has(args, "update-ref", "-d")) events.push(`git ${args.join(" ")}`);
			if (death?.at === "git-before" && death.match(args)) die(death.label);
			return defaultGit(args);
		};
		const herdrRun: ProcessRunner = async (cmd) => {
			if (cmd[0] !== "ssh") return { code: 0, stdout: "{}", timedOut: false };
			const words = cmd.slice(7).map(unquote);
			if (words[0] === "herdr") {
				events.push(`herdr ${words.slice(1).join(" ")}`);
				const list = [...agents].map((name) => ({
					name,
					agent_status: "idle",
					workspace_id: `ws-${name}`,
					tab_id: `tab-${name}`,
				}));
				const stdout = words.includes("list") ? JSON.stringify({ result: { agents: list } }) : "{}";
				return { code: 0, stdout, timedOut: false };
			}
			events.push(`ssh ${words.slice(0, -1).join(" ")}`);
			const replied = sshReply.value?.(words);
			if (replied !== undefined) return replied;
			const env: Record<string, string> = { ...dispatchEnv(process.env), GIT_CONFIG_GLOBAL: "/dev/null" };
			if (words.includes("fetch")) {
				env.GIT_CONFIG_COUNT = "1";
				env.GIT_CONFIG_KEY_0 = `url.${bare}.insteadOf`;
				env.GIT_CONFIG_VALUE_0 = GITHUB_URL;
			}
			const child = Bun.spawn(["sh", "-c", cmd.slice(7).join(" ")], { stdout: "pipe", stderr: "pipe", env });
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (death?.at === "ssh-after" && death.match(words)) die(death.label);
			return { code, stdout, stderr, timedOut: false };
		};
		const daemon = new Daemon({
			config,
			channels: [discordBinding(transport)],
			clock,
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			taskSweepMs: 0,
			gateSweepMs: 0,
			herdrRun,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
			// The re-judgement is counted: a recovery must never run it.
			taskLand: (row, deps) =>
				landTask(row, {
					...deps,
					git: gitSeam,
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
					git: gitSeam,
					address: (_ssh, repo) => repo,
					checkLeaks,
					gitleaks,
					crash: (point) => {
						if (death?.at === "seam" && death.point === point) die(point);
					},
				},
			},
		});
		daemons.push(daemon);
		await daemon.start();
		return daemon;
	};

	const first = await start();
	const row = first.store.tasks.register({
		title: "원격 로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: `${CHANNEL}:${THREAD}`,
		host: HOST,
		repo: remote,
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	// The worker's side: a worktree on the host with one commit on the task branch.
	git(remote, "worktree", "add", "-q", "-b", row.branch, row.worktree, "main");
	writeFileSync(join(row.worktree, "a.txt"), "a\n");
	git(row.worktree, "add", "--", "a.txt");
	git(row.worktree, "commit", "-q", "-m", "add a.txt");
	const sha = git(row.worktree, "rev-parse", "HEAD");
	first.store.tasks.setBaseSha(row.taskId, git(remote, "rev-parse", "main"));
	first.store.tasks.transition(row.taskId, "review", "bot");
	agents.add(row.agent);
	fake.setCi(sha, "success");
	scratch.push(row.worktree);
	await first.stop();
	daemons.splice(daemons.indexOf(first), 1);
	return {
		home,
		local,
		remote,
		bare,
		fake,
		taskId: row.taskId,
		worktree: row.worktree,
		branch: row.branch,
		agent: row.agent,
		sha,
		events,
		deaths,
		posts: () =>
			transport.calls.flatMap((call) =>
				call.method === "createMessage" ? [JSON.stringify(call.embeds ?? call.content ?? "")] : [],
			),
		sshReply,
		judged,
		start,
	};
}

/** Ticks the sweep with the clock past the poll interval each time, until `done` or the bound. */
async function sweepUntil(daemon: Daemon, done: () => boolean, max = 8): Promise<number> {
	for (let ticks = 1; ticks <= max; ticks++) {
		clockState.skew += PR_LAND_POLL_MS * 2;
		await daemon.sweepTasks();
		if (done()) return ticks;
	}
	return max;
}

/** The landing call, then sweep ticks until the task is `done` (or `max` ticks). */
async function landToEnd(w: World, daemon: Daemon, max = 8): Promise<void> {
	const row = daemon.store.tasks.require(w.taskId);
	expect(await daemon.autoLand(row)).toMatchObject({ state: "pr-open" });
	const ticks = await sweepUntil(daemon, () => daemon.store.tasks.require(w.taskId).status === "done", max);
	expect(ticks).toBeLessThan(max);
}

const indexOfEvent = (w: World, pattern: RegExp): number => w.events.findIndex((event) => pattern.test(event));

/** The host repository is `done` with its worktree and branch gone and its base branch on GitHub's. */
function expectCleanHost(w: World): void {
	expect(existsSync(w.worktree)).toBe(false);
	expect(git(w.remote, "branch", "--list", w.branch)).toBe("");
	expect(git(w.remote, "worktree", "list", "--porcelain")).not.toContain(w.worktree);
	expect(git(w.remote, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
	expect(existsSync(join(w.remote, "a.txt"))).toBe(true);
	expect(git(w.local, "for-each-ref", "refs/jabbu")).toBe("");
}

describe("AC-11e 원격 정리의 순서와 결과", () => {
	test("원격 정리 순서: 로컬 base ff → 로컬 임시 ref 삭제 → 원격 worktree·branch 제거 → 원격 base ff → herdr 닫기, 끝은 done", async () => {
		const w = await build();
		const daemon = await w.start();
		const baseBefore = git(w.bare, "rev-parse", "main");
		await landToEnd(w, daemon);

		const order = [
			indexOfEvent(w, /^git -C \S+ merge --ff-only origin\/main$/),
			indexOfEvent(w, /^git -C \S+ update-ref -d refs\/jabbu\/task\/T-/),
			indexOfEvent(w, /^ssh git -C \S+ worktree remove --force /),
			indexOfEvent(w, /^ssh git -C \S+ branch -D task\/T-/),
			indexOfEvent(w, /^ssh git -C \S+ remote get-url origin$/),
			indexOfEvent(w, /^ssh git -C \S+ fetch origin main$/),
			indexOfEvent(w, /^ssh git -C \S+ merge --ff-only origin\/main$/),
			indexOfEvent(w, /^herdr tab close tab-/),
		];
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(new Set(order).size).toBe(order.length);

		const row = daemon.store.tasks.require(w.taskId);
		expect(row.status).toBe("done");
		expect(daemon.store.tasks.history(w.taskId).at(-1)).toMatchObject({ toStatus: "done", actor: "core-land" });
		expect(git(w.bare, "rev-list", "--count", `${baseBefore}..main`)).toBe("1");
		expect(git(w.local, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
		expectCleanHost(w);
		// Nothing was left to tell: the landing note carries no cleanup line.
		expect(w.posts().join("\n")).not.toContain("merged-not-synced");
		expect(w.posts().join("\n")).not.toContain("정리 필요");
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(w.fake.callsOf("gh", "pr", "merge")).toHaveLength(1);
		expect(daemon.store.listInbound()).toHaveLength(0);
	});

	test("원격 정리: 원격 base 체크아웃이 더러우면 merged-not-synced 메모만 남기고 base를 옮기지 않으며 머지·착지·done은 유지된다", async () => {
		const w = await build();
		const daemon = await w.start();
		const remoteBefore = git(w.remote, "rev-parse", "main");
		writeFileSync(join(w.remote, "wip.txt"), "wip\n");
		await landToEnd(w, daemon);

		expect(daemon.store.tasks.require(w.taskId).status).toBe("done");
		const shown = w.posts().join("\n");
		expect(shown).toContain("merged-not-synced: 원격 wsl");
		expect(shown).toContain("미커밋 변경 1건");
		expect(git(w.remote, "rev-parse", "main")).toBe(remoteBefore);
		expect(git(w.remote, "rev-parse", "main")).not.toBe(git(w.bare, "rev-parse", "main"));
		expect(indexOfEvent(w, /^ssh git -C \S+ merge --ff-only /)).toBe(-1);
		// The merge stands and the worktree and branch are gone all the same.
		expect(w.fake.prs.filter((pr) => pr.state === "MERGED")).toHaveLength(1);
		expect(existsSync(w.worktree)).toBe(false);
		expect(git(w.remote, "branch", "--list", w.branch)).toBe("");
		expect(existsSync(join(w.remote, "wip.txt"))).toBe(true);
		expect(indexOfEvent(w, /^herdr tab close tab-/)).toBeGreaterThan(-1);
	});

	test("원격 정리: 원격 origin이 다른 저장소(다른 slug)면 fetch도 ff도 하지 않고 메모만 남기며 착지는 done", async () => {
		const w = await build();
		const daemon = await w.start();
		git(w.remote, "remote", "set-url", "origin", "https://github.com/other/thing.git");
		const remoteBefore = git(w.remote, "rev-parse", "main");
		await landToEnd(w, daemon);

		expect(daemon.store.tasks.require(w.taskId).status).toBe("done");
		const shown = w.posts().join("\n");
		expect(shown).toContain("merged-not-synced: 원격 wsl");
		expect(shown).toContain("other/thing");
		expect(shown).toContain("acme/widgets가 아님");
		expect(git(w.remote, "rev-parse", "main")).toBe(remoteBefore);
		expect(indexOfEvent(w, /^ssh git -C \S+ fetch origin main$/)).toBe(-1);
		expect(indexOfEvent(w, /^ssh git -C \S+ merge --ff-only /)).toBe(-1);
		expect(existsSync(w.worktree)).toBe(false);
		expect(w.fake.prs.filter((pr) => pr.state === "MERGED")).toHaveLength(1);
	});

	test("원격 정리 실패: worktree가 잠겨 제거가 실패해도 cleanup 문구에만 남고 착지는 landed·done이며 base 갱신은 계속된다", async () => {
		const w = await build();
		const daemon = await w.start();
		git(w.remote, "worktree", "lock", "--reason", "worker busy", w.worktree);
		await landToEnd(w, daemon);

		expect(daemon.store.tasks.require(w.taskId).status).toBe("done");
		const shown = w.posts().join("\n");
		expect(shown).toContain("원격 wsl 정리 필요");
		expect(shown).toContain("worktree 제거 실패");
		expect(shown).toContain("손으로: git -C");
		// The two removals are both tried, and the base branch is still brought up to date after them.
		expect(indexOfEvent(w, /^ssh git -C \S+ branch -D /)).toBeGreaterThan(-1);
		expect(git(w.remote, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
		expect(existsSync(w.worktree)).toBe(true);
		expect(w.fake.prs.filter((pr) => pr.state === "MERGED")).toHaveLength(1);
		expect(indexOfEvent(w, /^herdr tab close tab-/)).toBeGreaterThan(-1);
	});

	test("원격 정리 실패: 머지 뒤 ssh가 255(호스트 불가)여도 cleanup 문구에만 남고 착지는 done, 로컬 정리는 끝난다", async () => {
		const w = await build();
		const daemon = await w.start();
		w.sshReply.value = () =>
			w.fake.prs.some((pr) => pr.state === "MERGED")
				? { code: 255, stdout: "", stderr: "ssh: connect to host wsl-ssh port 22: Connection refused", timedOut: false }
				: undefined;
		await landToEnd(w, daemon);

		expect(daemon.store.tasks.require(w.taskId).status).toBe("done");
		const shown = w.posts().join("\n");
		expect(shown).toContain("원격 호스트에 닿지 못함");
		expect(shown).toContain("원격 wsl 정리 필요");
		expect(shown).toContain("merged-not-synced: 원격 wsl");
		expect(shown).toContain("손으로: git -C");
		expect(w.fake.prs.filter((pr) => pr.state === "MERGED")).toHaveLength(1);
		expect(git(w.local, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
		expect(git(w.local, "for-each-ref", "refs/jabbu")).toBe("");
		// Nothing of the host could be touched: the worktree and the old base are still there.
		expect(existsSync(w.worktree)).toBe(true);
		expect(git(w.remote, "rev-parse", "main")).not.toBe(git(w.bare, "rev-parse", "main"));
	});
});

describe("AC-11e 복구: synced 저장 뒤 어디서 죽어도 새 데몬의 스위퍼 틱이 멱등하게 끝낸다", () => {
	const POINTS: { moment: string; death: Death }[] = [
		{ moment: "synced 기록 직후, 정리 전", death: { at: "seam", point: "synced" } },
		{
			moment: "로컬 임시 ref 삭제 직전",
			death: { at: "git-before", label: "before-ref-drop", match: (args) => has(args, "update-ref", "-d") },
		},
		{
			moment: "원격 worktree 제거 직후, branch -D 전",
			death: { at: "ssh-after", label: "after-worktree-remove", match: (words) => has(words, "worktree", "remove") },
		},
		{
			moment: "원격 branch -D 직후, base 갱신 전",
			death: { at: "ssh-after", label: "after-branch-delete", match: (words) => has(words, "branch", "-D") },
		},
		{
			moment: "원격 base fetch 직후, ff 전",
			death: { at: "ssh-after", label: "after-base-fetch", match: (words) => has(words, "fetch", "origin", "main") },
		},
		{
			moment: "원격 base ff 직후, done 전",
			death: {
				at: "ssh-after",
				label: "after-remote-ff",
				match: (words) => has(words, "merge", "--ff-only", "origin/main"),
			},
		},
	];

	for (const { moment, death } of POINTS) {
		test(`${moment}: PR·머지 중복 0, 재판정 0, 최종 done`, async () => {
			const w = await build();
			const baseBefore = git(w.bare, "rev-parse", "main");
			const label = death.at === "seam" ? death.point : death.label;

			const doomed = await w.start(death);
			expect(await doomed.autoLand(doomed.store.tasks.require(w.taskId))).toMatchObject({ state: "pr-open" });
			for (let ticks = 0; ticks < 8 && w.deaths.length === 0; ticks++) {
				clockState.skew += PR_LAND_POLL_MS * 2;
				await doomed.sweepTasks();
			}
			expect(w.deaths).toEqual([label]);
			// The merge is on GitHub, the record says `synced` and the task is still in review.
			const record = doomed.store.tasks.require(w.taskId).land;
			expect(record).toMatchObject({ mode: "pr", state: "active" });
			expect(record?.prLand.step).toBe("synced");
			expect(doomed.store.tasks.require(w.taskId).status).toBe("review");
			expect(w.fake.prs.filter((pr) => pr.state === "MERGED")).toHaveLength(1);
			await doomed.stop();
			daemons.splice(daemons.indexOf(doomed), 1);

			// The next process: only the sweep tick.
			const judgedBefore = w.judged.calls;
			const revived = await w.start();
			const ticks = await sweepUntil(revived, () => revived.store.tasks.require(w.taskId).status === "done");
			expect(ticks).toBeLessThan(8);
			expect(revived.store.tasks.require(w.taskId).status).toBe("done");
			expect(revived.store.tasks.history(w.taskId).at(-1)).toMatchObject({ toStatus: "done", actor: "core-land" });
			expect(w.judged.calls).toBe(judgedBefore);
			expect(revived.store.listInbound()).toHaveLength(0);
			expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
			expect(w.fake.callsOf("gh", "pr", "merge")).toHaveLength(1);
			expect(w.fake.prs).toHaveLength(1);
			expect(git(w.bare, "rev-list", "--count", `${baseBefore}..main`)).toBe("1");
			expect(git(w.local, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", "main"));
			expectCleanHost(w);
			expect(indexOfEvent(w, /^herdr tab close tab-/)).toBeGreaterThan(-1);
			expect(w.posts().join("\n")).not.toContain("merged-not-synced");
		});
	}
});

describe("AC-11e 셸 위험 문자와 인용", () => {
	type Calls = { words: string[]; raw: string[] }[];
	const recorder = (): { run: ProcessRunner; calls: Calls } => {
		const calls: Calls = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push({ words: cmd.slice(7, -1).map(unquote), raw: cmd.slice(7, -1) });
			return { code: 0, stdout: `${GITHUB_URL}\n`, timedOut: false };
		};
		return { run, calls };
	};
	const SYNC = {
		host: HOST,
		repo: "/home/u/work/app",
		baseBranch: "main",
		remote: "origin",
		expectedSlug: SLUG,
	};
	const REMOVE = { repo: SYNC.repo, worktree: "/home/u/work/app-t-1", branch: "task/T-20261124-13" };

	test("syncRemoteBase는 baseBranch·remote·repo에 공백·;·$(·..가 있으면 아무것도 돌리지 않고 거절한다", async () => {
		const bad: [string, Partial<typeof SYNC>][] = [
			["baseBranch 공백", { baseBranch: "main branch" }],
			["baseBranch ;", { baseBranch: "main;id" }],
			["baseBranch $(", { baseBranch: "ma$(id)" }],
			["baseBranch ..", { baseBranch: "a..b" }],
			["remote 공백", { remote: "ori gin" }],
			["remote ;", { remote: "origin;id" }],
			["remote $(", { remote: "$(id)" }],
			["remote ..", { remote: "or..gin" }],
			["repo 공백", { repo: "/home/u/my app" }],
			["repo ;", { repo: "/home/u/app;id" }],
			["repo $(", { repo: "/home/u/$(id)" }],
			["repo ..", { repo: "/home/u/../etc" }],
		];
		for (const [, over] of bad) {
			const { run, calls } = recorder();
			const note = await syncRemoteBase(run, SSH_TARGET, { ...SYNC, ...over });
			expect(note).toContain("merged-not-synced");
			expect(note).toContain("거절");
			expect(calls).toHaveLength(0);
		}
	});

	test("removeRemoteWorktree도 repo·worktree·branch의 위험 문자는 거절하고 아무것도 돌리지 않는다", async () => {
		const bad = [
			{ ...REMOVE, repo: "/home/u/my app" },
			{ ...REMOVE, repo: "/home/u/app;id" },
			{ ...REMOVE, worktree: "/home/u/$(id)" },
			{ ...REMOVE, worktree: "/home/u/../x" },
			{ ...REMOVE, branch: "task/a b" },
			{ ...REMOVE, branch: "task/a;id" },
			{ ...REMOVE, branch: "task/$(id)" },
			{ ...REMOVE, branch: "task/../main" },
		];
		for (const input of bad) {
			const { run, calls } = recorder();
			expect(await removeRemoteWorktree(run, SSH_TARGET, input)).toContain("거절");
			expect(calls).toHaveLength(0);
		}
	});

	test("허용된 입력의 모든 원격 인자는 remoteShellQuote로 한 단어씩 인용되어 나간다(두 함수 모두)", async () => {
		const sync = recorder();
		await syncRemoteBase(sync.run, SSH_TARGET, { ...SYNC, baseBranch: "release/1.0", remote: "up-stream.1" });
		const remove = recorder();
		await removeRemoteWorktree(remove.run, SSH_TARGET, REMOVE);
		expect(sync.calls.length).toBeGreaterThan(0);
		expect(remove.calls).toHaveLength(2);
		for (const call of [...sync.calls, ...remove.calls]) {
			expect(call.raw).toEqual(call.words.map(remoteShellQuote));
		}
		expect(sync.calls[0]?.words).toEqual(["git", "-C", SYNC.repo, "remote", "get-url", "up-stream.1"]);
		expect(sync.calls.some((call) => call.words.includes("release/1.0"))).toBe(true);
	});
});

describe("AC-11e TaskHostOps.removeWorktree 불변", () => {
	test("원격 정리 함수가 생겨도 TaskHostOps.removeWorktree의 시그니처는 그대로다(타입)", () => {
		expectTypeOf<TaskHostOps["removeWorktree"]>().toEqualTypeOf<
			(input: { repo: string; worktree: string; branch: string }) => Promise<void>
		>();
	});

	test("removeWorktree는 여전히 best-effort다: worktree remove·branch -D 두 명령을 돌리고 실패해도 던지지 않는다", async () => {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd.slice(7, -1));
			return { code: 1, stdout: "fatal: nope", timedOut: false };
		};
		const ops = createTaskHostOps({ sshTarget: SSH_TARGET, run });
		const input = { repo: "/home/u/work/app", worktree: "/home/u/work/app-t-1", branch: "task/T-20261124-13" };
		expect(await ops.removeWorktree(input)).toBeUndefined();
		expect(seen).toEqual([
			["git", "-C", input.repo, "worktree", "remove", "--force", input.worktree],
			["git", "-C", input.repo, "branch", "-D", input.branch],
		]);
	});
});
