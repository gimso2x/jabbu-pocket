import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneLandRepoConfig } from "../src/config-validate";
import { Daemon } from "../src/daemon/daemon";
import type { ProcessRunner } from "../src/dispatch/omp";
import type { PrTools } from "../src/lanes/pr";
import type { PrLandCrashPoint } from "../src/lanes/pr-land-steps";
import { defaultGit, type GitRunner } from "../src/lanes/verify";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { checkLeaks } from "../src/release/leak-check";
import { acceptanceItems, docsDirOf, renderProgress, renderSpec } from "../src/tasks/docs";
import { evaluateTask, memoryTaskChecks, type TaskEvaluation } from "../src/tasks/evaluate";
import { createTaskHostOps } from "../src/tasks/host";
import { landTask } from "../src/tasks/land";
import { remoteIntegrityBase } from "../src/tasks/land-remote";
import type { TaskRow } from "../src/tasks/ledger";
import { integrityBaseOf } from "../src/tasks/pr-land-task";
import { discordBinding, GUILD, makeHome, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";
import { FakeGh } from "./helpers/fake-gh";
import { git } from "./helpers/git-fixtures";
import { CHANNEL, GITHUB_URL, passed, SLUG, THREAD } from "./helpers/task-pr-harness";

// A reached [TASK] on a `dispatchHosts` host lands through a PR when `lanes.land[<local repo>].remotes[<host>]` names its
// repository: the real daemon, real git in temp directories (the host's repository is
// a second clone with the task's worktree), a local bare repository as GitHub's copy, a fake `gh` and an ssh that runs the
// remote command line in a local shell. Nothing here reaches a network.

const HOST = "h1";
const SSH_TARGET = "fakehost";
const SSH_HEAD = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", SSH_TARGET];
const unquote = (word: string): string => (word.startsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word);
/** Remote verbs that change a worktree or its repository: the core never runs them on a host before the merge. */
const WRITES = ["merge", "rebase", "commit", "checkout", "reset", "add", "push", "cherry-pick", "stash", "worktree"];

interface RemoteCall {
	words: string[];
	code: number | null;
	stdout: string;
}

type LandEntry = LaneLandRepoConfig;
type Judge = (row: TaskRow, options?: { integrityBase?: string }) => Promise<TaskEvaluation>;

class RemoteWorld {
	readonly home: TestHome;
	readonly transport = new WaitingDiscordTransport();
	readonly fake: FakeGh;
	/** Remote command lines the fake ssh ran (herdr's apart), with their answers. */
	readonly remote: RemoteCall[] = [];
	/** What herdr was asked over ssh. */
	readonly herdr: { ssh: string[]; words: string[] }[] = [];
	/** `ssh:`, `git:` and `judge` in the order they happened. */
	readonly events: string[] = [];
	readonly addresses: [string, string][] = [];
	readonly crashes: PrLandCrashPoint[] = [];
	readonly gitCalls: string[][] = [];
	readonly leakInputs: Parameters<typeof checkLeaks>[0][] = [];
	readonly judgeCalls: { row: TaskRow; options: { integrityBase?: string } | undefined }[] = [];
	/** The judgement of the re-judge; `undefined` = the real one (the documents read over ssh). */
	judge: Judge | undefined = async () => passed();
	daemon!: Daemon;
	readonly clock = { now: () => this.#base + this.#offset };
	readonly #agents = new Set<string>();
	readonly #sessions = new FakeSessionStore();
	readonly #base = Date.now();
	readonly #path = process.env.PATH;
	readonly #env: Record<string, string>;
	#offset = 0;

	private constructor(
		readonly root: string,
		readonly repo: string,
		readonly bare: string,
		readonly hostRepo: string,
		readonly records: string,
	) {
		this.home = makeHome("jabbu-task-pr-remote-home-");
		this.fake = new FakeGh({ slug: SLUG, bare });
		this.transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		this.transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
		const gitconfig = join(root, "gitconfig");
		writeFileSync(gitconfig, "[init]\n\tdefaultBranch = main\n");
		this.#env = {
			PATH: join(root, "bin") + (this.#path === undefined ? "" : `:${this.#path}`),
			HOME: root,
			GIT_CONFIG_GLOBAL: gitconfig,
			GIT_CONFIG_NOSYSTEM: "1",
			LC_ALL: "C.UTF-8",
		};
	}

	/** `entry`: the repository's `lanes.land` entry (default: pr with the host's repository as `remotes[h1]`). */
	static async start(entry?: (hostRepo: string) => LandEntry): Promise<RemoteWorld> {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-task-pr-remote-")));
		const bare = join(root, "origin.git");
		mkdirSync(bare);
		git(bare, "init", "-q", "--bare", "-b", "main");
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, "add", "--", "README.md");
		git(repo, "commit", "-q", "-m", "init");
		git(repo, "remote", "add", "origin", GITHUB_URL);
		git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
		git(repo, "push", "-q", "origin", "main");
		git(repo, "fetch", "-q", "origin", "main");
		// The host's own clone of the repository: the task's worktree and branch live here.
		git(root, "clone", "-q", bare, "hostrepo");
		const hostRepo = join(root, "hostrepo");
		const records = join(root, "records");
		mkdirSync(join(records, "release"), { recursive: true });
		git(records, "init", "-q", "-b", "main");
		writeFileSync(join(records, "release", "denylist.txt"), "# planted\nplanted-owner-marker-7310\n");
		// The sweep's own reads of a remote task (`taskHostOf`) run the real `ssh` from PATH: this one logs the call and runs the command line locally.
		mkdirSync(join(root, "bin"));
		const guard = join(root, "bin", "ssh");
		writeFileSync(
			guard,
			`#!/bin/sh\necho "$@" >> ${join(root, "path-ssh.log")}\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec sh -c "$*"\n`,
		);
		chmodSync(guard, 0o755);
		const world = new RemoteWorld(root, repo, bare, hostRepo, records);
		process.env.PATH = world.#env.PATH ?? "";
		await world.#boot(entry?.(hostRepo) ?? { mode: "pr", remotes: { [HOST]: hostRepo } });
		return world;
	}

	/** The fake ssh: the remote words run in a local shell (as ssh's remote shell would); herdr answers like the harness's. */
	#herdrRun(): ProcessRunner {
		return async (cmd) => {
			if (cmd[0] !== "ssh") return { code: 0, stdout: "{}", timedOut: false };
			expect(cmd.slice(0, 7)).toEqual(SSH_HEAD);
			const words = cmd.slice(7).map(unquote);
			if (words[0] === "herdr") {
				this.herdr.push({ ssh: cmd.slice(0, 7), words });
				const agents = [...this.#agents].map((name) => ({
					name,
					agent_status: "idle",
					workspace_id: `ws-${name}`,
					tab_id: `tab-${name}`,
				}));
				const stdout = words.includes("list") ? JSON.stringify({ result: { agents } }) : "{}";
				return { code: 0, stdout, timedOut: false };
			}
			const line = cmd.slice(7).join(" ");
			if (words.at(-1) === "2>&1") words.pop();
			this.events.push(`ssh:${words.join(" ")}`);
			const done = Bun.spawnSync(["sh", "-c", line], { cwd: this.root, env: this.#env });
			const result = { code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
			this.remote.push({ words, code: result.code, stdout: result.stdout });
			return { ...result, timedOut: false };
		};
	}

	async #boot(entry: LandEntry): Promise<void> {
		const gitSeam: GitRunner = async (args) => {
			this.gitCalls.push(args);
			return defaultGit(args);
		};
		const tools: PrTools = {
			...this.fake.tools,
			git: (argv, opts) => {
				this.events.push(`git:${argv.join(" ")}`);
				return this.fake.tools.git(argv, opts);
			},
		};
		const gitleaks = join(this.root, "gitleaks");
		writeFileSync(gitleaks, "#!/bin/sh\nexit 0\n");
		chmodSync(gitleaks, 0o755);
		this.daemon = new Daemon({
			...daemonTestOptions(),
			config: {
				...this.home.config,
				herdr: { bin: "herdr" },
				recordsRepo: this.records,
				dispatchHosts: { [HOST]: { ssh: SSH_TARGET, workDir: this.root } },
				lanes: { land: { [this.repo]: entry } },
			},
			channels: [discordBinding(this.transport)],
			log: createLogger({ sink: () => {}, clock: this.clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			clock: this.clock,
			taskSweepMs: 0,
			herdrRun: this.#herdrRun(),
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: this.#sessions }),
			taskLand: (row, deps) =>
				landTask(row, {
					...deps,
					git: gitSeam,
					judge: (task, options) => {
						this.events.push("judge");
						this.judgeCalls.push({ row: task, options });
						return this.judge === undefined ? deps.judge(task, options) : this.judge(task, options);
					},
				}),
			prLand: {
				tools,
				seams: {
					git: gitSeam,
					// The host's repository is a local path here.
					address: (ssh, repo) => {
						this.addresses.push([ssh, repo]);
						return repo;
					},
					gitleaks,
					checkLeaks: (input) => {
						this.leakInputs.push(input);
						return checkLeaks(input);
					},
					crash: (point) => {
						this.crashes.push(point);
					},
				},
			},
		});
		await this.daemon.start();
	}

	advance(ms: number): void {
		this.#offset += ms;
	}

	/** A reached [TASK] on the host: its worktree and branch in the host's repository, docs under the records repository. */
	seed(options: { commits?: (worktree: string) => void; acceptance?: string[]; status?: "working" | "review" } = {}) {
		const tasks = this.daemon.store.tasks;
		const registered = tasks.register({
			title: "로그 회전",
			risk: "L2",
			originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
			threadRef: `${CHANNEL}:${THREAD}`,
			host: HOST,
			repo: this.hostRepo,
			acceptance: acceptanceItems(options.acceptance ?? ["하나", "둘"]),
			recordsRoot: this.records,
		});
		const { worktree, branch, taskId } = registered;
		git(this.hostRepo, "worktree", "add", "-q", "-b", branch, worktree, "main");
		tasks.setBaseSha(taskId, git(worktree, "rev-parse", "HEAD"));
		if (options.commits === undefined) this.commit(worktree, ["a.txt"]);
		else options.commits(worktree);
		mkdirSync(docsDirOf(registered), { recursive: true });
		this.#agents.add(registered.agent);
		if ((options.status ?? "review") === "review") tasks.transition(taskId, "review", "bot");
		return { row: tasks.require(taskId), sha: git(worktree, "rev-parse", "HEAD") };
	}

	commit(dir: string, files: string[], content?: string): string {
		for (const file of files) {
			mkdirSync(join(dir, file, ".."), { recursive: true });
			writeFileSync(join(dir, file), content ?? `${file}\n`);
		}
		git(dir, "add", "--", ...files);
		git(dir, "commit", "-q", "-m", `add ${files.join(" ")}`);
		return git(dir, "rev-parse", "HEAD");
	}

	/** Someone else lands `files` on the remote base branch. */
	moveBaseAhead(files: string[], content?: string): string {
		const scratch = mkdtempSync(join(this.root, "other-"));
		git(scratch, "clone", "-q", this.bare, "w");
		const work = join(scratch, "w");
		return this.#pushed(work, files, content);
	}

	#pushed(work: string, files: string[], content: string | undefined): string {
		git(work, "config", "user.name", "someone else");
		git(work, "config", "user.email", "else@jabbu.invalid");
		const sha = this.commit(work, files, content);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
		return sha;
	}

	/** The worker's next move: a new commit on the same branch and the task reaches review again. */
	workerFixes(row: TaskRow, file: string): string {
		const sha = this.commit(row.worktree, [file]);
		this.daemon.store.tasks.transition(row.taskId, "review", "bot");
		return sha;
	}

	row(taskId: string): TaskRow {
		return this.daemon.store.tasks.require(taskId);
	}

	record(taskId: string) {
		return this.row(taskId).land;
	}

	async poll(ms = 60_001): Promise<void> {
		this.advance(ms);
		await this.daemon.sweepTasks();
	}

	/** `머지해` inbound rows (a handed-off merge turn). */
	mergeInbounds() {
		return this.daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));
	}

	/** The resume prompts herdr took for a PR landing sent back to the worker. */
	prompts() {
		return this.herdr.filter(
			(call) =>
				call.words[1] === "agent" &&
				call.words[2] === "prompt" &&
				(call.words[4] ?? "").includes("PR 착지를 마치지 못했습니다"),
		);
	}

	/** Every ssh command of the core that is not herdr's, as words. */
	remoteWords(): string[][] {
		return this.remote.map((call) => call.words);
	}

	/** The command lines the sweep's own `ssh` (from PATH) ran. */
	pathSshLines(): string[] {
		const log = join(this.root, "path-ssh.log");
		return existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line !== "")
			: [];
	}

	async close(): Promise<void> {
		if (this.#path === undefined) delete process.env.PATH;
		else process.env.PATH = this.#path;
		await this.daemon.stop();
		this.home.remove();
		for (const entry of this.fake.bodyDirs) rmSync(entry, { recursive: true, force: true });
		rmSync(this.root, { recursive: true, force: true });
	}
}

const worlds: RemoteWorld[] = [];

afterEach(async () => {
	for (const world of worlds.splice(0)) {
		await world.close();
	}
});

async function start(entry?: (hostRepo: string) => LandEntry): Promise<RemoteWorld> {
	const world = await RemoteWorld.start(entry);
	worlds.push(world);
	return world;
}

const pushes = (w: RemoteWorld) => w.fake.callsOf("git", "push");
const ghCalls = (w: RemoteWorld) => w.fake.calls.filter((call) => call.program === "gh");
const tempRef = (row: TaskRow) => `refs/jabbu/task/${row.taskId}`;
/** The core's own fetch of the task branch (the `--` form), not the base branch's. */
const branchFetches = (w: RemoteWorld) => w.fake.callsOf("git", "fetch").filter((call) => call.argv.includes("--"));

/** No ssh command of the core changes a worktree or the repository there. */
function expectNoRemoteWrites(w: RemoteWorld): void {
	for (const words of [...w.remoteWords(), ...w.pathSshLines().map((line) => line.split(" "))])
		expect(words.filter((word) => WRITES.includes(word))).toEqual([]);
}

/** Opens the remote task's PR by auto-merge; the PR is open afterwards. */
async function open(w: RemoteWorld, options: Parameters<RemoteWorld["seed"]>[0] = {}) {
	const seeded = w.seed(options);
	expect(await w.daemon.autoLand(seeded.row)).toMatchObject({ state: "pr-open" });
	return seeded;
}

describe("원격 AC-11: handoff 대신 원격 PR 착지", () => {
	test("원격 AC-11(b): remotes[host]가 row.repo와 맞고 mode가 pr이면 fetch → PR을 시작하고 '머지해' 인바운드는 0이다", async () => {
		const w = await start();
		const { row } = w.seed();
		expect(await w.daemon.autoLand(row)).toMatchObject({ state: "pr-open" });
		expect(branchFetches(w)).toHaveLength(1);
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
		expect(w.record(row.taskId)).toMatchObject({ mode: "pr", state: "active", requestedBy: "auto" });
		expect(w.row(row.taskId).status).toBe("review");
	});

	const cases: [string, (hostRepo: string) => LandEntry][] = [
		["ff 모드", (hostRepo) => ({ mode: "ff", remotes: { [HOST]: hostRepo } })],
		["remotes 없음", () => ({ mode: "pr" })],
		["remotes가 다른 경로", () => ({ mode: "pr", remotes: { [HOST]: "/somewhere/else" } })],
	];
	for (const [name, entry] of cases) {
		test(`원격 AC-11(a): ${name}이면 handoff이고 원격 호스트 사유이며 fetch·push·gh는 0회다`, async () => {
			const w = await start(entry);
			const { row } = w.seed();
			const outcome = await w.daemon.autoLand(row);
			expect(outcome).toMatchObject({ state: "handoff", reason: expect.stringContaining(`원격 호스트(${HOST})`) });
			expect(branchFetches(w)).toHaveLength(0);
			expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
			expect(pushes(w)).toHaveLength(0);
			expect(ghCalls(w)).toHaveLength(0);
			expect(w.remote).toHaveLength(0);
			expect(w.record(row.taskId)).toBeNull();
			// The model turn's "머지해" is what a handoff means.
			expect(w.mergeInbounds()).toHaveLength(1);
		});
	}
});

describe("원격 fetch: 임시 ref로 가져와 재판정하고 그 sha로 PR을 연다", () => {
	test("원격 fetch: headOf(깨끗함) → `fetch -- <주소> +refs/heads/<branch>:refs/jabbu/task/<id>` → 원격 재판정 → headOf 재확인 순서로 돌고 로컬 저장소에 임시 ref가 생긴다", async () => {
		const w = await start();
		const { row, sha } = w.seed();
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
		expect(await w.daemon.autoLand(row)).toMatchObject({ state: "pr-open" });
		const fetches = branchFetches(w);
		expect(fetches).toHaveLength(1);
		expect(fetches[0]?.argv.slice(-4)).toEqual([
			"fetch",
			"--",
			w.hostRepo,
			`+refs/heads/${row.branch}:${tempRef(row)}`,
		]);
		expect(fetches[0]?.argv).toContain(`core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=8`);
		expect(w.addresses[0]).toEqual([SSH_TARGET, w.hostRepo]);
		expect(git(w.repo, "rev-parse", tempRef(row))).toBe(sha);

		const at = (match: (event: string) => boolean, from = 0) => {
			const index = w.events.findIndex((event, i) => i >= from && match(event));
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		};
		const headRead = at((e) => e.startsWith("ssh:git -C") && e.endsWith(" rev-parse HEAD"));
		const status = at((e) => e.includes("status --porcelain"), headRead);
		const fetched = at((e) => e.startsWith("git:") && e.includes(`+refs/heads/${row.branch}:${tempRef(row)}`), status);
		const judged = at((e) => e === "judge", fetched);
		const reread = at((e) => e.startsWith("ssh:git -C") && e.endsWith(" rev-parse HEAD"), judged);
		const pushed = at((e) => e.startsWith("git:") && e.includes(" push "), reread);
		expect(headRead).toBeLessThan(fetched);
		expect(reread).toBeLessThan(pushed);
	});

	test("원격 fetch: 원격 재판정은 host=row.host로 돌고 integrityBase는 로컬 저장소의 merge-base, row.baseSha는 그대로다", async () => {
		const w = await start();
		const { row, sha } = w.seed();
		const ahead = w.moveBaseAhead(["elsewhere.txt"]);
		// The base moved on but the branch is not built on it: the gate sends the worker back, after the re-judgement.
		expect(await w.daemon.autoLand(row)).toMatchObject({ state: "rework" });
		expect(w.judgeCalls).toHaveLength(1);
		const call = w.judgeCalls[0];
		expect(call?.row.host).toBe(HOST);
		expect(call?.row.baseSha).toBe(row.baseSha);
		expect(call?.options?.integrityBase).toBe(git(w.repo, "merge-base", "refs/remotes/origin/main", sha));
		expect(call?.options?.integrityBase).toBe(row.baseSha ?? "");
		expect(call?.options?.integrityBase).not.toBe(ahead);
		expect(w.row(row.taskId).baseSha).toBe(row.baseSha ?? "");
	});

	test("원격 fetch: origin에 직접 push(force·+refs 없음, 포크 0회)하고 로컬 task 브랜치 없이 PR이 임시 ref의 sha로 열린다", async () => {
		const w = await start();
		const { row, sha } = await open(w);
		expect(git(w.repo, "branch", "--list", row.branch)).toBe("");
		expect(git(w.repo, "rev-parse", tempRef(row))).toBe(sha);
		const pushed = pushes(w);
		expect(pushed).toHaveLength(1);
		expect(pushed[0]?.argv.slice(-3)).toEqual(["push", "origin", `${sha}:refs/heads/${row.branch}`]);
		expect(pushed[0]?.argv.some((arg) => arg.includes("force") || arg.startsWith("+") || arg === "-f")).toBe(false);
		expect(git(w.bare, "rev-parse", `refs/heads/${row.branch}`)).toBe(sha);
		expect(w.fake.callsOf("gh", "fork")).toHaveLength(0);
		expect(w.fake.callsOf("gh", "repo")).toHaveLength(0);
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(w.record(row.taskId)).toMatchObject({
			mode: "pr",
			state: "active",
			sha,
			baseBranch: "main",
			prLand: { number: 1, step: "pr-created", pushedSha: sha },
		});
	});

	/** The landing stopped before anything left: the task stays in review, nothing was pushed, `gh` never ran. */
	async function expectStopped(w: RemoteWorld, row: TaskRow, reason: string): Promise<void> {
		const outcome = await w.daemon.autoLand(row);
		expect(outcome).toMatchObject({ state: "blocked", reason: expect.stringContaining(reason) });
		expect(pushes(w)).toHaveLength(0);
		expect(ghCalls(w)).toHaveLength(0);
		expect(w.leakInputs).toHaveLength(0);
		expect(w.row(row.taskId).status).toBe("review");
		expect(w.mergeInbounds()).toHaveLength(0);
	}

	test("원격 fetch: 가져온 sha가 headOf.sha와 다르면(HEAD가 브랜치 끝이 아님) push·gh 0회로 blocked이고 재판정은 돌지 않는다", async () => {
		const w = await start();
		const { row } = w.seed({
			commits: (wt) => {
				w.commit(wt, ["a.txt"]);
				w.commit(wt, ["b.txt"]);
			},
		});
		// The worktree sits one commit behind its branch, clean: HEAD ≠ what the fetch brings.
		git(row.worktree, "checkout", "-q", "--detach", "HEAD~1");
		await expectStopped(w, row, "브랜치 끝이 아님");
		expect(branchFetches(w)).toHaveLength(1);
		expect(w.judgeCalls).toHaveLength(0);
	});

	test("원격 fetch: 재판정 중 원격 HEAD가 움직이면 push·gh 0회로 blocked", async () => {
		const w = await start();
		const { row } = w.seed();
		w.judge = async () => {
			w.commit(row.worktree, ["moved.txt"]);
			return passed();
		};
		await expectStopped(w, row, "검증 뒤 브랜치가 움직임");
		expect(w.judgeCalls).toHaveLength(1);
	});

	test("원격 fetch: 원격 worktree가 dirty면 fetch 전에 blocked", async () => {
		const w = await start();
		const { row } = w.seed();
		writeFileSync(join(row.worktree, "wip.txt"), "wip\n");
		await expectStopped(w, row, "커밋 안 된 변경");
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
		expect(w.judgeCalls).toHaveLength(0);
	});
});

describe("원격 반송: CI 빨강·base 앞섬은 원격 워커로, 코어는 원격 worktree를 쓰지 않는다", () => {
	/** Opens the PR and turns its CI red (`test` and `lint` fail). */
	async function red(w: RemoteWorld) {
		const seeded = await open(w);
		const sha = w.record(seeded.row.taskId)?.sha ?? "";
		w.fake.setCi(sha, "failure", ["test", "lint"]);
		await w.poll();
		return { ...seeded, sha };
	}

	test("원격 반송: CI 빨강은 resumeTask(host=row.host)로 ssh 옵션을 단 herdr 프롬프트가 되고, TASK는 working, '머지해'는 0회다", async () => {
		const w = await start();
		const { row } = await red(w);
		expect(w.row(row.taskId).status).toBe("working");
		expect(w.record(row.taskId)).toMatchObject({ mode: "pr", state: "rework", prLand: { number: 1, bounces: 1 } });
		expect(w.record(row.taskId)?.prLand.step).toBeUndefined();
		const sent = w.prompts();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.ssh).toEqual(SSH_HEAD);
		expect(sent[0]?.words.slice(1, 4)).toEqual(["agent", "prompt", row.agent]);
		expect(sent[0]?.words[4]).toContain(`같은 브랜치 \`${row.branch}\``);
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
		expectNoRemoteWrites(w);
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
	});

	test("원격 반송: base 앞섬도 같은 길로 워커에 반송되고 코어는 원격 worktree에 merge·rebase를 하지 않는다", async () => {
		const w = await start();
		const { row, sha } = w.seed();
		w.moveBaseAhead(["elsewhere.txt"]);
		const outcome = await w.daemon.autoLand(row);
		expect(outcome).toMatchObject({ state: "rework", reason: expect.stringContaining("앞서") });
		const all = [...w.gitCalls, ...w.fake.calls.map((call) => call.argv), ...w.remoteWords()];
		expect(all.some((argv) => argv.includes("rebase"))).toBe(false);
		expect(all.some((argv) => argv.includes("merge") && argv.includes("origin/main"))).toBe(false);
		expectNoRemoteWrites(w);
		expect(git(row.worktree, "rev-parse", "HEAD")).toBe(sha);
		expect(git(row.worktree, "status", "--porcelain")).toBe("");
		expect(pushes(w)).toHaveLength(0);
		expect(ghCalls(w)).toHaveLength(0);
		expect(w.row(row.taskId).status).toBe("working");
		expect(w.record(row.taskId)).toMatchObject({ state: "rework", reason: expect.stringContaining("앞서") });
		const sent = w.prompts();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.ssh).toEqual(SSH_HEAD);
		expect(sent[0]?.words[4]).toContain("git merge origin/main");
		expect(w.mergeInbounds()).toHaveLength(0);
		expect(w.daemon.store.listInbound()).toHaveLength(0);
	});

	test("원격 반송: 스위퍼는 rework 레코드를 폴링·재개하지 않는다", async () => {
		const w = await start();
		const { row } = await red(w);
		const gh = ghCalls(w).length;
		const sent = w.prompts().length;
		for (let tick = 0; tick < 3; tick++) await w.poll();
		expect(ghCalls(w)).toHaveLength(gh);
		expect(w.prompts()).toHaveLength(sent);
		expect(w.record(row.taskId)?.state).toBe("rework");
	});

	test("원격 반송: 새 커밋으로 다시 도달하면 다시 fetch하고, pushedSha와 다르면 step을 비워 게이트부터 돌며 낡은 sha로 머지하지 않는다", async () => {
		const w = await start();
		const { row, sha: old } = await red(w);
		const record = w.record(row.taskId);
		if (record === null) throw new Error("no record");
		w.daemon.store.tasks.setLand(row.taskId, { ...record, baseBranch: "stale-base" });
		const fetched = branchFetches(w).length;
		const checked = w.leakInputs.length;
		const fresh = w.workerFixes(w.row(row.taskId), "b.txt");
		w.crashes.length = 0;
		expect(await w.daemon.autoLand(w.row(row.taskId))).toMatchObject({ state: "pr-open" });
		expect(branchFetches(w)).toHaveLength(fetched + 1);
		expect(git(w.repo, "rev-parse", tempRef(row))).toBe(fresh);
		expect(w.crashes).toContain("leak-passed");
		expect(w.leakInputs).toHaveLength(checked + 1);
		expect(w.leakInputs.at(-1)?.sha).toBe(fresh);
		expect(w.record(row.taskId)).toMatchObject({
			state: "active",
			sha: fresh,
			baseBranch: "main",
			prLand: { number: 1, step: "pr-created", pushedSha: fresh },
		});
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		expect(git(w.bare, "rev-parse", `refs/heads/${row.branch}`)).toBe(fresh);
		// The old commit's green CI does not merge the new one.
		w.fake.setCi(old, "success");
		await w.poll();
		expect(w.fake.callsOf("gh", "merge")).toHaveLength(0);
		w.fake.setCi(fresh, "success");
		await w.poll();
		const merges = w.fake.callsOf("gh", "merge");
		expect(merges).toHaveLength(1);
		expect(merges[0]?.argv).toContain(fresh);
		expect(merges[0]?.argv).not.toContain(old);
		expect(w.row(row.taskId).status).toBe("done");
	});
});

describe("원격 merge-base: 워커가 base를 merge한 뒤 무결성 diff의 기준", () => {
	const TODO_FILE = "base-side.ts";

	/** The three documents of a finished task whose one acceptance item is proven by commit `sha`. */
	function writeDocs(w: RemoteWorld, row: TaskRow, sha: string): void {
		const meta = {
			taskId: row.taskId,
			hostLabel: HOST,
			repo: row.repo,
			worktree: row.worktree,
			branch: row.branch,
			agent: row.agent,
			threadLink: "x",
			registeredAt: w.clock.now(),
			timezone: "Asia/Seoul",
		};
		const spec = renderSpec(
			meta,
			{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: row.repo },
			row.acceptance,
		).replaceAll("- [ ] AC-", "- [x] AC-");
		writeFileSync(join(row.docsDir, "spec.md"), spec);
		writeFileSync(join(row.docsDir, "PROGRESS.md"), renderProgress(row.taskId, w.clock.now(), "Asia/Seoul"));
		writeFileSync(
			join(row.docsDir, "outcome.md"),
			`# ${row.taskId} Outcome 증거\n## 요약\n바뀌었습니다.\n## AC-1\n- commit: ${sha.slice(0, 9)} feat: a\n`,
		);
	}

	/** The base branch's own commit (an unfinished-work marker line in a code file) and the task branch with it merged in by its remote worker. */
	function mergedTask(w: RemoteWorld) {
		const { row, sha } = w.seed({ acceptance: ["하나"] });
		writeDocs(w, row, sha);
		const baseSide = w.moveBaseAhead([TODO_FILE], "// TODO base side\nexport const x = 1;\n");
		git(w.hostRepo, "fetch", "-q", "origin", "main");
		git(row.worktree, "merge", "-q", "--no-edit", "origin/main");
		return { row, feature: sha, baseSide, tip: git(row.worktree, "rev-parse", "HEAD") };
	}

	const prConfig = (w: RemoteWorld) => ({
		lanes: { land: { [w.repo]: { mode: "pr" as const, remotes: { [HOST]: w.hostRepo } } } },
		recordsRepo: w.records,
		dispatchHosts: { [HOST]: { ssh: SSH_TARGET } },
	});
	const env = (w: RemoteWorld) => ({
		config: prConfig(w),
		run: undefined,
		tools: w.fake.tools,
		git: defaultGit,
		address: (_ssh: string, repo: string) => repo,
	});

	test("원격 merge-base: 재판정의 branchDiff 기준은 merge-base sha이고 base 쪽 파일은 diff에 없으며 증거 해시는 not_on_branch가 아니다", async () => {
		const w = await start();
		const { row, feature, baseSide, tip } = mergedTask(w);
		const original = row.baseSha;
		w.judge = undefined;
		expect(await w.daemon.autoLand(row)).toMatchObject({ state: "pr-open" });
		expect(baseSide).toBe(git(w.repo, "merge-base", "refs/remotes/origin/main", tip));
		expect(baseSide).not.toBe(original);
		expect(w.judgeCalls).toHaveLength(1);
		expect(w.judgeCalls[0]?.options?.integrityBase).toBe(baseSide);
		expect(w.judgeCalls[0]?.row.baseSha).toBe(original);

		const diffs = w.remote.filter((call) => call.words.includes("diff"));
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.words).toContain(`${baseSide}..${row.branch}`);
		expect(diffs[0]?.words.join(" ")).not.toContain(`${original}..`);
		expect(diffs[0]?.stdout).not.toContain(TODO_FILE);
		expect(diffs[0]?.stdout).not.toContain("TODO");
		// The evidence is still measured from the row's own base: the commit before the merge is on the branch.
		const ancestors = w.remote.filter((call) => call.words.includes("--is-ancestor"));
		const asked = (older: string, newer: string) =>
			ancestors.find((call) => call.words.at(-2) === older && call.words.at(-1)?.startsWith(newer.slice(0, 9)));
		expect(asked(original ?? "", feature)?.code).toBe(0);
		expect(ancestors.some((call) => call.code === 1)).toBe(false);
		expect(w.row(row.taskId).baseSha).toBe(original);
		expect(w.record(row.taskId)).toMatchObject({ state: "active", sha: tip });
	});

	test("원격 merge-base: merge가 없는 브랜치와 baseSha의 후손이 아닌 브랜치는 기준을 바꾸지 않는다", async () => {
		const w = await start();
		const { row } = w.seed();
		w.moveBaseAhead([TODO_FILE]);
		expect(await remoteIntegrityBase(env(w), row)).toBeUndefined();
		const merged = mergedTask(w);
		expect(await remoteIntegrityBase(env(w), merged.row)).toBe(merged.baseSide);
		const orphan = git(w.repo, "commit-tree", "-m", "unrelated", "HEAD^{tree}");
		w.daemon.store.tasks.setBaseSha(merged.row.taskId, orphan);
		expect(await remoteIntegrityBase(env(w), w.row(merged.row.taskId))).toBeUndefined();
	});

	test("원격 merge-base: problems가 남은 판정에서는 지연 함수를 부르지 않아 fetch가 0회이고, 없으면 한 번 부른다", async () => {
		const w = await start();
		const { row, feature, baseSide } = mergedTask(w);
		const ops = createTaskHostOps({
			sshTarget: SSH_TARGET,
			run: async (cmd) => {
				const words = cmd.slice(7).map(unquote);
				const done = Bun.spawnSync(["sh", "-c", cmd.slice(7).join(" ")], {
					env: { PATH: process.env.PATH ?? "", HOME: w.root },
				});
				w.remote.push({ words, code: done.exitCode, stdout: done.stdout.toString() });
				return { code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString(), timedOut: false };
			},
		});
		let lazyCalls = 0;
		const lazy = async () => {
			lazyCalls += 1;
			return integrityBaseOf(prConfig(w), row, w.fake.tools, (_ssh, repo) => repo);
		};
		writeFileSync(join(row.docsDir, "outcome.md"), "");
		const failing = await evaluateTask(row, ops, memoryTaskChecks(), undefined, lazy);
		expect(failing.ok && failing.judgement.problems.length).toBeGreaterThan(0);
		expect(lazyCalls).toBe(0);
		expect(w.fake.callsOf("git", "fetch")).toHaveLength(0);
		writeDocs(w, row, feature);
		const evaluation = await evaluateTask(row, ops, memoryTaskChecks(), undefined, lazy);
		expect(evaluation.ok && evaluation.judgement.problems).toEqual([]);
		expect(lazyCalls).toBe(1);
		expect(w.fake.callsOf("git", "fetch").length).toBeGreaterThan(0);
		expect(w.remote.some((call) => call.words.includes(`${baseSide}..${row.branch}`))).toBe(true);
	});
});
