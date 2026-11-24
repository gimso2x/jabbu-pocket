import { setSystemTime } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/daemon";
import type { ProcessRunner } from "../../src/dispatch/omp";
import type { PrLandCrashPoint } from "../../src/lanes/pr-land-steps";
import { defaultGit, type GitRunner } from "../../src/lanes/verify";
import { createLogger } from "../../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../../src/omp/fake-driver";
import { redact } from "../../src/redact";
import { checkLeaks } from "../../src/release/leak-check";
import type { TaskJudgement } from "../../src/tasks/checker";
import { acceptanceItems, docsDirOf } from "../../src/tasks/docs";
import type { TaskEvaluation } from "../../src/tasks/evaluate";
import { landTask } from "../../src/tasks/land";
import type { TaskRow } from "../../src/tasks/ledger";
import { discordBinding, GUILD, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./bot-home";
import { FakeGh } from "./fake-gh";
import { git } from "./git-fixtures";

/** Own-repository PR landing of a [TASK]: real git in temp dirs, a local bare repository as GitHub's copy, a fake `gh`. */
export const SLUG = "acme/widgets";
export const GITHUB_URL = `https://github.com/${SLUG}.git`;
/** Planted denylist marker (not an owner identifier: the real denylist is never read here). */
export const PLANTED = "planted-owner-marker-7310";
export const CHANNEL = "111111111111111111";
export const THREAD = "222222222222222222";

/** The process death of a crash hook: a distinct error so a test can tell it from a real failure. */
export class Died extends Error {
	constructor(readonly point: PrLandCrashPoint) {
		super(`process died at ${point}`);
	}
}

/** A judgement that lets the tip through. */
export const passed = (over: Partial<TaskJudgement> = {}): TaskEvaluation => ({
	ok: true,
	judgement: { problems: [], integrityWarnings: [], ...over } as Partial<TaskJudgement> as TaskJudgement,
});

export interface SeedOptions {
	/** Commits made in the task worktree after the branch was created (default: one `a.txt`). */
	commits?: (worktree: string) => void;
	acceptance?: string[];
	/** `working` leaves the task for the sweep to reach; default `review`. */
	status?: "working" | "review";
}

/** One running daemon with a pr-mode repository, its fake GitHub and every observation a test needs. */
export class TaskPrWorld {
	readonly home: TestHome;
	readonly transport: WaitingDiscordTransport;
	readonly fake: FakeGh;
	/** `herdr` commands the daemon ran (the fake herdr knows every agent in `agents`). */
	readonly herdr: string[][] = [];
	readonly agents = new Set<string>();
	/** Every git call of the core's own landing steps (`deps.git`). */
	readonly gitCalls: string[][] = [];
	readonly leakInputs: Parameters<typeof checkLeaks>[0][] = [];
	readonly crashes: PrLandCrashPoint[] = [];
	readonly judgeCalls: { row: TaskRow; options: { integrityBase?: string } | undefined }[] = [];
	crashAt: PrLandCrashPoint | undefined;
	judge: (row: TaskRow, options?: { integrityBase?: string }) => Promise<TaskEvaluation> = async () => passed();
	daemon!: Daemon;
	#offset = 0;
	#base = Date.now();
	#sessions = new FakeSessionStore();
	#seq = 0n;

	private constructor(
		readonly root: string,
		readonly repo: string,
		readonly bare: string,
		readonly records: string,
		readonly denylistFile: string,
	) {
		this.home = makeHome("ompbot-task-pr-home-");
		this.transport = new WaitingDiscordTransport();
		this.fake = new FakeGh({ slug: SLUG, bare });
		this.transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		this.transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	}

	static async start(): Promise<TaskPrWorld> {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ompbot-task-pr-")));
		// The bare repository's name ends in `.git`: the core refuses an origin that may be a live checkout.
		const bare = join(root, "origin.git");
		mkdirSync(bare);
		git(bare, "init", "-q", "--bare", "-b", "main");
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		for (const [key, value] of [
			["user.name", "ompbot fixture"],
			["user.email", "fixture@ompbot.invalid"],
			["commit.gpgsign", "false"],
		] as const)
			git(repo, "config", key, value);
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, "add", "--", "README.md");
		git(repo, "commit", "-q", "-m", "init");
		git(repo, "remote", "add", "origin", GITHUB_URL);
		git(repo, "config", `url.${bare}.insteadOf`, GITHUB_URL);
		git(repo, "push", "-q", "origin", "main");
		git(repo, "fetch", "-q", "origin", "main");
		const records = join(root, "records");
		mkdirSync(join(records, "release"), { recursive: true });
		git(records, "init", "-q", "-b", "main");
		for (const [key, value] of [
			["user.name", "ompbot fixture"],
			["user.email", "fixture@ompbot.invalid"],
			["commit.gpgsign", "false"],
		] as const)
			git(records, "config", key, value);
		const denylistFile = join(records, "release", "denylist.txt");
		writeFileSync(denylistFile, `# planted\n${PLANTED}\n`);
		git(records, "add", "--", "release/denylist.txt");
		git(records, "commit", "-q", "-m", "records init");
		const world = new TaskPrWorld(root, repo, bare, records, denylistFile);
		await world.#boot();
		return world;
	}

	/** The test clock: starts at the real time and only moves when a test says so. */
	readonly clock = { now: () => this.#base + this.#offset };

	advance(ms: number): void {
		this.#offset += ms;
	}

	async #boot(): Promise<void> {
		const gitSeam: GitRunner = async (args) => {
			this.gitCalls.push(args);
			return defaultGit(args);
		};
		const herdrRun: ProcessRunner = async (cmd) => {
			this.herdr.push(cmd);
			const agents = [...this.agents].map((name) => ({
				name,
				agent_status: "idle",
				workspace_id: `ws-${name}`,
				tab_id: `tab-${name}`,
			}));
			return { code: 0, stdout: cmd.includes("list") ? JSON.stringify({ result: { agents } }) : "{}", timedOut: false };
		};
		this.daemon = new Daemon({
			config: {
				...this.home.config,
				herdr: { bin: "herdr" },
				recordsRepo: this.records,
				lanes: { land: { [this.repo]: { mode: "pr" } } },
			},
			channels: [discordBinding(this.transport)],
			log: createLogger({ sink: () => {}, clock: this.clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			clock: this.clock,
			taskSweepMs: 0,
			herdrRun,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: this.#sessions }),
			taskLand: (row, deps) =>
				landTask(row, {
					...deps,
					git: gitSeam,
					judge: (task, options) => {
						this.judgeCalls.push({ row: task, options });
						return this.judge(task, options);
					},
				}),
			prLand: {
				tools: this.fake.tools,
				seams: {
					git: gitSeam,
					gitleaks: this.#gitleaks(),
					checkLeaks: (input) => {
						this.leakInputs.push(input);
						return checkLeaks(input);
					},
					crash: (point) => {
						this.crashes.push(point);
						if (this.crashAt === point) throw new Died(point);
					},
				},
			},
		});
		await this.daemon.start();
	}

	/** A gitleaks that finds nothing: the leak check itself (git, denylist) is the real one. */
	#gitleaks(): string {
		const path = join(this.root, "gitleaks");
		writeFileSync(path, "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o755);
		return path;
	}

	/** A reached local [TASK] in the pr-mode repository: a worktree on `task/<ID>` with its commits, docs under the records repository. */
	seed(options: SeedOptions = {}): { row: TaskRow; sha: string } {
		const tasks = this.daemon.store.tasks;
		const registered = tasks.register({
			title: "로그 회전",
			risk: "L2",
			originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
			threadRef: `${CHANNEL}:${THREAD}`,
			host: null,
			repo: this.repo,
			acceptance: acceptanceItems(options.acceptance ?? ["하나", "둘"]),
			recordsRoot: this.records,
		});
		const { worktree, branch, taskId } = registered;
		git(this.repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
		tasks.setBaseSha(taskId, git(worktree, "rev-parse", "HEAD"));
		if (options.commits === undefined) this.commit(worktree, ["a.txt"]);
		else options.commits(worktree);
		const docs = docsDirOf(registered);
		mkdirSync(docs, { recursive: true });
		this.agents.add(registered.agent);
		if ((options.status ?? "review") === "review") tasks.transition(taskId, "review", "bot");
		return { row: tasks.require(taskId), sha: git(worktree, "rev-parse", "HEAD") };
	}

	/** Commits `files` in `dir` (each with `content`, default its name); returns the new HEAD. */
	commit(dir: string, files: string[], content?: string, ...config: string[]): string {
		for (const file of files) {
			mkdirSync(join(dir, file, ".."), { recursive: true });
			writeFileSync(join(dir, file), content ?? `${file}\n`);
		}
		git(dir, "add", "--", ...files);
		git(dir, ...config, "commit", "-q", "-m", `add ${files.join(" ")}`);
		return git(dir, "rev-parse", "HEAD");
	}

	/** Someone else lands `files` on the remote base branch (the local tracking ref follows at the next fetch). */
	moveBaseAhead(files: string[] = ["elsewhere.txt"], content?: string): string {
		const scratch = mkdtempSync(join(this.root, "other-"));
		git(scratch, "clone", "-q", this.bare, "w");
		const work = join(scratch, "w");
		for (const [key, value] of [
			["user.name", "someone else"],
			["user.email", "else@ompbot.invalid"],
		] as const)
			git(work, "config", key, value);
		const sha = this.commit(work, files, content);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
		return sha;
	}

	row(taskId: string): TaskRow {
		return this.daemon.store.tasks.require(taskId);
	}

	record(taskId: string) {
		return this.row(taskId).land;
	}

	/** The next sweep: past the poll interval, one tick of the task sweeper. */
	async poll(ms = 60_001): Promise<void> {
		this.advance(ms);
		await this.daemon.sweepTasks();
	}

	/** Thread posts (plain text and cards) the bot made, as text. */
	posts(): string[] {
		return this.transport.calls.flatMap((call) =>
			call.method === "createMessage" ? [JSON.stringify(call.embeds ?? call.content ?? "")] : [],
		);
	}

	/** `머지해` inbound rows (a handed-off merge turn). */
	mergeInbounds() {
		return this.daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));
	}

	/** Shifts the real clock the freeze probe reads, so its 2 s cache is stale without waiting. */
	jumpRealClock(): void {
		setSystemTime(new Date(Date.now() + 10_000));
	}

	/** The owner presses the `머지` button of a card in the task thread. */
	async clickMerge(taskId: string): Promise<string> {
		const card = await this.transport.createMessage({ channelId: THREAD, content: "🔍 머지 대기 카드" });
		this.#seq += 1n;
		await this.transport.emitInteraction({
			id: String(800_000_000_000_000_000n + this.#seq),
			application_id: "600000000000000000",
			type: 3,
			token: `token-${this.#seq}`,
			channel_id: THREAD,
			guild_id: GUILD,
			member: { user: { id: OWNER } },
			data: { custom_id: `ompbot:task:merge:${taskId}`, component_type: 2 },
			message: { id: card.id, channel_id: THREAD },
		});
		return card.id;
	}

	async close(): Promise<void> {
		setSystemTime();
		await this.daemon.stop();
		this.home.remove();
		for (const entry of this.fake.bodyDirs) rmSync(entry, { recursive: true, force: true });
		rmSync(this.root, { recursive: true, force: true });
	}
}
