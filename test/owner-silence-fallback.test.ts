// T-20261122-06: a reversible lane question with a recommendation
// goes ahead on it once after `ownerSilenceFallbackMinutes`; anything else keeps waiting.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const MINUTE = 60_000;
const SILENCE = "오너 무응답";

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-owner-silence-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** The silence prompts the lane's omp child received (as a prompt or a steer, whichever the mailbox chose). */
const silencePrompts = (h: LaneHarness, originKey: string): string[] =>
	(h.drivers.get(originKey)?.calls ?? []).filter((call) => call.includes(SILENCE));

const silenceEvents = (h: LaneHarness, name: string): number =>
	h.store.getLane(name)?.history.filter((entry) => entry.event === "owner_silence_fallback").length ?? 0;

async function askedLane(h: LaneHarness, ask: { reversible?: boolean; recommend?: string }) {
	const lane = await h.manager.start({ title: "silence", cwd: makeRepo(repos), channel: CHANNEL });
	await h.settle();
	await h.manager.progress(lane.originKey, "A로 할까요 B로 할까요?", { needsOwner: true, ...ask });
	return lane;
}

describe("lane owner silence fallback", () => {
	test("AC-1: a reversible question with a recommendation goes ahead once after the window, never before", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lane = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		h.advance(30 * MINUTE - 1);
		await h.manager.tick();
		await h.settle();
		expect(silencePrompts(h, lane.originKey)).toEqual([]);
		h.advance(1);
		await h.manager.tick();
		await h.settle();
		const [sent] = silencePrompts(h, lane.originKey);
		expect(sent).toContain(
			"[오너 무응답 30분] 추천안(A로 진행)으로 범위를 좁혀 진행. 보고에 무응답 진행이라고 적을 것",
		);
		expect(h.transport.posts().some((post) => JSON.stringify(post).includes("추천안(A로 진행)으로 진행합니다"))).toBe(
			true,
		);
		for (let n = 0; n < 3; n += 1) {
			h.advance(60 * MINUTE);
			await h.manager.tick();
			await h.settle();
		}
		expect(silencePrompts(h, lane.originKey)).toHaveLength(1);
		expect(silenceEvents(h, lane.name)).toBe(1);
		h.close();
	});

	test("AC-1: a restart keeps the deadline and the once-only mark", async () => {
		const first = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lane = await askedLane(first, { reversible: true, recommend: "A로 진행" });
		first.close();
		// The daemon was down past the deadline: the first tick of the next process meets it.
		const second = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		second.advance(45 * MINUTE);
		await second.manager.tick();
		await second.settle();
		expect(silencePrompts(second, lane.originKey)).toHaveLength(1);
		second.close();
		const third = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		third.advance(120 * MINUTE);
		await third.manager.tick();
		await third.settle();
		expect(silencePrompts(third, lane.originKey)).toEqual([]);
		expect(silenceEvents(third, lane.name)).toBe(1);
		third.close();
	});

	test("AC-1: without reversible or without a recommendation the question keeps waiting", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lanes = [
			await askedLane(h, {}),
			await askedLane(h, { recommend: "A로 진행" }),
			await askedLane(h, { reversible: true }),
		];
		for (const lane of lanes) expect(h.store.getLane(lane.name)?.meta.ownerQuestion).toBeUndefined();
		h.advance(600 * MINUTE);
		await h.manager.tick();
		await h.settle();
		for (const lane of lanes) {
			expect(silencePrompts(h, lane.originKey)).toEqual([]);
			expect(silenceEvents(h, lane.name)).toBe(0);
		}
		h.close();
	});

	test("AC-1: 0 minutes turns the fallback off", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 0 }) });
		const lane = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		h.advance(600 * MINUTE);
		await h.manager.tick();
		await h.settle();
		expect(silencePrompts(h, lane.originKey)).toEqual([]);
		h.close();
	});

	test("AC-1: the owner's word before the deadline answers the question; after it the word still reaches the lane", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const answered = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		const late = await askedLane(h, { reversible: true, recommend: "B로 진행" });
		h.advance(10 * MINUTE);
		const answeredRow = h.store.getLane(answered.name);
		if (answeredRow === undefined) throw new Error("lane missing");
		h.manager.onOwnerMessage(answeredRow, "B로 해");
		expect(h.store.getLane(answered.name)?.meta.ownerQuestion).toBeUndefined();
		h.advance(30 * MINUTE);
		await h.manager.tick();
		await h.settle();
		expect(silencePrompts(h, answered.originKey)).toEqual([]);
		expect(silencePrompts(h, late.originKey)).toHaveLength(1);

		// After the fallback the owner's text is delivered to the lane as before.
		await h.route({
			platformMessageId: "owner-after-silence",
			originKey: late.originKey,
			ownerVerified: true,
			text: "역시 C로 해줘",
			threadRef: late.threadRef,
		});
		await h.settle();
		expect((h.drivers.get(late.originKey)?.calls ?? []).some((call) => call.includes("역시 C로 해줘"))).toBe(true);
		h.close();
	});

	test("AC-1: a paused lane waits for the owner's resume instead of taking the recommendation", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lane = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		await h.manager.pause(lane.name, "owner-message");
		h.advance(60 * MINUTE);
		await h.manager.tick();
		await h.settle();
		expect(silenceEvents(h, lane.name)).toBe(0);
		h.close();
	});
	test("qa-z #47: the time held by 멈춰 is not silence — the window starts again at 계속", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lane = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		await h.manager.pause(lane.name, "owner-message");
		h.advance(60 * MINUTE);
		await h.manager.resume(lane.name, "owner-message");
		await h.manager.tick();
		await h.settle();
		expect(silenceEvents(h, lane.name)).toBe(0);
		h.advance(30 * MINUTE);
		await h.manager.tick();
		await h.settle();
		expect(silenceEvents(h, lane.name)).toBe(1);
		h.close();
	});

	test("qa-z #49: a fallback prompt the lane never received is not announced as going ahead", async () => {
		const h = laneHarness(home.dir, {
			ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }),
			routeFails: (record) => record.text.includes(SILENCE),
		});
		const lane = await askedLane(h, { reversible: true, recommend: "A로 진행" });
		h.advance(30 * MINUTE);
		await h.manager.tick();
		await h.settle();
		expect(silenceEvents(h, lane.name)).toBe(1);
		expect(h.transport.posts().some((post) => JSON.stringify(post).includes("추천안(A로 진행)으로 진행합니다"))).toBe(
			false,
		);
		expect(h.transport.posts().some((post) => JSON.stringify(post).includes("전달하지 못했습니다"))).toBe(true);
		expect(
			h.transport.posts().some((post) => JSON.stringify(post).includes("이 스레드에 답하면 이어서 진행합니다")),
		).toBe(true);
		h.close();
	});

	test("qa-z #100: an answer that lands while the tick is on an earlier lane stops the fallback of the answered one", async () => {
		let answer: (() => void) | undefined;
		const h = laneHarness(home.dir, {
			ownerSilenceConfig: () => {
				answer?.();
				answer = undefined;
				return { ownerSilenceFallbackMinutes: 30 };
			},
		});
		const first = await h.manager.start({ title: "first", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		const asked = await askedLane(h, { reversible: true, recommend: "B로 진행" });
		expect(h.store.listLanes()[0]?.name).toBe(first.name);
		h.advance(30 * MINUTE);
		// The owner answers the second lane after the tick took its snapshot, while it handles the first lane.
		answer = () => {
			const row = h.store.getLane(asked.name);
			if (row === undefined) throw new Error("lane missing");
			h.manager.onOwnerMessage(row, "A로 해");
		};
		await h.manager.tick();
		await h.settle();
		expect(silencePrompts(h, asked.originKey)).toEqual([]);
		expect(silenceEvents(h, asked.name)).toBe(0);
		h.close();
	});
});
