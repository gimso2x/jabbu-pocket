import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLaneTools } from "../src/lanes/tools";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// `ompbot_lane_progress` evidence `{ toolCallId }`: a finished, successful, non-ompbot tool call of the lane session.

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("ompbot-lane-toolcall-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

const line = (message: unknown) => `${JSON.stringify({ type: "message", message })}\n`;
const call = (id: string, name: string) =>
	line({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] });
const result = (id: string, text: string, extra: Record<string, unknown> = {}) =>
	line({
		role: "toolResult",
		toolCallId: id,
		toolName: extra.toolName,
		isError: extra.isError === true,
		content: [{ type: "text", text }],
	});

async function laneWithSession(transcript: string) {
	const file = join(home.dir, "lane-session.jsonl");
	writeFileSync(file, transcript);
	const store = new FakeSessionStore();
	const h = laneHarness(home.dir, {
		driver: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store, holdTurns: true, sessionFile: file }),
	});
	const lane = await h.manager.start({ title: "research", cwd: makeRepo(repos), channel: CHANNEL });
	await h.settle();
	return { h, lane };
}

describe("lane progress: tool call evidence (AC-1)", () => {
	test("a finished successful tool call is recorded as { toolCallId, tool, sha256(result) }", async () => {
		const { h, lane } = await laneWithSession(
			call("c1", "bash") + result("c1", "42 tests passed", { toolName: "bash" }),
		);
		expect(await h.manager.progress(lane.originKey, "ran the suite", { evidence: { toolCallId: "c1" } })).toBe(
			"progress recorded",
		);
		const expected = { toolCallId: "c1", tool: "bash", sha256: sha256("42 tests passed") };
		const stored = h.store.getLane(lane.name);
		expect(stored?.meta.milestoneEvidence).toEqual(expected);
		expect(stored?.meta.evidence).toEqual([expected]);
		h.close();
	});

	test("the tool name falls back to the assistant's call when the result does not carry it", async () => {
		const { h, lane } = await laneWithSession(call("c2", "grep") + result("c2", "3 hits"));
		await h.manager.progress(lane.originKey, "searched", { evidence: { toolCallId: "c2" } });
		expect(h.store.getLane(lane.name)?.meta.milestoneEvidence).toMatchObject({ toolCallId: "c2", tool: "grep" });
		h.close();
	});

	test("a failed call, an ompbot_* call, an unfinished call, an unknown id and file+toolCallId are refused with a reason", async () => {
		const { h, lane } = await laneWithSession(
			call("bad", "bash") +
				result("bad", "exit 1", { isError: true, toolName: "bash" }) +
				call("own", "ompbot_lane_progress") +
				result("own", "progress recorded", { toolName: "ompbot_lane_progress" }) +
				call("board", "ompbot_board_post") +
				result("board", "posted") +
				call("running", "bash"),
		);
		const before = h.store.getLane(lane.name);
		const cases: Array<[unknown, string]> = [
			[{ toolCallId: "bad" }, "failed"],
			[{ toolCallId: "own" }, "ompbot tools cannot be evidence"],
			[{ toolCallId: "board" }, "ompbot tools cannot be evidence"],
			[{ toolCallId: "running" }, "no finished tool call"],
			[{ toolCallId: "nope" }, "no finished tool call"],
			[{ toolCallId: "" }, "non-empty"],
			[{ toolCallId: 7 }, "non-empty"],
			[{ toolCallId: "bad", file: "x.txt" }, "not both"],
		];
		for (const [evidence, reason] of cases) {
			const reply = await h.manager.progress(lane.originKey, "no proof", { evidence });
			expect(reply).toStartWith("progress not recorded: ");
			expect(reply).toContain(reason);
		}
		expect(h.store.getLane(lane.name)?.meta.milestone).toBe(before?.meta.milestone);
		expect(h.store.getLane(lane.name)?.meta.evidence).toBeUndefined();
		h.close();
	});

	test("the lane host tool passes toolCallId through to the manager", async () => {
		const { h, lane } = await laneWithSession(call("c3", "read") + result("c3", "contents", { toolName: "read" }));
		const [progress] = buildLaneTools(h.manager, lane.originKey);
		const reply = await progress?.execute(
			{ text: "read it", evidence: { toolCallId: "c3" } },
			{ signal: new AbortController().signal },
		);
		expect(reply).toBe("progress recorded");
		h.close();
	});
});
