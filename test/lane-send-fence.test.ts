// T-20261127-03: a lane whose origin has parked (`uncertain`) inbound rows takes no core steer — a not-done verdict,
// the resume word, the silence fallback (`LaneManager.#send`) — until the owner clears the rows with `/queue
// retry|close`, and the lane's Outcome card says how many are parked. The mailbox's own paths (the one-time notice,
// `/queue`) are not touched: a retried or closed row moves as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLaneOutcomeCard, type LaneCardView } from "../src/lanes/card";
import type { LaneRow } from "../src/lanes/status";
import type { VerifyResult } from "../src/lanes/verify";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

const MINUTE = 60_000;
/** A claim verdict that is not done: the lane gets `not-done` and, unless held, the core's re-prompt. */
const NOT_DONE: VerifyResult = { ok: false, reasons: ["커밋 없음"] };
/** Every kind of Outcome card a closed lane's card goes through. */
const VIEWS: LaneCardView[] = [
	{ kind: "ask" },
	{ kind: "auto" },
	{ kind: "merging", queued: false },
	{ kind: "rework", reason: "기준 브랜치가 앞섰습니다." },
	{ kind: "result" },
	{ kind: "superseded" },
];

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-lane-fence-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

/** Parks one inbound row of `originKey` as `uncertain` (what a send with an unknown outcome leaves); its id. */
function parkRow(h: LaneHarness, originKey: string, threadRef: string, n: number): string {
	const id = `${CHANNEL}:7100000000000000${String(n).padStart(3, "0")}`;
	h.store.recordInbound({ originKey, platformMessageId: id, textRef: `늦게 온 지시 ${n}`, threadRef });
	h.store.markUncertain(id, "send_interrupted");
	return id;
}

/** The `lane_send_fenced_uncertain` log lines. */
const fenceLogs = (h: LaneHarness): string[] =>
	h.logs.filter((line) => line.includes("event=lane_send_fenced_uncertain"));

/** Ids of the core-authored rows (`lane:<name>:<kind>:<seq>`) routed into `originKey`: one per `#send` that went out. */
const coreRows = (h: LaneHarness, originKey: string): string[] =>
	h.store
		.listInbound({ originKey })
		.filter((row) => row.platformMessageId.startsWith("lane:"))
		.map((row) => row.platformMessageId);

/** Starts a lane and commits in its worktree, so a claim that real git verifies closes it. */
async function committedLane(h: LaneHarness, repo: string, title: string): Promise<LaneRow> {
	const lane = await h.manager.start({ title, cwd: repo, channel: CHANNEL });
	writeFileSync(join(lane.cwd, "README.md"), "hello\nnew line\n");
	git(lane.cwd, "commit", "-q", "-am", "work");
	return lane;
}

describe("parked rows of the lane's origin fence the core's steers (AC-1~AC-3)", () => {
	test("AC-1: a not-done verdict routes nothing — no steer, no steerSeq bump — and logs lane_send_fenced_uncertain", async () => {
		const h = laneHarness(home.dir, { verify: async () => NOT_DONE });
		const lane = await h.manager.start({ title: "fenced", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		expect(h.prompts(lane.originKey)).toHaveLength(1);
		parkRow(h, lane.originKey, lane.threadRef, 1);

		const reply = await h.manager.claimDone(lane.originKey, {
			repo: lane.cwd,
			commit: "a".repeat(40),
			summary: "done?",
		});
		await h.settle();
		// The verdict itself is not held: only the re-prompt into the lane is.
		expect(reply).toContain("[not-done]");
		expect(h.store.getLane(lane.name)?.status).toBe("not-done");
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(coreRows(h, lane.originKey)).toEqual([`lane:${lane.name}:start:1`]);
		expect(h.store.getLane(lane.name)?.meta.steerSeq).toBe(1);
		expect(fenceLogs(h)).toHaveLength(1);
		expect(fenceLogs(h)[0]).toContain(`lane=${lane.name}`);
		expect(fenceLogs(h)[0]).toContain("kind=not-done");
		expect(fenceLogs(h)[0]).toContain("uncertain=1");
		h.close();
	});

	test("AC-1: two parked rows count as two, and every further send is fenced again", async () => {
		const h = laneHarness(home.dir, { verify: async () => NOT_DONE });
		const lane = await h.manager.start({ title: "fenced-twice", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		parkRow(h, lane.originKey, lane.threadRef, 1);
		parkRow(h, lane.originKey, lane.threadRef, 2);

		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "a".repeat(40), summary: "first" });
		await h.settle();
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "b".repeat(40), summary: "second" });
		await h.settle();
		expect(h.steers(lane.originKey)).toHaveLength(0);
		expect(h.store.getLane(lane.name)?.meta.steerSeq).toBe(1);
		expect(fenceLogs(h)).toHaveLength(2);
		for (const line of fenceLogs(h)) expect(line).toContain("uncertain=2");
		h.close();
	});

	test("AC-1: the resume word is fenced the same way; the lane itself is given back to working", async () => {
		const h = laneHarness(home.dir);
		const lane = await h.manager.start({ title: "resume-fenced", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		await h.manager.pause(lane.name, "owner-message");
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("paused");
		parkRow(h, lane.originKey, lane.threadRef, 1);

		const outcome = await h.manager.resume(lane.name, "owner-message");
		await h.settle();
		expect(outcome.handled).toBe(true);
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(h.steers(lane.originKey).some((text) => text.includes("오너가 재개했습니다"))).toBe(false);
		expect(coreRows(h, lane.originKey)).toEqual([`lane:${lane.name}:start:1`]);
		expect(fenceLogs(h)).toHaveLength(1);
		expect(fenceLogs(h)[0]).toContain("kind=resume");
		h.close();
	});

	test("AC-1: the silence fallback is fenced too, and like any held send it reports not delivered", async () => {
		const h = laneHarness(home.dir, { ownerSilenceConfig: () => ({ ownerSilenceFallbackMinutes: 30 }) });
		const lane = await h.manager.start({ title: "silence-fenced", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		await h.manager.progress(lane.originKey, "A로 할까요 B로 할까요?", {
			needsOwner: true,
			reversible: true,
			recommend: "A로 진행",
		});
		parkRow(h, lane.originKey, lane.threadRef, 1);
		h.advance(30 * MINUTE);
		await h.manager.tick();
		await h.settle();

		expect((h.drivers.get(lane.originKey)?.calls ?? []).filter((call) => call.includes("오너 무응답"))).toEqual([]);
		// `#send` resolved false: the thread gets the not-delivered line, never the going-ahead line.
		const posted = h.transport.posts().map((post) => JSON.stringify(post));
		expect(posted.some((text) => text.includes("진행 지시를 전달하지 못했습니다"))).toBe(true);
		expect(posted.some((text) => text.includes("으로 진행합니다"))).toBe(false);
		expect(fenceLogs(h)).toHaveLength(1);
		expect(fenceLogs(h)[0]).toContain("kind=silence");
		h.close();
	});

	test("AC-3: parked rows of another origin do not fence this lane", async () => {
		const h = laneHarness(home.dir, { verify: async () => NOT_DONE });
		const repo = makeRepo(repos);
		const mine = await h.manager.start({ title: "mine", cwd: repo, channel: CHANNEL });
		const other = await h.manager.start({ title: "other", cwd: repo, channel: CHANNEL });
		await h.settle();
		parkRow(h, other.originKey, other.threadRef, 1);

		expect(await h.manager.claimDone(mine.originKey, { repo: mine.cwd, commit: "a".repeat(40), summary: "x" })).toContain(
			"[not-done]",
		);
		await h.settle();
		expect(h.steers(mine.originKey)).toHaveLength(1);
		expect(h.steers(mine.originKey)[0]).toContain("not-done");
		expect(h.steers(other.originKey)).toHaveLength(0);
		expect(fenceLogs(h)).toEqual([]);
		h.close();
	});
});

describe("the fence lifts with the row (AC-2)", () => {
	test("AC-2: `/queue retry` (uncertain -> pending): the next not-done verdict is routed again", async () => {
		const h = laneHarness(home.dir, { verify: async () => NOT_DONE });
		const lane = await h.manager.start({ title: "retry", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		const id = parkRow(h, lane.originKey, lane.threadRef, 1);
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "a".repeat(40), summary: "first" });
		await h.settle();
		expect(h.steers(lane.originKey)).toHaveLength(0);

		h.store.retryUncertain(id);
		expect(h.store.getInbound(id)?.state).toBe("pending");
		expect(await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "b".repeat(40), summary: "again" })).toContain(
			"[not-done]",
		);
		await h.settle();
		expect(h.steers(lane.originKey).some((text) => text.includes("not-done"))).toBe(true);
		expect(coreRows(h, lane.originKey)).toEqual([`lane:${lane.name}:start:1`, `lane:${lane.name}:not-done:2`]);
		expect(h.store.getLane(lane.name)?.meta.steerSeq).toBe(2);
		expect(fenceLogs(h)).toHaveLength(1);
		// The retried row itself went out with it: the mailbox's own path is untouched.
		expect(h.store.getInbound(id)?.state).toBe("dispatched");
		h.close();
	});

	test("AC-2: `/queue close` (uncertain -> discarded): the next not-done verdict is routed again", async () => {
		const h = laneHarness(home.dir, { verify: async () => NOT_DONE });
		const lane = await h.manager.start({ title: "close", cwd: makeRepo(repos), channel: CHANNEL });
		await h.settle();
		const id = parkRow(h, lane.originKey, lane.threadRef, 1);
		await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "a".repeat(40), summary: "first" });
		await h.settle();
		expect(h.steers(lane.originKey)).toHaveLength(0);

		h.store.discard(id);
		expect(h.store.getInbound(id)?.state).toBe("discarded");
		expect(await h.manager.claimDone(lane.originKey, { repo: lane.cwd, commit: "c".repeat(40), summary: "again" })).toContain(
			"[not-done]",
		);
		await h.settle();
		expect(h.steers(lane.originKey)).toHaveLength(1);
		expect(h.steers(lane.originKey)[0]).toContain("not-done");
		expect(coreRows(h, lane.originKey)).toEqual([`lane:${lane.name}:start:1`, `lane:${lane.name}:not-done:2`]);
		expect(fenceLogs(h)).toHaveLength(1);
		h.close();
	});
});

describe("the lane card names the parked rows (AC-4)", () => {
	test("AC-4: a lane with a parked row gets the count and the /queue way out on its Outcome card; a lane without one does not", async () => {
		const h = laneHarness(home.dir);
		const repo = makeRepo(repos);
		const fenced = await committedLane(h, repo, "card-fenced");
		const clean = await committedLane(h, repo, "card-clean");
		await h.settle();
		parkRow(h, fenced.originKey, fenced.threadRef, 1);

		await h.manager.claimDone(fenced.originKey, { repo: fenced.cwd, commit: "HEAD", summary: "committed the line" });
		await h.manager.claimDone(clean.originKey, { repo: clean.cwd, commit: "HEAD", summary: "committed the line" });
		await h.settle();
		expect(h.store.getLane(fenced.name)?.status).toBe("closed");
		expect(h.store.getLane(clean.name)?.status).toBe("closed");

		const cards = h.transport.posts().map((post) => post.content ?? "");
		const fencedCard = cards.find((text) => text.includes("머지 대기 · card-fenced"));
		const cleanCard = cards.find((text) => text.includes("머지 대기 · card-clean"));
		expect(fencedCard).toBeDefined();
		expect(fencedCard).toContain("⚠️ 전달 불확실 1건");
		expect(fencedCard).toContain("/queue-jabbu`에서 retry 또는 close");
		expect(cleanCard).toBeDefined();
		expect(cleanCard).not.toContain("전달 불확실");
		h.close();
	});

	test("AC-4: every card but a superseded one opens with the line; a view without the count draws none", () => {
		const lane = { name: "demo", title: "Demo", meta: {} } as unknown as LaneRow;
		const line = "⚠️ 전달 불확실 2건 — `/queue-jabbu`에서 retry 또는 close";
		for (const view of VIEWS) {
			const card = buildLaneOutcomeCard(lane, { ...view, uncertain: 2 });
			if (view.kind === "superseded") {
				// A pointer to the newer card carries no state of its own.
				expect(card.text).not.toContain("전달 불확실");
			} else {
				// First line of the body, right under the title.
				expect(card.body.split("\n")[0]).toBe(line);
				expect(card.text.split("\n")[1]).toBe(line);
			}
			expect(buildLaneOutcomeCard(lane, view).text).not.toContain("전달 불확실");
			expect(buildLaneOutcomeCard(lane, { ...view, uncertain: 0 }).text).not.toContain("전달 불확실");
		}
	});
});
