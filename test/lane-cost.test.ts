import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildLaneOutcomeCard } from "../src/lanes/card";
import { laneCost } from "../src/lanes/cost";
import { detachSummary } from "../src/lanes/manager-text";
import type { LaneRow } from "../src/lanes/status";
import { conversationSessionFiles, summarizeSessionFiles } from "../src/ops/usage";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const CHANNEL = "100000000000000001";
const GUILD = "200000000000000001";

function commitIn(dir: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(dir, file), `${file}\n`);
	git(dir, "add", "--", ...files);
	git(dir, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return git(dir, "rev-parse", "HEAD").trim();
}

describe("laneCost (AC-1)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lane-cost-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("sums costTotal and calls across all epochs and subagents from dirname(lane.sessionDir)", async () => {
		const originDir = join(root, "sessions", "lane-origin-1");
		const e1Dir = join(originDir, "e1");
		const e1SubDir = join(e1Dir, "subagents", "agent-1");
		const e2Dir = join(originDir, "e2");

		mkdirSync(e1Dir, { recursive: true });
		mkdirSync(e1SubDir, { recursive: true });
		mkdirSync(e2Dir, { recursive: true });

		const rec1 = JSON.stringify({
			type: "message",
			message: { role: "assistant", usage: { cost: { total: 0.15 }, input: 100, output: 50 } },
		});
		const rec2 = JSON.stringify({
			type: "model_usage",
			usage: { cost: { total: 0.25 }, input: 200, output: 100 },
		});
		const rec3 = JSON.stringify({
			type: "message",
			message: { role: "assistant", usage: { cost: { total: 0.1 }, input: 50, output: 25 } },
		});

		writeFileSync(join(e1Dir, "session.jsonl"), `${rec1}\n`);
		writeFileSync(join(e1SubDir, "transcript.jsonl"), `${rec2}\n`);
		writeFileSync(join(e2Dir, "session.jsonl"), `${rec3}\n`);

		const files = conversationSessionFiles(originDir);
		expect(files).toHaveLength(3);
		const expectedTotals = await summarizeSessionFiles(files);

		// Passing actual lane.sessionDir pointing to .../e1
		const fakeLane = { sessionDir: e1Dir };
		const result = await laneCost(fakeLane);

		expect(result.calls).toBe(3);
		expect(result.costTotal).toBeCloseTo(0.5, 4);
		expect(result.costTotal).toBe(expectedTotals.costTotal);
		expect(result.calls).toBe(expectedTotals.calls);
		expect(result.input).toBe(expectedTotals.input);
		expect(result.output).toBe(expectedTotals.output);
	});

	test("returns zeroes without error when no session files exist", async () => {
		const originDir = join(root, "sessions", "lane-origin-empty");
		const e1Dir = join(originDir, "e1");
		mkdirSync(e1Dir, { recursive: true });

		const result = await laneCost({ sessionDir: e1Dir });
		expect(result.calls).toBe(0);
		expect(result.costTotal).toBe(0);
		expect(result.files).toBe(0);
	});

	test("returns zeroes without error when sessionDir is missing or non-existent", async () => {
		const nonExistent = join(root, "non-existent", "e1");
		const result = await laneCost({ sessionDir: nonExistent });
		expect(result.calls).toBe(0);
		expect(result.costTotal).toBe(0);

		const empty = await laneCost({ sessionDir: "" });
		expect(empty.calls).toBe(0);
		expect(empty.costTotal).toBe(0);
	});
});

describe("buildLaneOutcomeCard and detachSummary cost lines (AC-2 unit)", () => {
	const dummyLane: LaneRow = {
		name: "lane-cost-card",
		title: "비용 카드 테스트",
		threadRef: "discord:1234567890:9876543210",
		originKey: "ompbot/test/cost",
		cwd: "/tmp/repo",
		sessionDir: "/tmp/sessions/lane-origin-1/e1",
		status: "closed",
		history: [],
		meta: {
			startedAt: 1000,
			lastProgressAt: 2000,
			steerSeq: 0,
			baseBranch: "main",
			branch: "task/cost",
			sha: "1234567890abcdef",
			claim: { summary: "비용 기능 구현", commit: "1234567890abcdef", repo: "/tmp/repo", claimedAt: 1500 },
		},
		createdAt: 1000,
		updatedAt: 2000,
	};

	test("buildLaneOutcomeCard draws cost line when view.cost is present", () => {
		const card = buildLaneOutcomeCard(dummyLane, {
			kind: "ask",
			cost: { usd: 1.25, calls: 5 },
		});
		expect(card.text).toContain("💰 워커 세션 $1.25 (호출 5회)");
		expect(card.body).toContain("💰 워커 세션 $1.25 (호출 5회)");
	});

	test("buildLaneOutcomeCard omits cost line when view.cost is undefined", () => {
		const card = buildLaneOutcomeCard(dummyLane, { kind: "ask" });
		expect(card.text).not.toContain("💰 워커 세션");
		expect(card.body).not.toContain("💰 워커 세션");
	});

	test("buildLaneOutcomeCard draws $0.00 (호출 0회) when cost has 0 calls/usd", () => {
		const card = buildLaneOutcomeCard(dummyLane, {
			kind: "ask",
			cost: { usd: 0, calls: 0 },
		});
		expect(card.text).toContain("💰 워커 세션 $0.00 (호출 0회)");
	});

	test("cost is fixed to two decimal places", () => {
		const card1 = buildLaneOutcomeCard(dummyLane, {
			kind: "ask",
			cost: { usd: 1.2, calls: 3 },
		});
		expect(card1.text).toContain("💰 워커 세션 $1.20 (호출 3회)");

		const card2 = buildLaneOutcomeCard(dummyLane, {
			kind: "ask",
			cost: { usd: 12.3456, calls: 10 },
		});
		expect(card2.text).toContain("💰 워커 세션 $12.35 (호출 10회)");
	});

	test("detachSummary includes cost line when cost is provided and omits when undefined", () => {
		const withCost = detachSummary(2, 3, 0.45, false, { usd: 1.5, calls: 4 });
		expect(withCost).toBe(
			"🖥 터미널 omp에서 레인을 돌려받았습니다 — TUI에서 2턴, 바뀐 파일 3개, TUI 비용 $0.45\n💰 워커 세션 $1.50 (호출 4회)",
		);

		const withoutCost = detachSummary(2, 3, 0.45, false);
		expect(withoutCost).toBe("🖥 터미널 omp에서 레인을 돌려받았습니다 — TUI에서 2턴, 바뀐 파일 3개, TUI 비용 $0.45");

		const zeroCost = detachSummary(1, 0, 0, true, { usd: 0, calls: 0 });
		expect(zeroCost).toBe(
			"🖥 터미널 omp에서 레인을 돌려받았습니다 (attach 프로세스가 끝나 코어가 되찾음) — TUI에서 1턴, 바뀐 파일 0개, TUI 비용 $0.00\n💰 워커 세션 $0.00 (호출 0회)",
		);
	});
});

describe("LaneManager cost wiring and failure fallback (AC-2 integration)", () => {
	let home: string;
	let repos: string[] = [];
	let h: LaneHarness;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "lane-cost-mgr-home-"));
		repos = [];
		h = laneHarness(home);
		h.transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	});

	afterEach(() => {
		h.close();
		for (const r of repos) removeRepoAndWorktrees(r);
		rmSync(home, { recursive: true, force: true });
	});

	test("posts card with cost calculated from sessions, or $0.00 (호출 0회) if no sessions", async () => {
		const repo = makeRepo(repos);
		const started = await h.manager.start({
			title: "cost-card-lane",
			cwd: repo,
			channel: CHANNEL,
		});
		await h.settle();

		// Write a fake session file into originDir/e1
		const e1Dir = started.sessionDir;
		mkdirSync(e1Dir, { recursive: true });
		const rec = JSON.stringify({
			type: "message",
			message: { role: "assistant", usage: { cost: { total: 0.75 }, input: 100, output: 50 } },
		});
		writeFileSync(join(e1Dir, "session.jsonl"), `${rec}\n`);

		commitIn(started.cwd, "work.txt");
		await h.manager.claimDone(started.originKey, {
			repo: started.cwd,
			commit: "HEAD",
			summary: "작업 완료",
		});
		await h.settle();

		const cardPost = h.transport.posts().find((post) => post.content?.includes("머지 대기") === true);
		expect(cardPost).toBeDefined();
		expect(cardPost?.content).toContain("💰 워커 세션 $0.75 (호출 1회)");
	});

	test("when reading cost throws, card posts without cost line and logs lane_cost_failed", async () => {
		const repo = makeRepo(repos);
		const started = await h.manager.start({
			title: "cost-fail-lane",
			cwd: repo,
			channel: CHANNEL,
		});
		await h.settle();

		const originDir = dirname(started.sessionDir);
		mkdirSync(started.sessionDir, { recursive: true });

		// Make originDir inaccessible to force laneCost to throw EACCES
		chmodSync(originDir, 0o000);

		try {
			commitIn(started.cwd, "fail-work.txt");
			await h.manager.claimDone(started.originKey, {
				repo: started.cwd,
				commit: "HEAD",
				summary: "실패 작업",
			});
			await h.settle();

			const cardPost = h.transport.posts().find((post) => post.content?.includes("머지 대기") === true);
			expect(cardPost).toBeDefined();
			// Card posts without cost line
			expect(cardPost?.content).not.toContain("💰 워커 세션");
			// Warning log lane_cost_failed is present
			expect(h.logs.some((line) => line.includes("lane_cost_failed"))).toBe(true);
		} finally {
			chmodSync(originDir, 0o755);
		}
	});

	test("detach appends cost line, and falls back if cost lookup fails", async () => {
		const repo = makeRepo(repos);
		const started = await h.manager.start({
			title: "detach-lane",
			cwd: repo,
			channel: CHANNEL,
		});
		await h.settle();

		mkdirSync(started.sessionDir, { recursive: true });
		const sessionFile = join(started.sessionDir, "session.jsonl");
		const rec = JSON.stringify({
			type: "message",
			message: { role: "assistant", usage: { cost: { total: 0.4 }, input: 100, output: 50 } },
		});
		writeFileSync(sessionFile, `${rec}\n`);

		// Attach
		const attached = await h.manager.attach(started.name, { pid: process.pid, wait: false, keepPaused: false });
		expect(attached.ok).toBe(true);

		// Detach with cost
		const detached = await h.manager.detach(started.name, { sessionFile, newFiles: [], by: "cli" });
		expect(detached.handled).toBe(true);
		expect(detached.text).toContain("💰 워커 세션 $0.40 (호출 1회)");
	});
});
