import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksCommand } from "../src/cli/tasks";
import { Daemon } from "../src/daemon/daemon";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { type LandEntryHost, landReviewed } from "../src/daemon/daemon-task-land-entry";
import { callDaemon, startIpcServer } from "../src/daemon/ipc";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { dispatchEnv } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems, docsDirOf } from "../src/tasks/docs";
import type { TaskEvaluation } from "../src/tasks/evaluate";
import { landTask, type TaskLandDeps } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import { GUILD, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const CHANNEL = "111111111111111111";
const THREAD = "222222222222222222";
const clock = { now: () => Date.now() };

const git = (dir: string, ...args: string[]): string =>
	execFileSync("git", ["-C", dir, ...args], { env: dispatchEnv(process.env), encoding: "utf8" }).trim();

const passed = (over: Partial<TaskJudgement> = {}): TaskEvaluation => ({
	ok: true,
	judgement: { problems: [], integrityWarnings: [], ...over } as Partial<TaskJudgement> as TaskJudgement,
});

let root: string;
let repo: string;
let home: TestHome;
let daemon: Daemon;
let transport: WaitingDiscordTransport;
let judge: () => Promise<TaskEvaluation>;
/** Modes the core landing was asked with, one entry per call. */
let landModes: Array<TaskLandDeps["mode"]>;
/** Set by a test to hold every core landing until it resolves. */
let landGate: Promise<void> | undefined;
/** Resolves when the first core landing of a test has started. */
let landEntered: PromiseWithResolvers<void>;
const stops: Array<() => void> = [];

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "jabbu-cli-land-"));
	repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo], { env: dispatchEnv(process.env) });
	git(repo, "config", "user.name", "t");
	git(repo, "config", "user.email", "t@example.test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "readme\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	judge = async () => passed();
	landModes = [];
	landGate = undefined;
	landEntered = Promise.withResolvers<void>();
	home = makeHome("jabbu-cli-land-home-");
	transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [new DiscordBinding(new DiscordChannel(transport, { ownerUserId: OWNER }), { peerPartWaitMs: 0 })],
		log: createLogger({ sink: () => {}, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		taskLand: async (row, deps) => {
			landModes.push(deps.mode);
			landEntered.resolve();
			await landGate;
			return landTask(row, { ...deps, judge: () => judge() });
		},
	});
	await daemon.start();
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	await daemon.stop();
	home.remove();
	rmSync(root, { recursive: true, force: true });
});

/** A task in `status`: for `review` a reached local task (worktree branch with one feature commit and its evidence). */
function seed(status: TaskRow["status"], threadRef = `${CHANNEL}:${THREAD}`): TaskRow {
	const tasks = daemon.store.tasks;
	const registered = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef,
		host: null,
		repo,
		acceptance: acceptanceItems(["하나"]),
	});
	const { worktree, branch, taskId } = registered;
	git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	tasks.setBaseSha(taskId, git(worktree, "rev-parse", "HEAD"));
	writeFileSync(join(worktree, "a.txt"), "task a\n");
	git(worktree, "add", "a.txt");
	git(worktree, "commit", "-q", "-m", "feat: a");
	const feat = git(worktree, "rev-parse", "HEAD");
	const docs = docsDirOf(registered);
	mkdirSync(docs, { recursive: true });
	writeFileSync(join(docs, "outcome.md"), `## AC-1\n- commit: ${feat.slice(0, 9)} feat: a\n`);
	writeFileSync(join(docs, "PROGRESS.md"), `- [x] S1 | 증거: commit ${feat.slice(0, 7)}\n`);
	git(worktree, "add", "docs");
	git(worktree, "commit", "-q", "-m", "docs: evidence");
	if (status !== "working") tasks.transition(taskId, status, status === "done" ? "human" : "bot");
	return tasks.require(taskId);
}

/** `jabbu-pocket tasks <args>` against the test home, its streams captured. */
async function runTasks(args: string[], landTimeoutMs?: number) {
	const out: string[] = [];
	const err: string[] = [];
	const write = { out: process.stdout.write, err: process.stderr.write };
	process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
	try {
		const code = await tasksCommand(args, home.dir, landTimeoutMs === undefined ? {} : { landTimeoutMs });
		return { code, stdout: out.join(""), stderr: err.join("") };
	} finally {
		process.stdout.write = write.out;
		process.stderr.write = write.err;
	}
}

const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim() === "머지해");
const threadCards = () => transport.posts().filter((call) => call.channelId === THREAD);

describe("tasks land (CLI → daemon)", () => {
	test("AC-1: a review task is landed once through the button's landing function (mode=button), the result JSON comes out and the task is done", async () => {
		const row = seed("review");
		const result = await runTasks(["land", row.taskId]);
		expect(result.code).toBe(0);
		expect(landModes).toEqual(["button"]);
		const answer = JSON.parse(result.stdout) as {
			ok: boolean;
			task: string;
			result: { state: string; sha: string };
			posted: boolean;
		};
		expect(answer).toMatchObject({ ok: true, task: row.taskId, result: { state: "landed" }, posted: true });
		expect(git(repo, "rev-parse", "main")).toBe(answer.result.sha);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("done");
		expect(mergeInbounds()).toHaveLength(0);
	});

	test.each(["working", "blocked", "done"] as const)(
		"AC-2: a %s task is refused with exit code 2 and never reaches the landing",
		async (status) => {
			const row = seed(status);
			const result = await runTasks(["land", row.taskId]);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(status);
			expect(landModes).toEqual([]);
		},
	);

	test("AC-2: the daemon refuses a task that is not in review itself (a stale CLI view)", async () => {
		const row = seed("working");
		const answer = await callDaemon(daemon.socketPath, { op: "tasks_land", id: row.taskId }, 10_000);
		expect(answer).toMatchObject({ ok: false, error: "wrong_status", status: "working" });
		expect(await callDaemon(daemon.socketPath, { op: "tasks_land", id: "T-none" }, 10_000)).toMatchObject({
			ok: false,
			error: "not_found",
		});
		expect(landModes).toEqual([]);
	});

	test("AC-2: a task already being landed is refused as in_flight with exit code 2; the first landing still finishes", async () => {
		const row = seed("review");
		const release = Promise.withResolvers<void>();
		landGate = release.promise;
		const first = runTasks(["land", row.taskId]);
		// The first landing holds the lock once its core landing runs.
		await landEntered.promise;
		const second = await runTasks(["land", row.taskId]);
		expect(second.code).toBe(2);
		expect(second.stdout).toContain('"error":"in_flight"');
		release.resolve();
		expect((await first).code).toBe(0);
		expect(landModes).toEqual(["button"]);
	});

	test("AC-3: an integrity warning blocks the landing with the button's reason (same mode, handed back, task still in review)", async () => {
		const row = seed("review");
		judge = async () =>
			passed({ integrityWarnings: ["무결성 guard_deletion_without_adversarial_regression: test/x.test.ts"] });
		const result = await runTasks(["land", row.taskId]);
		const answer = JSON.parse(result.stdout) as { result: { state: string; reason: string } };
		expect(answer.result.state).toBe("handoff");
		expect(answer.result.reason).toContain("무결성 경고: 무결성 guard_deletion_without_adversarial_regression");
		expect(landModes).toEqual(["button"]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("review");
		expect(git(repo, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
		// The CLI puts the handoff into the thread like the button, with its own marker.
		expect(transport.posts((text) => text === "🔘 머지 (tasks land)")).toHaveLength(1);
		expect(mergeInbounds()).toHaveLength(1);
	});

	test("AC-5: a landed result is posted to the task thread as a card that names the request", async () => {
		const row = seed("review");
		const result = await runTasks(["land", row.taskId]);
		expect(result.code).toBe(0);
		const cards = threadCards().filter((call) => JSON.stringify(call).includes("tasks land 요청"));
		expect(cards).toHaveLength(1);
		expect(JSON.stringify(cards[0])).toContain("코어 착지 완료");
	});

	test("AC-5: a daemon draining for a restart refuses, and the landing never starts", async () => {
		const row = seed("review");
		daemon.setDraining(true);
		const result = await runTasks(["land", row.taskId]);
		expect(result.code).toBe(2);
		expect(result.stdout).toContain('"error":"draining"');
		expect(landModes).toEqual([]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("review");
	});

	test("AC-5: no daemon and no answer in time are told apart", async () => {
		const row = seed("review");
		await daemon.stop();
		const none = await runTasks(["land", row.taskId]);
		expect(none.code).toBe(1);
		expect(none.stderr).toContain("데몬이 떠 있지 않음");
		expect(none.stderr).not.toContain("응답 지연");
		const hung = startIpcServer(join(home.dir, "jabbu.sock"), () => new Promise<never>(() => {}));
		stops.push(() => hung.stop());
		const late = await runTasks(["land", row.taskId], 100);
		expect(late.code).toBe(1);
		expect(late.stderr).toContain("응답 지연");
		expect(late.stderr).toContain(`tasks show ${row.taskId}`);
		expect(late.stderr).not.toContain("데몬이 떠 있지 않음");
	});
});

describe("landReviewed re-reads the task after the gate stopped", () => {
	/** A host whose gate abort runs `onAbort`; the core landing counts its calls. */
	function fakeHost(row: TaskRow, onAbort: (set: (patch: Partial<TaskRow>) => void, drain: () => void) => void) {
		let current: TaskRow = row;
		let ready = true;
		let lands = 0;
		const host: LandEntryHost = {
			ctx: {
				log: { info() {}, warn() {} },
				store: { tasks: { get: () => current } },
				taskGates: {
					abort: async () =>
						onAbort(
							(patch) => (current = { ...current, ...patch }),
							() => (ready = false),
						),
				},
			} as unknown as DaemonContext,
			taskLanding: new Set(),
			landReady: () => ready,
			coreLand: async () => {
				lands += 1;
				return { state: "blocked", reason: "x" };
			},
			releaseAfterTurn: () => {},
		};
		return { host, lands: () => lands, lock: host.taskLanding };
	}

	test("a task whose status changed during the abort is refused with its new status; the lock stays free", async () => {
		const row = seed("review");
		const fake = fakeHost(row, (set) => set({ status: "done" }));
		const out = await landReviewed(fake.host, row.taskId, { logKind: "cli_land", marker: "m" });
		expect(out).toMatchObject({ kind: "refused", reason: "wrong_status", row: { status: "done" } });
		expect(fake.lands()).toBe(0);
		expect(fake.lock.size).toBe(0);
	});

	test("a drain that began during the abort refuses too", async () => {
		const row = seed("review");
		const fake = fakeHost(row, (_set, drain) => drain());
		const out = await landReviewed(fake.host, row.taskId, { logKind: "cli_land", marker: "m" });
		expect(out).toMatchObject({ kind: "refused", reason: "draining" });
		expect(fake.lands()).toBe(0);
		expect(fake.lock.size).toBe(0);
	});

	test("an untouched task lands once and frees the lock", async () => {
		const row = seed("review");
		const fake = fakeHost(row, () => {});
		const out = await landReviewed(fake.host, row.taskId, { logKind: "cli_land", marker: "m" });
		expect(out).toMatchObject({ kind: "landed", result: { state: "blocked" } });
		expect(fake.lands()).toBe(1);
		expect(fake.lock.size).toBe(0);
	});
});
