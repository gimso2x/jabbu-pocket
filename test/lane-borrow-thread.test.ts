import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROGRESS_INTERVAL_MS } from "../src/lanes/manager-constants";
import { buildWorkStartTool } from "../src/lanes/tools";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { CHANNEL, GUILD, makeHome, type TestHome } from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";
import { makeRepo } from "./helpers/git-fixtures";
import { type LaneHarness, laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// The first lane started from a conversation thread runs in that thread (no root, no new thread); every other start
// opens a sibling thread from a root in the channel as before.

const signal = new AbortController().signal;
/** The conversation thread: on Discord a thread started from the owner's channel message (same id). */
const THREAD = "300000000000000777";
const THREAD_ORIGIN = `discord/ch/${CHANNEL}/t/${THREAD}`;
const THREAD_REF = `${CHANNEL}:${THREAD}`;

type Create = Extract<FakeDiscordCall, { method: "createMessage" }>;
type Edit = Extract<FakeDiscordCall, { method: "editMessage" }>;

let home: TestHome;
let repos: string[];
let h: LaneHarness;
let repo: string;

beforeEach(() => {
	home = makeHome("jabbu-lane-borrow-home-");
	repos = [];
	repo = makeRepo(repos);
});

afterEach(() => {
	h?.close();
	home.remove();
	for (const dir of repos) removeRepoAndWorktrees(dir);
});

/** A harness whose fake Discord knows the parent channel and the conversation thread in it. */
function harness(extra: Parameters<typeof laneHarness>[1] = {}): LaneHarness {
	const made = laneHarness(home.dir, extra);
	made.transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	made.transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	return made;
}

const creates = (match: (call: Create) => boolean = () => true): Create[] =>
	h.transport.calls.filter((call): call is Create => call.method === "createMessage" && match(call));
const edits = (match: (call: Edit) => boolean = () => true): Edit[] =>
	h.transport.calls.filter((call): call is Edit => call.method === "editMessage" && match(call));
const roots = () => creates((call) => call.channelId === CHANNEL && (call.content ?? "").startsWith("🔄 "));
const threadsOpened = () => h.transport.calls.filter((call) => call.method === "startThread");
const archives = () => h.transport.calls.filter((call) => call.method === "archiveThread");

const borrowStart = (title: string, extra: { workflow?: unknown } = {}) =>
	h.manager.start({
		title,
		cwd: repo,
		channel: CHANNEL,
		parentOrigin: THREAD_ORIGIN,
		borrowThread: { threadId: THREAD },
		...extra,
	});

describe("AC-1: the first lane of a conversation thread borrows it", () => {
	test("no channel root, no openThread; the status is posted in the thread and threadRef is <channel>:<thread>", async () => {
		h = harness();
		const lane = await borrowStart("borrowed");
		await h.settle();
		expect(roots()).toEqual([]);
		expect(threadsOpened()).toEqual([]);
		const status = creates((call) => (call.content ?? "").startsWith("⏳ borrowed"));
		expect(status).toHaveLength(1);
		expect(status[0]?.channelId).toBe(THREAD);
		expect(lane.threadRef).toBe(THREAD_REF);
		expect(lane.meta.borrowedThread).toBe(true);
		expect(lane.meta.renderedRoot).toBeUndefined();
		expect(lane.meta.statusTs).toBe(status[0]?.id);
		expect(h.prompts(lane.originKey)).toHaveLength(1);
	});

	test("the work_start tool borrows its conversation's thread and answers without a link", async () => {
		h = harness();
		const tool = buildWorkStartTool(h.manager, CHANNEL, THREAD_ORIGIN);
		const reply = String(await tool.execute({ title: "tooled", cwd: repo }, { signal }));
		await h.settle();
		const lane = h.store.getLaneByThread(THREAD_REF);
		expect(lane?.meta.borrowedThread).toBe(true);
		expect(reply).toContain(`이 스레드에서 레인 \`${lane?.name}\`을 시작했습니다`);
		expect(reply).not.toContain("https://");
		expect(roots()).toEqual([]);
		const again = String(await tool.execute({ title: "tooled", cwd: repo }, { signal }));
		expect(again).toContain("이미 열려 있어");
		expect(h.store.listLanes()).toHaveLength(1);
	});
});

describe("AC-2: a second lane of the same thread opens a sibling", () => {
	test("another title: root in the channel and a new thread, as before", async () => {
		h = harness();
		const first = await borrowStart("first");
		const second = await borrowStart("second");
		await h.settle();
		expect(first.threadRef).toBe(THREAD_REF);
		expect(second.meta.borrowedThread).toBeUndefined();
		expect(roots().map((call) => call.content)).toEqual(["🔄 second"]);
		expect(threadsOpened()).toHaveLength(1);
		expect(second.threadRef).toBe(`${CHANNEL}:${roots()[0]?.id}`);
		expect(second.meta.renderedRoot).toBe("🔄 second");
	});

	test("a closed lane that borrowed the thread still holds it: the next start opens a sibling", async () => {
		h = harness();
		const first = await borrowStart("first");
		await h.settle();
		h.store.transitionLane(first.name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(first.name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		const next = await borrowStart("next");
		await h.settle();
		expect(next.meta.borrowedThread).toBeUndefined();
		expect(roots()).toHaveLength(1);
	});
});

describe("AC-3: two concurrent starts borrowing one thread", () => {
	test("one borrows the thread, the other opens a sibling", async () => {
		h = harness();
		const [a, b] = await Promise.all([borrowStart("alpha"), borrowStart("beta")]);
		await h.settle();
		const borrowed = [a, b].filter((lane) => lane.meta.borrowedThread === true);
		expect(borrowed).toHaveLength(1);
		expect(borrowed[0]?.threadRef).toBe(THREAD_REF);
		const sibling = [a, b].find((lane) => lane.meta.borrowedThread !== true);
		expect(sibling?.threadRef).not.toBe(THREAD_REF);
		expect(roots()).toHaveLength(1);
		expect(threadsOpened()).toHaveLength(1);
		expect(h.store.listLanes()).toHaveLength(2);
	});
});

describe("AC-4: which origins borrow", () => {
	test("a channel message's reply thread (discord/ch/<C>/t/<message id>) is borrowed", async () => {
		h = harness();
		const message = "300000000000000888";
		h.transport.setChannel({ id: message, type: 11, parentId: CHANNEL, guildId: GUILD });
		const lane = await h.manager.start({
			title: "from the channel",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: `discord/ch/${CHANNEL}/t/${message}`,
			borrowThread: { threadId: message },
		});
		await h.settle();
		expect(lane.threadRef).toBe(`${CHANNEL}:${message}`);
		expect(roots()).toEqual([]);
	});

	test("a command origin (discord/ch/<C>), a DM and a thread of another channel open their own thread", async () => {
		h = harness();
		const tool = buildWorkStartTool(h.manager, CHANNEL, `discord/ch/${CHANNEL}`);
		await tool.execute({ title: "command", cwd: repo }, { signal });
		await h.manager.start({ title: "dm", cwd: repo, channel: CHANNEL, parentOrigin: "discord/dm/1" });
		await h.manager.start({
			title: "elsewhere",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: `discord/ch/300000000000000999/t/${THREAD}`,
			borrowThread: { threadId: THREAD },
		});
		await h.settle();
		expect(roots().map((call) => call.content)).toEqual(["🔄 command", "🔄 dm", "🔄 elsewhere"]);
		expect(h.store.listLanes().every((lane) => lane.meta.borrowedThread === undefined)).toBe(true);
	});

	test("a reservation asked for from a conversation thread starts in a sibling thread", async () => {
		h = harness();
		const prereq = await h.manager.start({
			title: "prereq",
			cwd: repo,
			channel: CHANNEL,
			parentOrigin: "discord/dm/1",
		});
		await h.settle();
		const reservation = await h.manager.reserve({
			args: { title: "later", cwd: repo, channel: CHANNEL },
			after: [prereq.name],
			originKey: THREAD_ORIGIN,
			threadRef: THREAD_REF,
		});
		h.store.transitionLane(prereq.name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(prereq.name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		await h.manager.tick();
		await h.settle();
		const outcome = await h.manager.startReservation(reservation.id);
		await h.settle();
		expect(outcome.handled).toBe(true);
		const started = h.store.getLane(h.store.getLaneReservation(reservation.id)?.laneName ?? "");
		expect(started?.meta.borrowedThread).toBeUndefined();
		expect(started?.threadRef).not.toBe(THREAD_REF);
		expect(roots().map((call) => call.content)).toEqual(["🔄 prereq", "🔄 later"]);
	});
});

describe("AC-5: drawing and failing a borrowed lane", () => {
	test("#sync edits only the status, never the thread's first message", async () => {
		h = harness();
		const lane = await borrowStart("synced");
		await h.settle();
		h.advance(PROGRESS_INTERVAL_MS);
		await h.manager.tick();
		h.store.transitionLane(lane.name, "done-claimed", { event: "claimed" });
		h.store.transitionLane(lane.name, "closed", { event: "landed" }, { land: { state: "landed", attempts: 0 } });
		await h.manager.tick();
		await h.settle();
		expect(edits().length).toBeGreaterThan(0);
		expect(edits((call) => call.messageId !== lane.meta.statusTs)).toEqual([]);
		expect(h.store.getLane(lane.name)?.meta.renderedRoot).toBeUndefined();
	});

	test("failLaunch archives nothing and posts its ❌ notice in the thread", async () => {
		const sessions = new FakeSessionStore();
		h = harness({
			driver: (_origin, sessionDir) =>
				new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, commands: [] }),
		});
		const lane = await borrowStart("refused", { workflow: { name: "ulw-plan", reason: "plan" } });
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("closed");
		expect(archives()).toEqual([]);
		const notice = creates((call) => (call.content ?? "").startsWith("❌ 레인을 시작하지 못했습니다"));
		expect(notice).toHaveLength(1);
		expect(notice[0]?.channelId).toBe(THREAD);
		expect(edits((call) => call.messageId !== lane.meta.statusTs)).toEqual([]);
	});

	test("a start failing after its status was posted turns that status ❌ (no button) and posts no new ❌", async () => {
		h = harness();
		const insert = h.store.insertLane.bind(h.store);
		h.store.insertLane = () => {
			throw new Error("UNIQUE constraint failed: lanes.thread_ref");
		};
		await expect(borrowStart("raced")).rejects.toThrow("UNIQUE");
		h.store.insertLane = insert;
		const status = creates((call) => (call.content ?? "").startsWith("⏳ raced"))[0];
		expect(edits()).toEqual([
			expect.objectContaining({ channelId: THREAD, messageId: status?.id, content: "❌ raced", components: [] }),
		]);
		expect(creates((call) => (call.content ?? "").startsWith("❌"))).toEqual([]);
		expect(archives()).toEqual([]);
		expect(h.store.listLanes()).toEqual([]);
	});

	test("when that ❌ edit fails, one ❌ message is posted in the thread instead", async () => {
		h = harness();
		h.store.insertLane = () => {
			throw new Error("UNIQUE constraint failed: lanes.thread_ref");
		};
		h.transport.failNext.editMessage = [new Error("edit down")];
		await expect(borrowStart("raced")).rejects.toThrow("UNIQUE");
		expect(creates((call) => call.content === "❌ raced").map((call) => call.channelId)).toEqual([THREAD]);
	});

	test("a start failing before its status was posted posts nothing in the thread", async () => {
		h = harness();
		h.transport.failNext.createMessage = [new Error("status post down")];
		await expect(borrowStart("early")).rejects.toThrow("status post down");
		// The one attempt is the refused status post; nothing follows it.
		expect(creates()).toHaveLength(1);
		expect(edits()).toEqual([]);
		expect(archives()).toEqual([]);
		// The thread is free again: the next start borrows it.
		const retry = await borrowStart("early");
		await h.settle();
		expect(retry.threadRef).toBe(THREAD_REF);
	});
});
