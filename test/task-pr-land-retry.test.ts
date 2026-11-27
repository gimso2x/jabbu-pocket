import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoLandPolicy } from "../src/tasks/auto-land-policy";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import type { TaskLandOutcome } from "../src/tasks/land";
import { TaskLedger, type TaskRow } from "../src/tasks/ledger";
import type { TaskLandRecord } from "../src/tasks/ledger-schema";
import { buildMergeSettledCard, buildReachedCard } from "../src/tasks/notify";
import {
	isPrRetryable,
	PrLandRetry,
	type PrLandRetryDeps,
	prLandNoticeKey,
	prLandRetryCard,
	prLandStopText,
} from "../src/tasks/pr-land-retry";
import { git } from "./helpers/git-fixtures";
import { PLANTED, TaskPrWorld } from "./helpers/task-pr-harness";

// The automatic retry of a `blocked` PR landing (`PrLandRetry`) and the retry card, against a real in-memory ledger and fake
// seams: no git, no gh, no ssh. What the landing does with a new tip (leak check first) is the 3b tests' ground.

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const NEWER = "c".repeat(40);
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);

interface Rig {
	ledger: TaskLedger;
	clock: { ms: number };
	retry: PrLandRetry;
	row: () => TaskRow;
	head: { value: { sha: string; clean: boolean } | Error };
	reads: string[];
	lands: string[];
	stops: string[];
	outcome: { value: TaskLandOutcome | Error };
	switches: { policy: AutoLandPolicy | undefined; hold: string | undefined; frozen: boolean; ready: boolean };
	tweak: Partial<PrLandRetryDeps>;
	sweep: () => Promise<void>;
}

const policy = (maxRisk: AutoLandPolicy["maxRisk"] = "L2"): AutoLandPolicy => ({ repos: ["/r/repo"], maxRisk });

function rig(
	task: { host?: string | null; risk?: TaskRow["risk"]; land?: Partial<TaskLandRecord> | null; paused?: boolean } = {},
	tweak: Partial<PrLandRetryDeps> = {},
): Rig {
	const clock = { ms: T0 };
	const ledger = new TaskLedger(new Database(":memory:", { strict: true }), {
		timezone: "Asia/Seoul",
		clock: { now: () => clock.ms },
	});
	const registered = ledger.register({
		title: "로그 회전",
		risk: task.risk ?? "L2",
		originKey: "discord/ch/1/t/2",
		threadRef: "1:2",
		host: task.host ?? null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나"]),
	});
	if (task.paused === true) ledger.pauseTask(registered.taskId);
	ledger.transition(registered.taskId, "review", "bot");
	if (task.land !== null)
		ledger.setLand(registered.taskId, {
			mode: "pr",
			state: "blocked",
			requestedBy: "auto",
			sha: OLD,
			baseBranch: "main",
			reason: "누출 검사 실패",
			prLand: { branch: registered.branch },
			...task.land,
		});
	const head: Rig["head"] = { value: { sha: NEW, clean: true } };
	const reads: string[] = [];
	const lands: string[] = [];
	const stops: string[] = [];
	const outcome: Rig["outcome"] = { value: { state: "blocked", reason: "또 막힘" } };
	const switches: Rig["switches"] = { policy: policy(), hold: undefined, frozen: false, ready: true };
	const deps: PrLandRetryDeps = {
		policy: () => switches.policy,
		hold: () => switches.hold,
		frozen: () => switches.frozen,
		ready: () => switches.ready,
		viaPr: async () => true,
		repoMatches: async () => true,
		headOf: async (row) => {
			reads.push(row.taskId);
			if (head.value instanceof Error) throw head.value;
			return head.value;
		},
		autoLand: async (row) => {
			lands.push(row.taskId);
			if (outcome.value instanceof Error) throw outcome.value;
			// The landing itself would save the new tip; the fake keeps the record and the new reason.
			const record = ledger.require(row.taskId).land;
			if (outcome.value.state === "blocked" && record !== null)
				ledger.setLand(row.taskId, {
					...record,
					sha: head.value instanceof Error ? OLD : head.value.sha,
					reason: outcome.value.reason,
				});
			if (outcome.value.state === "pr-open" && record !== null)
				ledger.setLand(row.taskId, { ...record, state: "active" });
			return outcome.value;
		},
		stop: async (_row, state, reason) => {
			stops.push(prLandStopText(state, reason));
			return true;
		},
		now: () => clock.ms,
		log: { info: () => undefined, warn: () => undefined },
		...tweak,
	};
	const retry = new PrLandRetry(deps);
	const row = () => ledger.require(registered.taskId);
	return {
		ledger,
		clock,
		retry,
		row,
		head,
		reads,
		lands,
		stops,
		outcome,
		switches,
		tweak,
		sweep: () => retry.run(row(), ledger),
	};
}

let r: Rig;
beforeEach(() => {
	r = rig();
});

describe("retry card (AC-1)", () => {
	test("the card has the 머지 action id with the PR 다시 올리기 label and the settled card's header and note", () => {
		const row = rig().row();
		const card = prLandRetryCard(row, "⛔ PR 착지 멈춤: x");
		const settled = buildMergeSettledCard(row, "⛔ PR 착지 멈춤: x");
		expect(card.buttons).toEqual([
			{ actionId: `jabbu:task:merge:${row.taskId}`, label: "PR 다시 올리기", value: row.taskId, style: "primary" },
		]);
		expect({ ...card, buttons: undefined }).toEqual({ ...settled, buttons: undefined });
		expect(card.note).toContain("PR 착지 멈춤");
	});

	test("only a blocked or held PR record is retryable; other states, ff-less rows and no record are not", () => {
		for (const state of ["blocked", "held"] as const) expect(isPrRetryable(rig({ land: { state } }).row())).toBe(true);
		for (const state of ["active", "rework"] as const)
			expect(isPrRetryable(rig({ land: { state } }).row())).toBe(false);
		expect(isPrRetryable(rig({ land: null }).row())).toBe(false);
		expect(isPrRetryable(undefined)).toBe(false);
	});

	test("the notice key carries the tip: the same reason on a new tip tells again", () => {
		expect(prLandNoticeKey("blocked", OLD, "x")).not.toBe(prLandNoticeKey("blocked", NEW, "x"));
		expect(prLandNoticeKey("blocked", OLD, "x")).toBe(prLandNoticeKey("blocked", OLD, "x"));
		expect(prLandNoticeKey("held", OLD, "x")).not.toBe(prLandNoticeKey("blocked", OLD, "x"));
	});

	test("the reached card labels the same merge action PR 올리기 when the repository lands through a PR", () => {
		const row = rig().row();
		const judgement = { summary: [], problems: [], integrityWarnings: [], checks: [], evidence: {} };
		const reached = (prMode: boolean) =>
			buildReachedCard(
				row,
				judgement as Partial<TaskJudgement> as TaskJudgement,
				"U1",
				undefined,
				undefined,
				undefined,
				prMode,
			);
		const pr = reached(true);
		expect(pr.buttons?.map((b) => [b.actionId, b.label])).toEqual([
			[`jabbu:task:merge:${row.taskId}`, "PR 올리기"],
			[`jabbu:task:cancel:${row.taskId}`, "취소"],
		]);
		expect(pr.note).toStartWith("PR 올리기 = ");
		expect(reached(false).buttons?.map((b) => b.label)).toEqual(["머지", "취소"]);
	});

	test("the stop line keeps the words the 3b tests look for", () => {
		expect(prLandStopText("held", "r")).toBe("⛔ PR 착지 보류: r");
		expect(prLandStopText("blocked", "r")).toBe("⛔ PR 착지 멈춤: r");
	});
});

describe("automatic retry on a new tip (AC-2)", () => {
	test("a clean new tip calls autoLand once; the same tip is not called again", async () => {
		await r.sweep();
		expect(r.lands).toHaveLength(1);
		await r.sweep();
		await r.sweep();
		expect(r.lands).toHaveLength(1);
	});

	test("a landing that stopped again tells the thread once, and a newer tip retries and tells again", async () => {
		await r.sweep();
		expect(r.stops).toEqual(["⛔ PR 착지 멈춤: 또 막힘"]);
		r.head.value = { sha: NEWER, clean: true };
		await r.sweep();
		expect(r.lands).toHaveLength(2);
		expect(r.stops).toHaveLength(2);
	});

	test("a landing that opened its PR needs no stop card", async () => {
		r.outcome.value = { state: "pr-open", url: "https://example.test/pull/1" };
		await r.sweep();
		expect(r.lands).toHaveLength(1);
		expect(r.stops).toEqual([]);
	});

	test("in_flight and not_accepted are called again on the next sweep", async () => {
		r.outcome.value = { state: "in_flight" };
		await r.sweep();
		r.outcome.value = { state: "not_accepted" };
		await r.sweep();
		expect(r.lands).toHaveLength(2);
		r.outcome.value = { state: "blocked", reason: "또 막힘" };
		await r.sweep();
		await r.sweep();
		expect(r.lands).toHaveLength(3);
	});

	test("an autoLand that throws is retried on the next sweep and never throws out of the sweep", async () => {
		r.outcome.value = new Error("boom");
		await r.sweep();
		r.outcome.value = { state: "blocked", reason: "또 막힘" };
		await r.sweep();
		expect(r.lands).toHaveLength(2);
	});

	test("the same tip as the judged one, a dirty tree, or no readable tip never lands", async () => {
		r.head.value = { sha: OLD, clean: true };
		await r.sweep();
		r.head.value = { sha: NEW, clean: false };
		await r.sweep();
		r.head.value = new Error("git failed");
		await r.sweep();
		expect(r.lands).toHaveLength(0);
	});

	test("a held record, a record without sha, another state, or no record never reads the tip", async () => {
		for (const task of [
			{ land: { state: "held" as const } },
			{ land: { sha: undefined } },
			{ land: { state: "active" as const } },
			{ land: { state: "rework" as const } },
			{ land: null },
		]) {
			const each = rig(task);
			await each.sweep();
			expect(each.reads).toEqual([]);
			expect(each.lands).toEqual([]);
		}
	});

	test("out of policy: auto-merge off, repos outside, risk above maxRisk (also the confident band), no PR repo", async () => {
		const off = rig();
		off.switches.policy = undefined;
		await off.sweep();
		const outside = rig({}, { repoMatches: async () => false });
		await outside.sweep();
		const high = rig({ risk: "L3" });
		await high.sweep();
		const band = rig({ risk: "L3" });
		band.switches.policy = {
			...policy(),
			review: { model: "m", timeoutMs: 1, confident: { maxRisk: "L3", minConfidence: 0.5 } },
		};
		await band.sweep();
		const ff = rig({}, { viaPr: async () => false });
		await ff.sweep();
		for (const each of [off, outside, high, band, ff]) {
			expect(each.reads).toEqual([]);
			expect(each.lands).toEqual([]);
		}
	});

	test("a risk within maxRisk lands (L3 with maxRisk L3)", async () => {
		const wide = rig({ risk: "L3" });
		wide.switches.policy = policy("L3");
		await wide.sweep();
		expect(wide.lands).toHaveLength(1);
	});

	test("hold, freeze, pause and a daemon that cannot land stop it", async () => {
		const held = rig();
		held.switches.hold = "rollback";
		const frozen = rig();
		frozen.switches.frozen = true;
		const paused = rig({ paused: true });
		const notReady = rig();
		notReady.switches.ready = false;
		for (const each of [held, frozen, paused, notReady]) {
			await each.sweep();
			expect(each.reads).toEqual([]);
			expect(each.lands).toEqual([]);
		}
	});

	test("a throwing seam is logged, not thrown", async () => {
		const warned: string[] = [];
		const broken = rig(
			{},
			{
				repoMatches: async () => {
					throw new Error("git gone");
				},
				log: { info: () => undefined, warn: (event) => void warned.push(event) },
			},
		);
		await broken.sweep();
		expect(warned).toEqual(["task_pr_land_retry_failed"]);
	});
});

describe("remote task (AC-3)", () => {
	test("the tip is read once per five minutes; an unchanged tip never lands", async () => {
		const remote = rig({ host: "h1" });
		remote.head.value = { sha: OLD, clean: true };
		await remote.sweep();
		remote.clock.ms += MIN;
		await remote.sweep();
		remote.clock.ms += 3 * MIN;
		await remote.sweep();
		expect(remote.reads).toHaveLength(1);
		remote.clock.ms += 2 * MIN;
		await remote.sweep();
		expect(remote.reads).toHaveLength(2);
		expect(remote.lands).toHaveLength(0);
	});

	test("a changed tip lands once after the slot", async () => {
		const remote = rig({ host: "h1" });
		await remote.sweep();
		expect(remote.lands).toHaveLength(1);
		remote.clock.ms += 6 * MIN;
		await remote.sweep();
		expect(remote.lands).toHaveLength(1);
	});

	test("a failed ssh read does not throw and is read again on the next sweep", async () => {
		const remote = rig({ host: "h1" });
		remote.head.value = new Error("ssh: connect timed out");
		await remote.sweep();
		await remote.sweep();
		expect(remote.reads).toHaveLength(2);
		remote.head.value = { sha: NEW, clean: true };
		await remote.sweep();
		expect(remote.lands).toHaveLength(1);
	});

	test("a local task reads its tip every sweep", async () => {
		r.head.value = { sha: OLD, clean: true };
		await r.sweep();
		await r.sweep();
		expect(r.reads).toHaveLength(2);
	});
});

describe("the real daemon: a blocked PR landing and a new tip", () => {
	let w: TaskPrWorld;
	beforeEach(async () => {
		w = await TaskPrWorld.start({ autoLand: true });
	});
	afterEach(async () => {
		await w.close();
	});

	/** A task whose commit author mail is on the denylist: the leak check stops the landing (record `blocked` with its tip). */
	async function leaked() {
		const { row } = w.seed({
			commits: (wt) => w.commit(wt, ["a.txt"], undefined, "-c", `user.email=dev@${PLANTED}.example`),
		});
		const outcome = await w.daemon.autoLand(row);
		expect(outcome).toMatchObject({ state: "blocked" });
		expect(w.record(row.taskId)).toMatchObject({ state: "blocked", sha: git(row.worktree, "rev-parse", "HEAD") });
		return row;
	}

	/** The author fixed: the branch is rebuilt on the base with a clean identity (a new tip). */
	function fix(row: TaskRow): string {
		git(row.worktree, "reset", "-q", "--hard", "main");
		return w.commit(row.worktree, ["b.txt"]);
	}

	test("the same tip is never landed again: no leak check, gh or fetch on any sweep", async () => {
		await leaked();
		const checks = w.leakInputs.length;
		const calls = w.fake.calls.length;
		await w.poll();
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks);
		expect(w.fake.calls).toHaveLength(calls);
	});

	test("a new clean tip: the next sweep lands once, the leak check runs again and the PR opens; the sweep after that does nothing more", async () => {
		const row = await leaked();
		const checks = w.leakInputs.length;
		const tip = fix(row);
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks + 1);
		expect(w.record(row.taskId)).toMatchObject({ state: "active", sha: tip });
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(1);
		const created = w.fake.callsOf("gh", "pr", "create").length;
		await w.poll();
		expect(w.fake.callsOf("gh", "pr", "create")).toHaveLength(created);
		expect(w.leakInputs).toHaveLength(checks + 1);
	});

	test("a dirty tree or a held record is not retried", async () => {
		const row = await leaked();
		const tip = fix(row);
		writeFileSync(join(row.worktree, "wip.txt"), "wip\n");
		const checks = w.leakInputs.length;
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks);
		rmSync(join(row.worktree, "wip.txt"));
		const record = w.record(row.taskId);
		if (record === null) throw new Error("no record");
		w.daemon.store.tasks.setLand(row.taskId, { ...record, state: "held" });
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks);
		expect(git(row.worktree, "rev-parse", "HEAD")).toBe(tip);
	});

	test("a new tip that is still leaking: blocked again, a stop card with the retry button goes out, and a third sweep does not call again", async () => {
		const row = await leaked();
		git(row.worktree, "reset", "-q", "--hard", "main");
		w.commit(row.worktree, ["c.txt"], undefined, "-c", `user.email=other@${PLANTED}.example`);
		const checks = w.leakInputs.length;
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks + 1);
		expect(w.record(row.taskId)).toMatchObject({ state: "blocked" });
		const cards = w.transport.calls.filter(
			(call) =>
				call.method === "createMessage" &&
				JSON.stringify(call.embeds ?? "").includes("PR 착지 멈춤") &&
				JSON.stringify(call.components ?? []).includes(`jabbu:task:merge:${row.taskId}`),
		);
		expect(cards).toHaveLength(1);
		await w.poll();
		expect(w.leakInputs).toHaveLength(checks + 1);
	});
});
