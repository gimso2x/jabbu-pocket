// T-20261122-06: a [TASK] block with `needs_owner: yes`,
// `fallback_ok: yes` and a `recommend` goes ahead on the recommendation once after `ownerSilenceFallbackMinutes`.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DiscordChannel } from "../src/discord/channel";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems, parseProgress } from "../src/tasks/docs";
import { TaskLedger } from "../src/tasks/ledger";
import { type TaskSweepDeps, TaskSweeper } from "../src/tasks/sweeper";
import { localIso } from "../src/time";
import { OWNER } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const CH = "300000000000000001";
const T1 = "400000000000000001";
const T0 = Date.parse("2026-10-26T06:00:00Z");
const MIN = 60_000;
const SILENCE = "[오너 무응답 30분] 추천안(A로 진행)으로 범위를 좁혀 진행. 보고에 무응답 진행이라고 적을 것";

function judgement(over: Partial<TaskJudgement> = {}): TaskJudgement {
	return {
		reached: false,
		acChecked: 0,
		acTotal: 2,
		stepsDone: 0,
		stepsTotal: 1,
		status: "blocked",
		updatedAt: localIso(T0, "Asia/Seoul"),
		updatedAtMs: T0,
		specChanged: false,
		specKey: "spec1",
		blocked: true,
		needsOwner: true,
		blockedReason: "A·B 중 하나",
		decision: { question: "어느 쪽?", recommend: "A로 진행", impact: "없음", fallbackOk: true },
		current: "S1",
		restated: "",
		evidence: {},
		summary: [],
		checks: [],
		integrityWarnings: [],
		reachKey: "k1",
		acceptance: [],
		steps: [],
		problems: [],
		...over,
	};
}

function rig(minutes: () => number, frozen?: TaskSweepDeps["frozen"]) {
	const clock = { ms: T0 };
	const db = new Database(":memory:", { strict: true });
	const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => clock.ms } });
	const row = ledger.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CH}/t/${T1}`,
		threadRef: `${CH}:${T1}`,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	const transport = new FakeDiscordTransport();
	const next = { value: judgement() };
	const reminders: string[] = [];
	const remindOk = { value: true };
	const deps: TaskSweepDeps = {
		ledger,
		evaluate: async () => ({ ok: true, judgement: next.value }),
		remind: async (_row, text) => {
			if (!remindOk.value) return { ok: false, error: "no agent" };
			reminders.push(text);
			return { ok: true };
		},
		agentStatus: async () => ({ ok: true, status: "idle" }),
		readAgent: async () => ({ ok: true, output: "" }),
		channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
		ownerUserId: OWNER,
		ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: minutes() }),
		...(frozen === undefined ? {} : { frozen }),
		now: () => clock.ms,
		log: { info() {}, warn() {} },
	};
	return {
		deps,
		ledger,
		row,
		clock,
		next,
		reminders,
		remindOk,
		sweeper: new TaskSweeper(deps),
		posts: () =>
			transport.calls.flatMap((call) => (call.method === "createMessage" ? [JSON.stringify(call.content ?? "")] : [])),
	};
}

const silenceReminders = (reminders: string[]): string[] => reminders.filter((text) => text.includes("오너 무응답"));

describe("TASK owner silence fallback", () => {
	test("PROGRESS.md fallback_ok is parsed like needs_owner", () => {
		const text = (value: string) =>
			`---\ntask: T-1\nstatus: blocked\nneeds_owner: yes\nfallback_ok: ${value}\n---\n# 단계\n`;
		expect(parseProgress(text("yes")).fallbackOk).toBe(true);
		expect(parseProgress(text("TRUE")).fallbackOk).toBe(true);
		expect(parseProgress(text("no")).fallbackOk).toBe(false);
		expect(parseProgress("---\ntask: T-1\n---\n").fallbackOk).toBe(false);
	});

	test("AC-2: the recommendation goes ahead once, after the window counted from the question card", async () => {
		const r = rig(() => 30);
		await r.sweeper.sweep();
		expect(r.posts().some((post) => post.includes("A·B 중 하나"))).toBe(true);
		r.clock.ms = T0 + 30 * MIN - 1;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toEqual([]);
		r.clock.ms = T0 + 30 * MIN;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toEqual([SILENCE]);
		expect(r.posts().some((post) => post.includes("추천안(A로 진행)으로 진행합니다"))).toBe(true);
		for (const hours of [1, 2, 5]) {
			r.clock.ms = T0 + hours * 60 * MIN;
			await r.sweeper.sweep();
		}
		expect(silenceReminders(r.reminders)).toHaveLength(1);
	});

	test("AC-2: a restart (new sweeper over the same ledger) neither repeats it nor forgets a pending deadline", async () => {
		const r = rig(() => 30);
		await r.sweeper.sweep();
		// Down past the deadline: the first sweep of the next process meets it.
		r.clock.ms = T0 + 90 * MIN;
		const restarted = new TaskSweeper(r.deps);
		await restarted.sweep();
		expect(silenceReminders(r.reminders)).toHaveLength(1);
		r.clock.ms = T0 + 200 * MIN;
		await new TaskSweeper(r.deps).sweep();
		expect(silenceReminders(r.reminders)).toHaveLength(1);
	});

	test("AC-2: without fallback_ok, without a recommendation, or at 0 minutes the block keeps waiting", async () => {
		for (const [over, minutes] of [
			[{ decision: { question: "q", recommend: "A로 진행", impact: "", fallbackOk: false } }, 30],
			[{ decision: { question: "q", recommend: "", impact: "", fallbackOk: true } }, 30],
			[{ needsOwner: false }, 30],
			[{}, 0],
		] as const) {
			const r = rig(() => minutes);
			r.next.value = judgement(over);
			await r.sweeper.sweep();
			r.clock.ms = T0 + 600 * MIN;
			await r.sweeper.sweep();
			expect(silenceReminders(r.reminders)).toEqual([]);
		}
	});

	test("AC-2: a frozen bot waits; the prompt follows the unfreeze", async () => {
		const frozen = { value: true };
		const r = rig(
			() => 30,
			() => (frozen.value ? { since: "x", reason: "r", by: "b" } : undefined),
		);
		await r.sweeper.sweep();
		r.clock.ms = T0 + 60 * MIN;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toEqual([]);
		frozen.value = false;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toHaveLength(1);
	});

	test("AC-2: a new question after the owner's answer starts its own window", async () => {
		const r = rig(() => 30);
		await r.sweeper.sweep();
		r.clock.ms = T0 + 31 * MIN;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toHaveLength(1);
		r.next.value = judgement({
			blockedReason: "다른 질문",
			decision: { question: "q", recommend: "B로 진행", impact: "", fallbackOk: true },
		});
		await r.sweeper.sweep();
		r.clock.ms = T0 + 62 * MIN;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toHaveLength(2);
		expect(silenceReminders(r.reminders)[1]).toContain("추천안(B로 진행)");
	});
	test("qa-z #49: a prompt the agent never got is not announced as going ahead, and is not sent again", async () => {
		const r = rig(() => 30);
		r.remindOk.value = false;
		await r.sweeper.sweep();
		r.clock.ms = T0 + 30 * MIN;
		await r.sweeper.sweep();
		expect(r.posts().some((post) => post.includes("추천안(A로 진행)으로 진행합니다"))).toBe(false);
		expect(r.posts().some((post) => post.includes("전달하지 못했습니다"))).toBe(true);
		r.remindOk.value = true;
		r.clock.ms = T0 + 90 * MIN;
		await r.sweeper.sweep();
		expect(silenceReminders(r.reminders)).toEqual([]);
	});
});
