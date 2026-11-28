import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOP_LEVEL_TS } from "../src/core/normalize";
import { Daemon } from "../src/daemon/daemon";
import { DiscordCallError } from "../src/discord/transport";
import { dispatchEnv, type ProcessRunner, type RunProcessResult } from "../src/dispatch/omp";
import { receiptNowOf } from "../src/lanes/land";
import { createGateSlot } from "../src/lanes/qa";
import { bootRuntime } from "../src/lanes/runtime";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskCheck, TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { GATE_STALE_REASON, gateRuntimeKey, type TaskGateEnd, type TaskGateHooks } from "../src/tasks/gate";
import { landTask, type TaskLandResult } from "../src/tasks/land";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import { migrateTaskSchema } from "../src/tasks/ledger-schema";
import { autoLandBlockers, buildReachedCard, holdingIntegrityWarnings } from "../src/tasks/notify";
import { discordBinding, GUILD, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const CHANNEL = "111111111111111111";
const THREAD = "222222222222222222";

/** A Discord transport that knows the task's server channel and its thread. */
function threadTransport(): WaitingDiscordTransport {
	const discord = new WaitingDiscordTransport();
	discord.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	discord.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	return discord;
}

let interactionSeq = 0n;
/** The owner presses the button `customId` of the card `card` in the task thread. */
function click(discord: WaitingDiscordTransport, customId: string, card: string): Promise<void> {
	interactionSeq += 1n;
	return discord.emitInteraction({
		id: String(800_000_000_000_000_000n + interactionSeq),
		application_id: "600000000000000000",
		type: 3,
		token: `token-${interactionSeq}`,
		channel_id: THREAD,
		guild_id: GUILD,
		member: { user: { id: OWNER } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: card, channel_id: THREAD },
	});
}
const clock = { now: () => Date.now() };

let home: TestHome;
let daemon: Daemon;
let transport: WaitingDiscordTransport;
let logs: string[];

beforeEach(async () => {
	home = makeHome("jabbu-autoland-");
	logs = [];
	transport = threadTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [discordBinding(transport)],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

/** A [TASK] in review on `repo`, its thread `threadRef`. */
function seedTask(over: { threadRef?: string; repo?: string } = {}): TaskRow {
	const tasks = daemon.store.tasks;
	const row = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef: over.threadRef ?? `${CHANNEL}:${THREAD}`,
		host: null,
		repo: over.repo ?? "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	tasks.transition(row.taskId, "review", "bot");
	return tasks.require(row.taskId);
}

const markers = () => transport.posts((text: string) => text === "🤖 자동 머지");
const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));

describe("daemon repoMatches (git common directory)", () => {
	let root: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
			env: dispatchEnv(process.env),
			stdio: "ignore",
		});
	const initRepo = (dir: string) => {
		git("init", "-q", dir);
		git("-C", dir, "commit", "-q", "--allow-empty", "-m", "init");
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "jabbu-autoland-git-"));
		initRepo(join(root, "jabbu"));
		git("-C", join(root, "jabbu"), "worktree", "add", "-q", join(root, "jabbu-t-1"), "-b", "task/T-1");
		initRepo(join(root, "jabbux"));
		symlinkSync(join(root, "jabbu"), join(root, "jabbu-link"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("AC-6: another worktree of the same repository matches; a look-alike separate repository does not", async () => {
		const worktree = seedTask({ repo: join(root, "jabbu-t-1") });
		expect(await daemon.repoMatches(worktree, [join(root, "jabbu")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "jabbux"), join(root, "jabbu")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "jabbux")])).toBe(false);
		const lookalike = seedTask({ repo: join(root, "jabbux") });
		expect(await daemon.repoMatches(lookalike, [join(root, "jabbu")])).toBe(false);
	});

	test("AC-6: a symlinked repos entry matches; a missing or non-git path never does", async () => {
		const worktree = seedTask({ repo: join(root, "jabbu-t-1") });
		expect(await daemon.repoMatches(worktree, [join(root, "jabbu-link")])).toBe(true);
		expect(await daemon.repoMatches(worktree, [join(root, "nowhere")])).toBe(false);
		expect(await daemon.repoMatches(seedTask({ repo: join(root, "nowhere") }), [join(root, "jabbu")])).toBe(false);
		expect(await daemon.repoMatches(seedTask({ repo: root }), [root])).toBe(false);
	});
});

describe("daemon autoLand", () => {
	test("AC-7: a core handoff (no worktree) puts an owner '머지해 …' into the task thread under the 🤖 자동 머지 marker", async () => {
		const row = seedTask();
		expect(await daemon.autoLand(row)).toMatchObject({ state: "handoff", reason: expect.stringContaining("worktree") });
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channelId: THREAD });
		const inbound = mergeInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
	});

	test("AC-7: a top-level or unparsable thread ref puts nothing in (not_accepted)", async () => {
		expect(await daemon.autoLand(seedTask({ threadRef: `${CHANNEL}:${TOP_LEVEL_TS}` }))).toEqual({
			state: "not_accepted",
		});
		expect(await daemon.autoLand(seedTask({ threadRef: "not-a-thread" }))).toEqual({ state: "not_accepted" });
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-7: a draining daemon puts nothing in (not_accepted)", async () => {
		const row = seedTask();
		daemon.setDraining(true);
		expect(await daemon.autoLand(row)).toEqual({ state: "not_accepted" });
		daemon.setDraining(false);
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
	});

	test("AC-7: a second call while the first lands answers in_flight and puts nothing in", async () => {
		const row = seedTask();
		const both = await Promise.all([daemon.autoLand(row), daemon.autoLand(row)]);
		expect(both.map((outcome) => outcome.state)).toEqual(["handoff", "in_flight"]);
		expect(markers()).toHaveLength(1);
		expect(mergeInbounds()).toHaveLength(1);
	});

	test("AC-7: a failed attempt (marker post throws) releases the lock: the next call goes in", async () => {
		const row = seedTask();
		transport.failNext.createMessage = [
			new DiscordCallError("definitive", "discord_http_404:10003 Unknown Channel", 404, 10003),
		];
		await expect(daemon.autoLand(row)).rejects.toThrow();
		expect(mergeInbounds()).toHaveLength(0);
		expect(await daemon.autoLand(row)).toMatchObject({ state: "handoff" });
		expect(mergeInbounds()).toHaveLength(1);
	});
});

describe("daemon autoLand: core landing seam (task-core-land)", () => {
	let gated: Daemon;
	let gatedTransport: WaitingDiscordTransport;
	let gatedHome: TestHome;
	let drivers: FakeOmpDriver[];
	let landCalls: TaskRow[];
	/** What the `taskLand` seam answers; `gate` (when set) holds it until resolved. */
	let answer: TaskLandResult;
	let gate: Promise<void> | undefined;
	let entered: PromiseWithResolvers<void>;

	beforeEach(async () => {
		gatedHome = makeHome("jabbu-coreland-");
		gatedTransport = threadTransport();
		drivers = [];
		landCalls = [];
		answer = { state: "handoff", reason: "재판정 문제: check AC-1 실패" };
		gate = undefined;
		entered = Promise.withResolvers<void>();
		const sessions = new FakeSessionStore();
		gated = new Daemon({
			...daemonTestOptions(),
			config: gatedHome.config,
			channels: [discordBinding(gatedTransport)],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			// Every turn stays running: a handed-off "머지해" turn is still going while the test calls again.
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.push(driver);
				return driver;
			},
			taskLand: async (row) => {
				landCalls.push(row);
				entered.resolve();
				if (gate !== undefined) await gate;
				return answer;
			},
		});
		await gated.start();
	});

	afterEach(async () => {
		for (const driver of drivers) driver.release();
		await gated.stop();
		gatedHome.remove();
	});

	function seed(host: string | null = null): TaskRow {
		const tasks = gated.store.tasks;
		const row = tasks.register({
			title: "로그 회전",
			risk: "L2",
			originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
			threadRef: `${CHANNEL}:${THREAD}`,
			host,
			repo: "/r/repo",
			acceptance: acceptanceItems(["하나", "둘"]),
		});
		tasks.transition(row.taskId, "review", "bot");
		return tasks.require(row.taskId);
	}

	const inbounds = () => gated.store.listInbound().filter((row) => row.textRef.trim().startsWith("머지해"));

	async function clickMerge(taskId: string): Promise<string> {
		const card = await gatedTransport.createMessage({ channelId: THREAD, content: "🔍 머지 대기 카드" });
		await click(gatedTransport, `jabbu:task:merge:${taskId}`, card.id);
		return card.id;
	}

	const editsOf = (ts: string): string[] =>
		gatedTransport.calls.flatMap((call) =>
			call.method === "editMessage" && call.messageId === ts ? [JSON.stringify(call.embeds ?? call.content)] : [],
		);

	test("AC-4: a remote host task never reaches landTask: only '머지해' goes in, as before", async () => {
		const row = seed("remote-host");
		expect(await gated.autoLand(row)).toMatchObject({ state: "handoff", reason: "원격 호스트(remote-host) TASK" });
		expect(landCalls).toHaveLength(0);
		expect(inbounds()).toHaveLength(1);
	});

	test("AC-6: auto-merge and a 머지 click on the same task run landTask once; the click's card says 이미 착지 중", async () => {
		const row = seed();
		const release = Promise.withResolvers<void>();
		gate = release.promise;
		answer = { state: "landed", baseBranch: "main", sha: "a".repeat(40), notes: [] };
		const auto = gated.autoLand(row);
		await entered.promise;
		const ts = await clickMerge(row.taskId);
		release.resolve();
		expect(await auto).toMatchObject({ state: "landed" });
		expect(landCalls).toHaveLength(1);
		const edits = editsOf(ts);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toContain("이미 착지 중");
		expect(inbounds()).toHaveLength(0);
	});

	test("AC-6: after a handoff, while the '머지해' turn runs, auto-merge and the button are in_flight: landTask ran once", async () => {
		const row = seed();
		expect(await gated.autoLand(row)).toMatchObject({ state: "handoff" });
		expect(inbounds()).toHaveLength(1);
		expect(await gated.autoLand(row)).toEqual({ state: "in_flight" });
		const ts = await clickMerge(row.taskId);
		expect(editsOf(ts)).toEqual([expect.stringContaining("이미 착지 중")]);
		expect(landCalls).toHaveLength(1);
		expect(inbounds()).toHaveLength(1);
	});

	test("AC-6: a 머지 click lands through the core: one card edit per stage, the result line last, no '머지해'", async () => {
		const row = seed();
		answer = { state: "merged-not-pushed", baseBranch: "main", sha: "b".repeat(40), reason: "rejected", notes: [] };
		const ts = await clickMerge(row.taskId);
		const edits = editsOf(ts);
		expect(edits).toHaveLength(2);
		expect(edits[0]).toContain("코어 착지 중");
		expect(edits[1]).toContain("push 거부: rejected");
		expect(landCalls).toHaveLength(1);
		expect(inbounds()).toHaveLength(0);
	});
});

describe("autoLandBlockers: re-run checks", () => {
	/** The judgement fields `autoLandBlockers` reads, with clean evidence: only the checks can hold the merge. */
	const judgementWith = (checks: TaskCheck[]): TaskJudgement =>
		({ checks, integrityWarnings: [], evidence: {}, steps: [] }) as Partial<TaskJudgement> as TaskJudgement;
	const policy = { repos: ["/r/repo"], maxRisk: "L2" as const };
	const pass: TaskCheck = { id: "AC-1", signal: 'command ["true"]', ok: true, detail: "exit 0" };
	const fail: TaskCheck = { id: "AC-2", signal: 'command ["false"]', ok: false, detail: "exit 1" };
	const timedOut: TaskCheck = {
		id: "AC-3",
		signal: 'command ["bun","test"]',
		ok: false,
		detail: "900초 안에 끝나지 않았습니다(확인 불가)",
		inconclusive: true,
	};

	test("failed and inconclusive checks are named apart, and either one holds the merge", () => {
		const row = seedTask();
		expect(autoLandBlockers(row, judgementWith([pass]), policy, true)).toEqual([]);
		expect(autoLandBlockers(row, judgementWith([]), policy, true)).toEqual(["재실행 검사 없음"]);
		expect(autoLandBlockers(row, judgementWith([pass, fail]), policy, true)).toEqual(["재실행 검사 실패 1/2"]);
		expect(autoLandBlockers(row, judgementWith([pass, timedOut]), policy, true)).toEqual(["재실행 검사 확인 불가 1/2"]);
		expect(autoLandBlockers(row, judgementWith([pass, fail, timedOut]), policy, true)).toEqual([
			"재실행 검사 실패 1/3",
			"재실행 검사 확인 불가 1/3",
		]);
	});

	test("an unproven claim word alone holds an L3 task but not an L0–L2 one; other warnings hold every risk", () => {
		const claim = "무결성 unproven_claim_word: summary: 테스트가 모두 통과했습니다";
		const guard = "무결성 guard_deletion: test/x.test.ts";
		const warned = (warnings: string[]): TaskJudgement => ({ ...judgementWith([pass]), integrityWarnings: warnings });
		const row = seedTask();
		expect(row.risk).toBe("L2");
		expect(autoLandBlockers({ ...row, risk: "L3" }, warned([claim]), { ...policy, maxRisk: "L3" }, true)).toEqual([
			"무결성 경고 1건",
		]);
		for (const risk of ["L0", "L1", "L2"] as const) {
			const low = { ...row, risk };
			expect(autoLandBlockers(low, warned([claim]), policy, true)).toEqual([]);
			expect(autoLandBlockers(low, warned([claim, guard]), policy, true)).toEqual(["무결성 경고 1건"]);
		}
		expect(holdingIntegrityWarnings("L2", [claim, guard])).toEqual([guard]);
		expect(holdingIntegrityWarnings("L3", [claim])).toEqual([claim]);
	});
});

describe("[TASK] review·QA gate (task-review-qa-gate)", () => {
	const QA_MODEL = "zai/test-qa:high";
	const CLEAR90 = "스펙 충족\nCONFIDENCE: 0.90\nVERDICT: CLEAR";
	const PASS = `실행함\n${JSON.stringify({ verdict: "PASS", findings: ["bun test 통과"] })}`;
	const FAIL = `실행함\n${JSON.stringify({ verdict: "FAIL", findings: ["AC-1 실패"] })}`;
	let root: string;
	let repo: string;
	let gh: TestHome;
	let gd: Daemon;
	let gt: WaitingDiscordTransport;
	let order: string[];
	/** What the fake omp answers per kind; `hold` (when set) keeps a QA running until released or aborted. */
	let answers: { review: RunProcessResult; qa: RunProcessResult };
	let hold: Promise<void> | undefined;
	let qaEntered: PromiseWithResolvers<void>;
	const g = (dir: string, ...args: string[]): string =>
		execFileSync("git", ["-C", dir, ...args], { env: dispatchEnv(process.env), encoding: "utf8" }).trim();
	const ok = (stdout: string): RunProcessResult => ({ code: 0, stdout, timedOut: false });
	const clean = (checks: TaskCheck[]): TaskJudgement =>
		({
			checks,
			problems: [],
			integrityWarnings: [],
			evidence: {},
			steps: [],
			summary: ["요약"],
		}) as Partial<TaskJudgement> as TaskJudgement;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "jabbu-gate-"));
		repo = join(root, "repo");
		execFileSync("git", ["init", "-q", "-b", "main", repo], { env: dispatchEnv(process.env) });
		g(repo, "config", "user.name", "t");
		g(repo, "config", "user.email", "t@example.test");
		g(repo, "config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "README.md"), "readme\n");
		g(repo, "add", "README.md");
		g(repo, "commit", "-q", "-m", "init");
		const overlay = join(root, "qa.omp.yml");
		writeFileSync(overlay, "{}\n");
		order = [];
		answers = { review: ok(CLEAR90), qa: ok(PASS) };
		hold = undefined;
		qaEntered = Promise.withResolvers<void>();
		gh = makeHome("jabbu-gate-home-");
		gt = threadTransport();
		const run: ProcessRunner = async (cmd, opts) => {
			const isQa = cmd[cmd.indexOf("--model") + 1] === QA_MODEL;
			order.push(isQa ? "qa" : "review");
			if (!isQa) return answers.review;
			qaEntered.resolve();
			if (hold !== undefined) {
				const aborted = Promise.withResolvers<void>();
				opts.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await Promise.race([hold, aborted.promise]);
				if (opts.signal?.aborted === true) return { code: null, stdout: "", timedOut: false };
			}
			return answers.qa;
		};
		gd = new Daemon({
			...daemonTestOptions(),
			config: {
				...gh.config,
				taskAutoLand: {
					repos: [repo],
					review: { model: "rev/model", confident: { maxRisk: "L3", minConfidence: 0.8 } },
					qa: { overlay, model: QA_MODEL },
				},
			},
			channels: [discordBinding(gt)],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: new FakeSessionStore() }),
			laneReviewRun: run,
			taskLand: (row, deps) => {
				order.push("land");
				return landTask(row, { ...deps, judge: async () => ({ ok: true, judgement: clean([]) }) });
			},
		});
		await gd.start();
	});

	afterEach(async () => {
		await gd.stop();
		gh.remove();
		rmSync(root, { recursive: true, force: true });
	});

	/** A reached local task at `risk` with one commit on its branch, in review. */
	function seedGated(risk: "L2" | "L3"): TaskRow {
		const tasks = gd.store.tasks;
		const row = tasks.register({
			title: "게이트",
			risk,
			originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
			threadRef: `${CHANNEL}:${THREAD}`,
			host: null,
			repo,
			acceptance: acceptanceItems(["하나"]),
		});
		g(repo, "worktree", "add", "-q", "-b", row.branch, row.worktree, "main");
		writeFileSync(join(row.worktree, "a.txt"), "a\n");
		g(row.worktree, "add", "a.txt");
		g(row.worktree, "commit", "-q", "-m", "feat: a");
		tasks.transition(row.taskId, "review", "bot");
		return tasks.require(row.taskId);
	}

	/** Gate hooks that resolve `ended` with the gate's end and count its calls. */
	function hooks() {
		const ended = Promise.withResolvers<TaskGateEnd>();
		let calls = 0;
		const gate: TaskGateHooks = {
			judgement: clean([{ id: "AC-1", signal: 'command ["true"]', ok: true, detail: "exit 0" }]),
			gating: async () => undefined,
			ended: async (end) => {
				calls += 1;
				ended.resolve(end);
			},
		};
		return { gate, ended: ended.promise, calls: () => calls };
	}

	test("AC-1: L3: review CLEAR 0.9 → QA PASS → landTask, in that order; done by core-land with no button", async () => {
		const row = seedGated("L3");
		const h = hooks();
		expect(await gd.autoLand(row, h.gate)).toEqual({ state: "gating" });
		const end = await h.ended;
		expect(order).toEqual(["review", "qa", "land"]);
		expect(end).toMatchObject({ blockers: [], landed: { state: "landed" } });
		expect(gd.store.tasks.require(row.taskId).status).toBe("done");
		expect(gd.store.tasks.history(row.taskId).at(-1)).toMatchObject({ toStatus: "done", actor: "core-land" });
		expect(end.gate).toMatchObject({ review: { verdict: "CLEAR", confidence: 0.9 }, qa: { verdict: "PASS" } });
	});

	test.each([
		["review BLOCK", { review: ok("src/a.ts:1 빠짐\nVERDICT: BLOCK") }, ["review"], "독립 리뷰 BLOCK"],
		[
			"confidence 0.7",
			{ review: ok("CONFIDENCE: 0.70\nVERDICT: CLEAR") },
			["review"],
			"독립 리뷰 CLEAR(확신도 0.70 < 0.80, 위험 L3)",
		],
		["QA FAIL", { qa: ok(FAIL) }, ["review", "qa"], "실행 QA FAIL"],
		[
			"QA timeout",
			{ qa: { code: null, stdout: "", timedOut: true } },
			["review", "qa"],
			"실행 QA 확인 불가(시간 초과)",
		],
	] as const)(
		"AC-2 %s: no merge, one end with that reason; the held card names it once",
		async (_n, over, ran, reason) => {
			answers = { ...answers, ...over };
			const row = seedGated("L3");
			const h = hooks();
			await gd.autoLand(row, h.gate);
			const end = await h.ended;
			expect(order).toEqual([...ran]);
			expect(end.blockers).toEqual([reason]);
			expect(end.landed).toBeUndefined();
			expect(h.calls()).toBe(1);
			expect(gd.store.tasks.require(row.taskId).status).toBe("review");
			const card = buildReachedCard(row, h.gate.judgement, OWNER, undefined, {
				kind: "skipped",
				reasons: end.blockers,
				gate: end.gate,
			});
			expect(card.text.split("\n").filter((line) => line.startsWith("자동 머지 안 함"))).toEqual([
				`자동 머지 안 함: ${reason}`,
			]);
		},
	);

	test("AC-3: a receipt for the same tip is never run again; starts used up give one exhausted reason, then none", async () => {
		answers = { ...answers, review: ok("VERDICT: BLOCK") };
		const row = seedGated("L3");
		const h = hooks();
		await gd.autoLand(row, h.gate);
		await h.ended;
		const tasks = gd.store.tasks;
		expect(await gd.autoLand(tasks.require(row.taskId), hooks().gate)).toEqual({
			state: "held",
			reasons: ["독립 리뷰 BLOCK"],
		});
		expect(order).toEqual(["review"]);
		// A new tip whose review was started twice without a receipt (cut off by restarts).
		g(row.worktree, "commit", "-q", "--allow-empty", "-m", "rework");
		const sha = g(repo, "rev-parse", row.branch);
		const rt = gateRuntimeKey(
			receiptNowOf({
				repos: [repo],
				maxRisk: "L2",
				review: { model: "rev/model", timeoutMs: 1 },
				qa: { minRisk: "L3", overlay: join(root, "qa.omp.yml"), model: QA_MODEL, timeoutMs: 1 },
			}),
		);
		tasks.recordNotice(row.taskId, `gate:${sha}:${rt}:review:1`);
		tasks.recordNotice(row.taskId, `gate:${sha}:${rt}:review:2`);
		expect(await gd.autoLand(tasks.require(row.taskId), hooks().gate)).toEqual({
			state: "held",
			reasons: ["독립 리뷰 확인 불가(재시도 2회 소진)"],
		});
		expect(await gd.autoLand(tasks.require(row.taskId), hooks().gate)).toEqual({ state: "held", reasons: [] });
		expect(order).toEqual(["review"]);
		// The same tip on another omp major.minor: the used-up starts were another runtime's, the gate starts again.
		try {
			await bootRuntime({ omp: "omp 99.0.0", sourceDir: repo });
			const again = hooks();
			expect(await gd.autoLand(tasks.require(row.taskId), again.gate)).toEqual({ state: "gating" });
			await again.ended;
			expect(order).toEqual(["review", "review"]);
			expect(gd.store.tasks.require(row.taskId).gate?.review?.runtime?.omp).toBe("omp 99.0.0");
		} finally {
			await bootRuntime({
				omp: "unknown",
				sourceDir: "/nonexistent",
				git: async () => ({ code: 1, stdout: "", stderr: "" }),
			});
		}
	});

	test("AC-4: an L2 task lands without review or QA; L4 keeps its risk reason only, L3 needs the receipts", async () => {
		const row = seedGated("L2");
		expect(await gd.autoLand(row, hooks().gate)).toMatchObject({ state: "landed" });
		expect(order).toEqual(["land"]);
		const policy = {
			repos: [repo],
			maxRisk: "L2" as const,
			review: { model: "m", timeoutMs: 1, confident: { maxRisk: "L3" as const, minConfidence: 0.8 } },
			qa: { minRisk: "L3" as const, overlay: "/o", model: QA_MODEL, timeoutMs: 1 },
		};
		const judged = clean([{ id: "AC-1", signal: 'command ["true"]', ok: true, detail: "exit 0" }]);
		expect(autoLandBlockers({ ...row, risk: "L4" }, judged, policy, true)).toEqual(["위험 L4 > L2"]);
		expect(autoLandBlockers({ ...row, risk: "L2" }, judged, policy, true)).toEqual([]);
		expect(autoLandBlockers({ ...row, risk: "L3" }, judged, policy, true)).toEqual(["독립 리뷰 없음", "실행 QA 없음"]);
	});

	test("AC-7: 머지 during the QA aborts the gate and waits; landTask once, no QA receipt, no second landing", async () => {
		const release = Promise.withResolvers<void>();
		hold = release.promise;
		const row = seedGated("L3");
		const h = hooks();
		await gd.autoLand(row, h.gate);
		await qaEntered.promise;
		const card = await gt.createMessage({ channelId: THREAD, content: "🔍 머지 대기 카드" });
		await click(gt, `jabbu:task:merge:${row.taskId}`, card.id);
		release.resolve();
		expect(order).toEqual(["review", "qa", "land"]);
		const after = gd.store.tasks.require(row.taskId);
		expect(after.status).toBe("done");
		expect(after.gate?.qa).toBeUndefined();
		expect(h.calls()).toBe(0);
	});

	test("AC-9: a gate whose task leaves review mid-run ends stopped: no land, no QA receipt, the end is reported", async () => {
		const release = Promise.withResolvers<void>();
		hold = release.promise;
		const row = seedGated("L3");
		const h = hooks();
		await gd.autoLand(row, h.gate);
		await qaEntered.promise;
		gd.store.tasks.transition(row.taskId, "working", "bot", "resume dispatch");
		release.resolve();
		const end = await h.ended;
		expect(order).toEqual(["review", "qa"]);
		expect(end).toMatchObject({ blockers: [GATE_STALE_REASON] });
		expect(end.landed).toBeUndefined();
		expect(h.calls()).toBe(1);
		const after = gd.store.tasks.require(row.taskId);
		expect(after.status).toBe("working");
		expect(after.gate?.qa).toBeUndefined();
	});

	test("AC-8: stop() aborts a running TASK gate and waits for it; nothing recorded, no copy left", async () => {
		hold = new Promise<void>(() => {});
		const row = seedGated("L3");
		const h = hooks();
		await gd.autoLand(row, h.gate);
		await qaEntered.promise;
		await gd.stop();
		expect(order).toEqual(["review", "qa"]);
		expect(h.calls()).toBe(0);
		const copies = join(gh.config.homeDir, "qa-worktrees");
		expect(existsSync(copies) ? readdirSync(copies) : []).toEqual([]);
	});
});

describe("shared gate slot (AC-8)", () => {
	test("a lane QA holding the slot keeps a TASK QA waiting until it frees it: one at a time", async () => {
		const slot = createGateSlot();
		const laneFree = await slot();
		let taskRan = false;
		const task = slot().then((free) => {
			taskRan = true;
			free();
		});
		await Promise.resolve();
		expect(taskRan).toBe(false);
		laneFree();
		await task;
		expect(taskRan).toBe(true);
	});
});

describe("tasks.gate_json migration (AC-6)", () => {
	test("an old ledger keeps its rows; the migration runs twice without error; recordGate merges receipts", () => {
		const db = new Database(":memory:");
		new TaskLedger(db, { clock, timezone: "Asia/Seoul" }).register({
			title: "옛 행",
			risk: "L2",
			originKey: "o",
			threadRef: "C1:1.2",
			host: null,
			repo: "/r",
			acceptance: [],
		});
		db.run("ALTER TABLE tasks DROP COLUMN gate_json");
		const before = db.query("SELECT * FROM tasks").all();
		migrateTaskSchema(db);
		migrateTaskSchema(db);
		const after = db.query("SELECT * FROM tasks").all() as Array<Record<string, unknown>>;
		expect(after.map(({ gate_json: _gate, ...rest }) => rest)).toEqual(before as Array<Record<string, unknown>>);
		expect(after[0]?.gate_json).toBeNull();
		const ledger = new TaskLedger(db, { clock, timezone: "Asia/Seoul" });
		const id = String(after[0]?.task_id);
		const review = { sha: "a", verdict: "CLEAR" as const, model: "m", at: 1, notes: "" };
		ledger.recordGate(id, { review });
		const qa = { sha: "a", verdict: "PASS" as const, findings: [], model: "q", at: 2 };
		expect(ledger.recordGate(id, { qa }).gate).toEqual({ review, qa });
	});
});

describe("원격 pr 자동 머지 게이트 — autoLandBlockers(AC-11a·11f)", () => {
	const judgementWith = (): TaskJudgement =>
		({
			checks: [{ id: "AC-1", signal: 'command ["true"]', ok: true, detail: "exit 0" }],
			integrityWarnings: [],
			evidence: {},
			steps: [],
		}) as Partial<TaskJudgement> as TaskJudgement;
	const policy = { repos: ["/r/repo"], maxRisk: "L2" as const };
	const remote = (): TaskRow => ({ ...seedTask(), host: "wsl" });

	test("원격 ff·remotes 없음: remoteViaPr가 아니면 '원격 호스트' 사유이고 저장소 사유는 따로 나오지 않는다", () => {
		const row = remote();
		expect(autoLandBlockers(row, judgementWith(), policy, true)).toEqual(["원격 호스트(wsl) TASK"]);
		expect(autoLandBlockers(row, judgementWith(), policy, false)).toEqual(["원격 호스트(wsl) TASK"]);
		expect(autoLandBlockers(row, judgementWith(), policy, true, false)).toEqual(["원격 호스트(wsl) TASK"]);
	});

	test("원격 pr: taskAutoLand.repos 밖이면 '저장소가 taskAutoLand.repos 밖' 사유만 나온다", () => {
		expect(autoLandBlockers(remote(), judgementWith(), policy, false, true)).toEqual([
			"저장소가 taskAutoLand.repos 밖",
		]);
	});

	test("원격 pr: repos 안의 비밴드 TASK는 두 사유 모두 없다", () => {
		const blockers = autoLandBlockers(remote(), judgementWith(), policy, true, true);
		expect(blockers).toEqual([]);
		expect(blockers.join()).not.toContain("원격 호스트");
		expect(blockers.join()).not.toContain("taskAutoLand.repos");
	});

	test("원격 pr: 로컬 TASK는 remoteViaPr와 무관하게 저장소 사유만 본다(대조)", () => {
		expect(autoLandBlockers(seedTask(), judgementWith(), policy, false, true)).toEqual([
			"저장소가 taskAutoLand.repos 밖",
		]);
		expect(autoLandBlockers(seedTask(), judgementWith(), policy, true, false)).toEqual([]);
	});
});

describe("원격 pr 직접 autoLand·오너 머지 버튼(AC-11f)", () => {
	const QA_OVERLAY = "/nonexistent/qa.omp.yml";
	let rh: TestHome;
	let rd: Daemon;
	let rt: WaitingDiscordTransport;
	let landCalls: TaskRow[];
	let ghCalls: string[][];
	let gitCalls: string[][];
	let gateCalls: string[];

	beforeEach(async () => {
		rh = makeHome("jabbu-remote-pr-autoland-");
		rt = threadTransport();
		landCalls = [];
		ghCalls = [];
		gitCalls = [];
		gateCalls = [];
		rd = new Daemon({
			...daemonTestOptions(),
			config: {
				...rh.config,
				dispatchHosts: { wsl: { ssh: "wsl-ssh", workDir: "/w" } },
				lanes: { land: { "/r/local": { mode: "pr", remotes: { wsl: "/r/repo" } } } },
				taskAutoLand: {
					repos: ["/r/local"],
					review: { model: "rev/model", confident: { maxRisk: "L3", minConfidence: 0.8 } },
					qa: { overlay: QA_OVERLAY, model: "zai/test-qa:high" },
				},
			},
			channels: [discordBinding(rt)],
			log: createLogger({ sink: () => {}, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: new FakeSessionStore() }),
			taskLand: async (row) => {
				landCalls.push(row);
				return { state: "pr-open", url: "https://github.com/acme/widgets/pull/7" };
			},
			prLand: {
				tools: {
					git: async (argv) => {
						gitCalls.push(argv);
						return { code: 1, stdout: "", stderr: "forbidden" };
					},
					gh: async (argv) => {
						ghCalls.push(argv);
						return { code: 1, stdout: "", stderr: "forbidden" };
					},
				},
			},
		});
		await rd.start();
	});

	afterEach(async () => {
		await rd.stop();
		rh.remove();
	});

	function seedRemote(risk: "L2" | "L3"): TaskRow {
		const tasks = rd.store.tasks;
		const row = tasks.register({
			title: "원격 로그 회전",
			risk,
			originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
			threadRef: `${CHANNEL}:${THREAD}`,
			host: "wsl",
			repo: "/r/repo",
			acceptance: acceptanceItems(["하나"]),
		});
		tasks.transition(row.taskId, "review", "bot");
		return tasks.require(row.taskId);
	}

	const gateHooks = (): TaskGateHooks => ({
		judgement: {
			checks: [],
			problems: [],
			integrityWarnings: [],
			evidence: {},
			steps: [],
		} as Partial<TaskJudgement> as TaskJudgement,
		gating: async () => {
			gateCalls.push("gating");
			return undefined;
		},
		ended: async () => {
			gateCalls.push("ended");
		},
	});

	const expectUntouched = (row: TaskRow) => {
		expect(landCalls).toHaveLength(0);
		expect(ghCalls).toHaveLength(0);
		expect(gitCalls).toHaveLength(0);
		expect(gateCalls).toHaveLength(0);
		expect(rd.store.tasks.require(row.taskId).status).toBe("review");
		expect(rd.store.listInbound().filter((entry) => entry.textRef.trim().startsWith("머지해"))).toHaveLength(0);
	};

	test("원격 pr 밴드(L3): 게이트 훅이 있어도 게이트·landTask·gh 0회로 held", async () => {
		const row = seedRemote("L3");
		const outcome = await rd.autoLand(row, gateHooks());
		expect(outcome).toMatchObject({
			state: "held",
			reasons: [expect.stringContaining("원격 TASK는 독립 리뷰·QA 게이트를 받을 수 없음(위험 L3)")],
		});
		expectUntouched(row);
	});

	test("원격 pr 밴드(L3): 게이트 훅이 없어도 같다 — landTask·gh 0회로 held", async () => {
		const row = seedRemote("L3");
		const outcome = await rd.autoLand(row);
		expect(outcome).toMatchObject({ state: "held" });
		expectUntouched(row);
	});

	test("원격 pr 비밴드(L2): 직접 autoLand는 held가 아니라 코어 착지(landTask seam)로 가고 '머지해'는 없다", async () => {
		const row = seedRemote("L2");
		expect(await rd.autoLand(row)).toMatchObject({ state: "pr-open" });
		expect(landCalls.map((call) => [call.taskId, call.host])).toEqual([[row.taskId, "wsl"]]);
		expect(rd.store.listInbound().filter((entry) => entry.textRef.trim().startsWith("머지해"))).toHaveLength(0);
	});

	test("원격 pr: 오너의 머지 버튼은 밴드 위험(L3)이어도 코어 착지로 간다 — landTask 1회, '머지해' 없음", async () => {
		const row = seedRemote("L3");
		const card = await rt.createMessage({ channelId: THREAD, content: "🔍 머지 대기 카드" });
		await click(rt, `jabbu:task:merge:${row.taskId}`, card.id);
		expect(landCalls.map((call) => call.taskId)).toEqual([row.taskId]);
		expect(landCalls[0]?.host).toBe("wsl");
		expect(rd.store.listInbound().filter((entry) => entry.textRef.trim().startsWith("머지해"))).toHaveLength(0);
		expect(ghCalls).toHaveLength(0);
	});
});
