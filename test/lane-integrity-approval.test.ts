import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type IntegrityRefusal, LaneDiffUnavailable } from "../src/lanes/integrity";
import { type IntegrityReaders, integrityRefusalsOf, refusalFingerprint } from "../src/lanes/integrity-approval";
import { CLAIM_GRACE_MS, OVERLAP_REPLY } from "../src/lanes/manager-constants";
import type { LaneRow } from "../src/lanes/status";
import { createTaskHostOps, type TaskHostOps } from "../src/tasks/host";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, type LaneHarnessExtra, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const CHECK_SLOW = 'bun test가 통과한다 [check: command ["sh","-c","exit 0 # slow"]]';
const SLOW = "exit 0 # slow";

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-lane-approval-home-");
	repos = [];
});
afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

const refusalOf = (excerpt: string): IntegrityRefusal => ({
	category: "unfinished_work_marker",
	excerpt,
	remedy: "끝내세요",
});

/** A judge whose verdict the test sets; `current.refusals` is what every claim is refused for. */
function judge(excerpt = "a.txt: TODO") {
	const current = { refusals: [refusalOf(excerpt)] };
	return { current, integrity: () => current.refusals };
}

/** Host ops whose slow check times out while `slow.timedOut` is set; others run for real. */
function slowOps() {
	const real = createTaskHostOps();
	const slow = { timedOut: false };
	const ops: TaskHostOps = {
		...real,
		async runCheck(input) {
			if (input.argv.at(-1) !== SLOW) return real.runCheck(input);
			return slow.timedOut ? { code: null, output: "", timedOut: true } : { code: 0, output: "", timedOut: false };
		},
	};
	return { ops, slow };
}

/** An approval surface that answers from `answers` in order and records each card. */
function cards(...answers: Array<"approved" | "denied" | "timeout">) {
	const asked: string[] = [];
	return {
		asked,
		approvals: {
			request: (_channel: string, summary: string) => {
				asked.push(summary);
				return Promise.resolve(answers[asked.length - 1] ?? "timeout");
			},
		},
	};
}

/** An approval surface whose cards wait for the test: `answer(n, verdict)` settles the n-th card. */
function heldCards() {
	const asked: string[] = [];
	const waiting: Array<PromiseWithResolvers<"approved" | "denied" | "timeout">> = [];
	const arrived: Array<PromiseWithResolvers<void>> = [];
	const slot = (i: number): PromiseWithResolvers<void> => {
		for (let n = arrived.length; n <= i; n++) arrived.push(Promise.withResolvers<void>());
		return arrived[i] as PromiseWithResolvers<void>;
	};
	return {
		asked,
		cardArrived: (i: number) => slot(i).promise,
		answer: (i: number, verdict: "approved" | "denied" | "timeout") => waiting[i]?.resolve(verdict),
		approvals: {
			request: (_channel: string, summary: string) => {
				const i = asked.length;
				asked.push(summary);
				const wait = Promise.withResolvers<"approved" | "denied" | "timeout">();
				waiting.push(wait);
				slot(i).resolve();
				return wait.promise;
			},
		},
	};
}

function commitIn(worktree: string, ...files: string[]): string {
	for (const file of files) writeFileSync(join(worktree, file), `${file} ${Math.random()}\n`);
	git(worktree, "add", "--", ...files);
	git(worktree, "commit", "-q", "-m", `add ${files.join(" ")}`);
	return git(worktree, "rev-parse", "HEAD");
}

async function startLane(h: LaneHarness, acceptance: string[] = []): Promise<LaneRow> {
	const repo = makeRepo(repos);
	const lane = await h.manager.start({ title: "approved once", cwd: repo, channel: CHANNEL, acceptance, risk: "L2" });
	await h.settle();
	return lane;
}

const claim = (h: LaneHarness, lane: LaneRow) =>
	h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "HEAD", summary: "완료" });
const harness = (extra: LaneHarnessExtra) => laneHarness(home.dir, extra);

describe("an approved integrity verdict is not asked again (T-20261124-03 AC-1)", () => {
	test("a re-claim of the same commit while the first card waits: one card, and the lane closes", async () => {
		const j = judge();
		const held = heldCards();
		const h = harness({ integrity: j.integrity, approvals: held.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		const first = claim(h, lane);
		await held.cardArrived(0);
		h.advance(5_000);
		expect(await claim(h, lane)).toBe(OVERLAP_REPLY);

		held.answer(0, "approved");
		await first;
		await h.manager.settledInBackground();
		await h.settle();
		expect(held.asked).toHaveLength(1);
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(h.logs.some((line) => line.includes("lane_integrity_approval_reused"))).toBe(true);
		h.close();
	});

	test("the same commit with another verdict (different fingerprint) is asked again", async () => {
		const j = judge("a.txt: TODO one");
		const slow = slowOps();
		const answers = cards("approved", "approved");
		const h = harness({ integrity: j.integrity, approvals: answers.approvals, hostOps: slow.ops });
		const lane = await startLane(h, [CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");
		slow.slow.timedOut = true;
		await claim(h, lane);
		await h.settle();
		expect(answers.asked).toHaveLength(1);
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");
		expect(h.store.getLane(lane.name)?.meta.integrityApproval?.fingerprint).toBe(
			refusalFingerprint(j.current.refusals),
		);

		j.current.refusals = [refusalOf("a.txt: TODO two")];
		slow.slow.timedOut = false;
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(answers.asked).toHaveLength(2);
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("denied is not remembered: the same commit claimed again is asked again", async () => {
		const j = judge();
		const answers = cards("denied", "approved");
		const h = harness({ integrity: j.integrity, approvals: answers.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		await claim(h, lane);
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.store.getLane(lane.name)?.meta.integrityApproval).toBeUndefined();
		await claim(h, lane);
		await h.settle();
		expect(answers.asked).toHaveLength(2);
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("the owner answered while the card waited: the later approval is not recorded, the next claim asks again", async () => {
		const j = judge();
		const held = heldCards();
		const h = harness({ integrity: j.integrity, approvals: held.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		const first = claim(h, lane);
		await held.cardArrived(0);
		h.store.transitionLane(lane.name, "working", { event: "owner_reply" }, { claim: undefined });
		held.answer(0, "approved");
		await first;
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(h.store.getLane(lane.name)?.meta.integrityApproval).toBeUndefined();

		const second = claim(h, lane);
		await held.cardArrived(1);
		held.answer(1, "approved");
		await second;
		await h.settle();
		expect(held.asked).toHaveLength(2);
		h.close();
	});

	test("a close and a reopen both drop the record: the next close of the lane asks again", async () => {
		const j = judge();
		const answers = cards("approved", "approved");
		const h = harness({ integrity: j.integrity, approvals: answers.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		await claim(h, lane);
		await h.settle();
		const closed = h.store.getLane(lane.name) as LaneRow;
		expect(closed.status).toBe("closed");
		expect(closed.meta.integrityApproval).toBeUndefined();

		h.store.patchLane(lane.name, undefined, {
			integrityApproval: { sha: closed.meta.sha ?? "", fingerprint: refusalFingerprint(j.current.refusals), at: 1 },
		});
		h.manager.onOwnerMessage(closed, "!reopen");
		await h.settle();
		const reopened = h.store.getLane(lane.name) as LaneRow;
		expect(reopened.status).toBe("working");
		expect(reopened.meta.integrityApproval).toBeUndefined();
		h.close();
	});
});

describe("a recorded approval survives (T-20261124-03 AC-2)", () => {
	test("a check that timed out and runs again after the grace: no second card", async () => {
		const j = judge();
		const slow = slowOps();
		const answers = cards("approved");
		const h = harness({ integrity: j.integrity, approvals: answers.approvals, hostOps: slow.ops });
		const lane = await startLane(h, [CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");
		slow.slow.timedOut = true;
		await claim(h, lane);
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("done-claimed");

		slow.slow.timedOut = false;
		h.advance(CLAIM_GRACE_MS);
		await h.manager.tick();
		await h.settle();
		expect(answers.asked).toHaveLength(1);
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		h.close();
	});

	test("a new manager over the same store (a restart) reuses it", async () => {
		const j = judge();
		const slow = slowOps();
		const answers = cards("approved");
		const first = harness({ integrity: j.integrity, approvals: answers.approvals, hostOps: slow.ops });
		const lane = await startLane(first, [CHECK_SLOW]);
		commitIn(lane.cwd, "a.txt");
		slow.slow.timedOut = true;
		await claim(first, lane);
		await first.settle();
		expect(first.store.getLane(lane.name)?.meta.integrityApproval).toBeDefined();
		first.close();

		slow.slow.timedOut = false;
		const second = harness({ integrity: j.integrity, approvals: answers.approvals, hostOps: slow.ops });
		second.advance(CLAIM_GRACE_MS);
		await second.manager.tick();
		await second.settle();
		expect(answers.asked).toHaveLength(1);
		expect(second.store.getLane(lane.name)?.status).toBe("closed");
		second.close();
	});
});

describe("the card over the refusal cap (T-20261125-05 AC-4)", () => {
	const todos = (n: number): IntegrityRefusal[] => Array.from({ length: n }, (_, i) => refusalOf(`a.txt: TODO ${i}`));
	const guardDeletion: IntegrityRefusal = {
		category: "guard_deletion_without_adversarial_regression",
		excerpt: "a.txt: guard",
		remedy: "복원하세요",
	};

	test("12 TODOs and a guard deletion: the card shows the guard line, 8 lines and the notice", async () => {
		const answers = cards("denied");
		const h = harness({ integrity: () => [...todos(12), guardDeletion], approvals: answers.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		await claim(h, lane);
		await h.settle();
		const card = answers.asked[0] ?? "";
		expect(card).toContain("guard_deletion_without_adversarial_regression: a.txt: guard");
		expect(card.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
		expect(card).toContain("8건 상한으로 나머지가 생략됐을 수 있음");
		h.close();
	});

	test("9 TODOs merged with a commit identity refusal: the identity line survives", async () => {
		const repo = makeRepo(repos);
		const answers = cards("denied");
		const h = harness({
			integrity: () => todos(9),
			approvals: answers.approvals,
			autoLandPolicy: () => ({ repos: [repo], maxRisk: "L2", commitEmails: { [repo]: ["owner@example.com"] } }),
		});
		const lane = await h.manager.start({ title: "identity", cwd: repo, channel: CHANNEL, acceptance: [], risk: "L2" });
		await h.settle();
		writeFileSync(join(lane.cwd, "a.txt"), "a\n");
		git(lane.cwd, "add", "--", "a.txt");
		git(
			lane.cwd,
			"-c",
			"user.email=owner@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--author",
			"t <x@other.example>",
			"-m",
			"a",
		);
		await claim(h, lane);
		await h.settle();
		const card = answers.asked[0] ?? "";
		expect(card).toContain("commit_identity_mismatch");
		expect(card.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
		h.close();
	});

	test("3 TODOs: no notice line", async () => {
		const answers = cards("denied");
		const h = harness({ integrity: () => todos(3), approvals: answers.approvals });
		const lane = await startLane(h);
		commitIn(lane.cwd, "a.txt");
		await claim(h, lane);
		await h.settle();
		const card = answers.asked[0] ?? "";
		expect(card.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
		expect(card).not.toContain("상한");
		h.close();
	});
});

describe("integrityRefusalsOf over the cap (T-20261125-05 AC-5)", () => {
	test("an unreadable base plus 9 TODOs: 8 refusals led by lane_diff_unavailable", async () => {
		const readers: IntegrityReaders = {
			collectDiff: () => Promise.reject(new LaneDiffUnavailable("no base")),
			integrity: () => Array.from({ length: 9 }, (_, i) => refusalOf(`a.txt: TODO ${i}`)),
			allowedEmails: () => Promise.resolve(undefined),
			plansRoot: () => undefined,
			warn: () => {},
		};
		const lane = { name: "l", cwd: "/nowhere", meta: { baseBranch: "main" }, history: [] } as unknown as LaneRow;
		const out = await integrityRefusalsOf(readers, lane, { summary: "완료" } as never, "abc");
		expect(out).toHaveLength(8);
		expect(out[0]?.category).toBe("lane_diff_unavailable");
	});
});
