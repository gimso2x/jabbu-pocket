import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonQuotaGate } from "../src/daemon/daemon-quota";
import { DiscordChannel } from "../src/discord/channel";
import type { ProcessRunner } from "../src/dispatch/omp";
import { secretsCwdProblem } from "../src/dispatch/secrets-cwd";
import { LaneManager } from "../src/lanes/manager";
import { LaneInputError } from "../src/lanes/manager-constants";
import { buildWorkStartTool } from "../src/lanes/tools";
import { parseLaneTrigger } from "../src/lanes/trigger";
import { laneTriggerRefusal, normalizeLaneTitle } from "../src/lanes/trigger-format";
import { defaultGit } from "../src/lanes/verify";
import { parseLaneAcceptance, resolveLaneRepo } from "../src/lanes/worktree";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { redact } from "../src/redact";
import type { TaskJudgement } from "../src/tasks/checker";
import { resumeTask, type TaskDispatchDeps } from "../src/tasks/dispatch";
import { acceptanceItems } from "../src/tasks/docs";
import { TaskLedger } from "../src/tasks/ledger";
import { releaseHold } from "../src/tasks/runtime";
import { testRegexBounded } from "../src/tasks/signal-eval";
import { parseChecks, runSignal, type SignalIo, SignalSyntaxError } from "../src/tasks/signals";
import { TaskSweeper } from "../src/tasks/sweeper";
import { CHANNEL, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { ROOMY_STATFS } from "./helpers/disk";
import { git, makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const FAKE_TOKEN = ["xoxb", "TEST", "1234567890"].join("-");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function reachedJudgement(): TaskJudgement {
	return {
		reached: true,
		acChecked: 2,
		acTotal: 2,
		stepsDone: 2,
		stepsTotal: 2,
		status: "working",
		updatedAt: "2026-11-27T12:00:00+09:00",
		updatedAtMs: 1_795_000_000_000,
		specChanged: false,
		specKey: "s1",
		blocked: false,
		needsOwner: false,
		blockedReason: "",
		decision: { question: "", recommend: "", impact: "", fallbackOk: false },
		current: "done",
		restated: "",
		evidence: { "AC-1": ["commit abcdef1"], "AC-2": ["test ok → pass"] },
		summary: ["완료"],
		checks: [],
		integrityWarnings: [],
		reachKey: "r1",
		acceptance: [],
		steps: [],
		problems: [],
	};
}

describe("qa-ad lanes·tasks·dispatch 수정", () => {
	test("#28/#58: 모델 생략 시 config.model 기본 프로바이더를 쿼터 게이트로 확인한다", async () => {
		const home: TestHome = makeHome("jabbu-qa28-");
		const repo = makeRepo([]);
		cleanups.push(() => {
			removeRepoAndWorktrees(repo);
			home.remove();
		});
		const now = 1_795_500_000_000;
		const resetAt = now + 3_600_000;
		let config: JabbuConfig = {
			...home.config,
			agent: "omp",
			model: "anthropic/claude-opus-5-5",
			quotaGate: { holdPct: 95, pollMinutes: 5 },
		};
		const log = createLogger({ sink: () => undefined, clock: { now: () => now }, redact });
		const ctx = {
			get options() {
				return { config } as unknown as DaemonContext["options"];
			},
			clock: { now: () => now },
			log,
		} as unknown as DaemonContext;
		const runner: ProcessRunner = async () => ({
			code: 0,
			timedOut: false,
			stdout: JSON.stringify({
				reports: [
					{
						provider: "anthropic",
						limits: [
							{
								label: "5h",
								amount: { unit: "percent", usedFraction: 0.97 },
								window: { id: "5h", label: "5h", resetsAt: resetAt },
							},
						],
					},
				],
			}),
		});
		const gate = new DaemonQuotaGate(ctx, runner);
		await gate.pollNow();
		expect(gate.refusalFor(undefined)).toContain("프로바이더 쿼터 보류(anthropic:");

		config = { ...config, model: "zai/glm-5.4" };
		expect(gate.refusalFor(undefined)).toBeUndefined();

		config = { ...config, model: "anthropic/claude-opus-5-5" };
		const clock = { now: () => now };
		const store = openBotStore(join(home.dir, "jabbu.db"), clock, "Asia/Seoul");
		const sessionsRoot = join(home.dir, "sessions");
		const sessions = new FakeSessionStore();
		const transport = new WaitingDiscordTransport();
		const router = new OriginRouter({
			timezone: "Asia/Seoul",
			store,
			clock,
			log,
			sessionsRoot,
			statusProvider: () => "",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true }),
		});
		const manager = new LaneManager({
			timezone: "Asia/Seoul",
			store,
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			clock,
			log,
			sessionsRoot,
			hostLoad: IDLE_HOST_LOAD,
			statfs: ROOMY_STATFS,
			route: (record) => router.route(record),
			stopWhenIdle: (origin) => router.mailbox(origin).stopWhenIdle(),
			pauseTurn: (origin) => router.mailbox(origin).pauseTurn(),
			resumePending: (origin) => router.mailbox(origin).resumePending(),
			sessionDirFor: (origin) => sessionDirFor(sessionsRoot, origin, 1),
			session: router.sessionOps(),
			quotaRefusal: (model) => gate.refusalFor(model),
		});
		cleanups.push(async () => {
			await router.close();
			store.close();
		});

		const err = await manager
			.start({ title: "기본 모델 보류", cwd: repo, channel: CHANNEL, risk: "L1" })
			.catch((cause: unknown) => cause);
		expect(err).toBeInstanceOf(LaneInputError);
		expect(String((err as Error).message)).toContain("프로바이더 쿼터 보류(anthropic:");
	});

	test("#29: CRLF(\\r\\n) 포함 작업 트리거와 거절 검사가 브리프·상대경로를 올바르게 처리한다", () => {
		const parsed = parseLaneTrigger("작업: 제목 @/tmp/proj\r\n첫 줄\r\n둘째 줄");
		expect(parsed).toEqual({
			title: "제목",
			cwd: "/tmp/proj",
			brief: "첫 줄\n둘째 줄",
		});
		expect(laneTriggerRefusal("작업: 제목 @~/bad\r\n설명")).toContain("형식은 `작업: <제목> @<절대경로>`");
	});

	test("#30: TaskSweeper 동시 check 호출이 직렬화되어 Outcome 카드를 1회만 게시한다", async () => {
		const now = 1_795_500_000_000;
		const db = new Database(":memory:", { strict: true });
		const ledger = new TaskLedger(db, { clock: { now: () => now }, timezone: "Asia/Seoul" });
		cleanups.push(() => db.close());
		const row = ledger.register({
			title: "동시 체크",
			risk: "L2",
			originKey: `discord/ch/${CHANNEL}/t/1001`,
			threadRef: `${CHANNEL}:1001`,
			host: null,
			repo: "/r/repo",
			acceptance: acceptanceItems(["하나", "둘"]),
		});

		const transport = new FakeDiscordTransport();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let evaluateCalls = 0;

		const sweeper = new TaskSweeper({
			ledger,
			evaluate: async () => {
				evaluateCalls += 1;
				entered.resolve();
				await release.promise;
				return { ok: true, judgement: reachedJudgement() };
			},
			remind: async () => ({ ok: true }),
			agentStatus: async () => ({ ok: true, status: "idle" }),
			readAgent: async () => ({ ok: true, output: "" }),
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			ownerUserId: OWNER,
			now: () => now,
			log: { info: () => undefined, warn: () => undefined },
		});

		const first = sweeper.check(row);
		await entered.promise;
		const second = sweeper.check(row);
		release.resolve();
		const [res1, res2] = await Promise.all([first, second]);

		expect(res1.status).toBe("review");
		expect(res2.status).toBe("review");
		expect(evaluateCalls).toBe(1);
		const created = transport.calls.filter((call) => call.method === "createMessage");
		expect(created).toHaveLength(1);
	});

	test("#57: secretsCwdProblem이 NUL·심링크 루프·접근 불가 경로를 모두 한국어로 거절한다", () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa57-"));
		const locked = join(root, "locked");
		cleanups.push(() => {
			try {
				chmodSync(locked, 0o700);
			} catch {
				// ignore
			}
			rmSync(root, { recursive: true, force: true });
		});

		expect(secretsCwdProblem("/tmp/bad\0dir", false, root)).toContain("NUL");
		expect(secretsCwdProblem("/tmp/ok", false, `${root}\0bad`)).toContain("NUL");

		const loopA = join(root, "loop-a");
		const loopB = join(root, "loop-b");
		symlinkSync(loopB, loopA);
		symlinkSync(loopA, loopB);
		const loopMsg = secretsCwdProblem(loopA, false, root);
		expect(loopMsg).toContain("확인할 수 없습니다");
		expect(loopMsg).toContain("ELOOP");

		if (process.getuid?.() !== 0) {
			mkdirSync(locked, { mode: 0o700 });
			chmodSync(locked, 0o000);
			const denied = secretsCwdProblem(join(locked, "child"), false, root);
			expect(denied).toContain("확인할 수 없습니다");
			expect(denied).toContain("EACCES");
		}
	});

	test("#59: MAX_TITLE_CHARS 이상 긴 제목이 reuseOpen에서 titleHash로 구별된다", async () => {
		const prefix = "a".repeat(120);
		const nA = normalizeLaneTitle(`${prefix}-A`);
		const nB = normalizeLaneTitle(`${prefix}-B`);
		expect(nA.title).toBe(nB.title);
		expect(nA.titleHash).toBeDefined();
		expect(nB.titleHash).toBeDefined();
		expect(nA.titleHash).not.toBe(nB.titleHash);

		const home = makeHome("jabbu-qa59-");
		const repo = makeRepo([]);
		const h = laneHarness(home.dir);
		cleanups.push(async () => {
			await h.manager.stop();
			h.close();
			removeRepoAndWorktrees(repo);
			home.remove();
		});

		const first = await h.manager.start({
			title: `${prefix}-A`,
			cwd: repo,
			channel: CHANNEL,
			risk: "L1",
			parentOrigin: `discord/ch/${CHANNEL}`,
			reuseOpen: true,
		});
		const second = await h.manager.start({
			title: `${prefix}-B`,
			cwd: repo,
			channel: CHANNEL,
			risk: "L1",
			parentOrigin: `discord/ch/${CHANNEL}`,
			reuseOpen: true,
		});
		const reused = await h.manager.start({
			title: `${prefix}-A`,
			cwd: repo,
			channel: CHANNEL,
			risk: "L1",
			parentOrigin: `discord/ch/${CHANNEL}`,
			reuseOpen: true,
		});

		expect(first.reused).not.toBe(true);
		expect(second.reused).not.toBe(true);
		expect(second.name).not.toBe(first.name);
		expect(reused.reused).toBe(true);
		expect(reused.name).toBe(first.name);
	});

	test("#60: jabbu_work_start force 파라미터 설명에 프로바이더 쿼터 보류가 포함된다", () => {
		const home = makeHome("jabbu-qa60-");
		const h = laneHarness(home.dir);
		cleanups.push(async () => {
			await h.manager.stop();
			h.close();
			home.remove();
		});
		const tool = buildWorkStartTool(h.manager, CHANNEL, `discord/ch/${CHANNEL}`);
		const forceDesc = (tool.parameters as { properties: { force: { description: string } } }).properties.force
			.description;
		expect(forceDesc).toContain("프로바이더 쿼터 보류");
	});

	test("#61: 이름에 '..'이 들어간 저장소 경로도 작업 레인이 허용한다", async () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa61-"));
		const repoDir = join(root, "proj..v1");
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(repoDir);
		git(repoDir, "init", "-q", "-b", "main");
		writeFileSync(join(repoDir, "README.md"), "ok\n");
		git(repoDir, "add", "--", "README.md");
		git(repoDir, "commit", "-q", "-m", "init");

		const checked = await resolveLaneRepo(repoDir, defaultGit);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(checked.value.repo).toBe(realpathSync(repoDir));

		expect(parseLaneTrigger(`작업: 점두개 @${repoDir} 브리프`)?.cwd).toBe(repoDir);
	});

	test("#62: 체크 없는 레인도 HEAD가 아닌 조상 커밋으로 완료를 주장하면 거부된다", async () => {
		const home = makeHome("jabbu-qa62-");
		const repo = makeRepo([]);
		const h = laneHarness(home.dir);
		cleanups.push(async () => {
			await h.manager.stop();
			h.close();
			removeRepoAndWorktrees(repo);
			home.remove();
		});

		const lane = await h.manager.start({
			title: "조상 커밋 거부",
			cwd: repo,
			channel: CHANNEL,
			risk: "L1",
		});
		writeFileSync(join(lane.cwd, "a.txt"), "one\n");
		git(lane.cwd, "add", "--", "a.txt");
		git(lane.cwd, "commit", "-q", "-m", "commit A");
		const shaA = git(lane.cwd, "rev-parse", "HEAD");

		writeFileSync(join(lane.cwd, "b.txt"), "two\n");
		git(lane.cwd, "add", "--", "b.txt");
		git(lane.cwd, "commit", "-q", "-m", "commit B");

		const reply = await h.manager.claimDone(lane.originKey, {
			repo: lane.cwd,
			commit: shaA,
			summary: "결과: done\n변경: a\n증거: echo -> ok\n미확인: 없음\n인계: 없음",
		});
		expect(reply).toContain("[not-done]");
		expect(reply).toContain("HEAD가 클레임 커밋이 아님");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
	});

	test("#63: parseLaneAcceptance가 평문 토큰은 가리고 [check:] 내부 토큰은 거부한다", () => {
		const masked = parseLaneAcceptance([`토큰 ${FAKE_TOKEN} 확인`]);
		expect(masked.ok).toBe(true);
		if (masked.ok) {
			expect(masked.value[0]?.text).not.toContain(FAKE_TOKEN);
			expect(masked.value[0]?.text).toContain("[REDACTED]");
		}

		const badCheck = parseLaneAcceptance([`실행 [check: command ["echo","${FAKE_TOKEN}"]]`]);
		expect(badCheck.ok).toBe(false);
	});

	test("#64: releaseHold와 herdr resumeTask가 일시정지된 작업의 pause 표시를 해제한다", async () => {
		const home = makeHome("jabbu-qa64-");
		const repo = makeRepo([]);
		const now = 1_795_500_000_000;
		const db = new Database(":memory:", { strict: true });
		const ledger = new TaskLedger(db, { clock: { now: () => now }, timezone: "Asia/Seoul" });
		cleanups.push(() => {
			db.close();
			removeRepoAndWorktrees(repo);
			home.remove();
		});

		const row = ledger.register({
			title: "herdr 일시정지 해제",
			risk: "L1",
			originKey: `discord/ch/${CHANNEL}/t/2001`,
			threadRef: `${CHANNEL}:2001`,
			host: null,
			repo,
			acceptance: acceptanceItems(["하나"]),
			runtime: "herdr",
		});
		ledger.pauseTask(row.taskId);
		expect(ledger.isPaused(ledger.require(row.taskId))).toBe(true);

		releaseHold(ledger, ledger.require(row.taskId));
		expect(ledger.isPaused(ledger.require(row.taskId))).toBe(false);

		ledger.pauseTask(row.taskId);
		const blocked = ledger.transition(row.taskId, "blocked", "bot", "waiting");
		mkdirSync(blocked.worktree, { recursive: true });
		const transport = new FakeDiscordTransport();
		const deps: TaskDispatchDeps = {
			ledger,
			originKey: `discord/ch/${CHANNEL}`,
			threadRef: () => blocked.threadRef,
			rootText: () => "",
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			now: () => now + 1000,
			timezone: "Asia/Seoul",
			workspaceDir: home.config.workspaceDir,
			secretsDir: join(home.dir, "secrets"),
			log: { info: () => undefined, warn: () => undefined },
			run: async (cmd) => {
				if (cmd.includes("list")) {
					return {
						code: 0,
						stdout: JSON.stringify({ result: { agents: [{ name: row.agent, status: "idle", pane_id: "pane-1" }] } }),
						timedOut: false,
					};
				}
				return { code: 0, stdout: "{}", timedOut: false };
			},
		};
		const reply = await resumeTask(deps, { id: blocked.taskId, task: "재개 진행", host: null });
		expect(reply).toContain("working");
		expect(ledger.isPaused(ledger.require(row.taskId))).toBe(false);
	});

	test("#65: JSON 신호 파싱이 비유한 수를 거부하고 객체 키 순서에 무관하게 비교한다", async () => {
		expect(() => parseChecks("파일 [check: file out.json json:.x=1e999]")).toThrow(SignalSyntaxError);

		let payload = JSON.stringify({ b: 2, a: 1, v: { x: 1, y: 2 } });
		const io: SignalIo = {
			runCheck: async () => ({ code: 0, output: "", timedOut: false }),
			readBytes: async () => Buffer.from(payload, "utf8"),
		};
		expect((await runSignal('file out.json json:.v={"y":2,"x":1}', io)).ok).toBe(true);

		payload = '{"v":1e999}';
		expect((await runSignal("file out.json json:.v=null", io)).ok).toBe(false);
	});

	test("#66: testRegexBounded와 stdout~ 신호가 catastrophic ReDoS에서 inconclusive를 반환한다", async () => {
		const adversarial = `${"a".repeat(30)}!`;
		expect(await testRegexBounded(/(a+)+$/, adversarial, 100)).toBe("timeout");

		const io: SignalIo = {
			runCheck: async () => ({ code: 0, output: adversarial, timedOut: false }),
			readBytes: async () => undefined,
		};
		const result = await runSignal('command ["x"] stdout~"(a+)+$"', io);
		expect(result.ok).toBe(false);
		expect(result.inconclusive).toBe(true);
	});
});
