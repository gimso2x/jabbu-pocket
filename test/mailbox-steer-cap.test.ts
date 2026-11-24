import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningStatusText } from "../src/channel/text";
import { OriginMailbox, type TurnProgress } from "../src/core/mailbox";
import { OWNER_STOPPED_TEXT } from "../src/core/mailbox-notices";
import { MAX_STEERS } from "../src/core/mailbox-types";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "discord/dm/200000000000000021";
const PEER = "100000000000000077";

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

let dir: string;
let clock: FakeClock;
let store: Store;
let opened: FakeOmpDriver[];
let logLines: string[];
let progress: TurnProgress[];
let open: number;
let answers: string[];
let counter = 0;

function msg(text: string): InboundRecord {
	const id = `cap${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

function makeMailbox(): OriginMailbox {
	return new OriginMailbox({
		timezone: "Asia/Seoul",
		originKey: ORIGIN,
		store,
		clock,
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		statusProvider: () => "status: ok",
		sessionDirFor: (key, epoch) => sessionDirFor(join(dir, "sessions"), key, epoch),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ holdTurns: true, sessionDir, store: new FakeSessionStore() });
			opened.push(driver);
			return driver;
		},
		onProgress: (info) => progress.push(info.progress),
		dialogs: {
			open: () => open,
			answer: async (_origin, text) => {
				if (open !== 1) return false;
				open = 0;
				answers.push(text);
				return true;
			},
			ambiguous: () => undefined,
		},
	});
}

const steersOf = (driver: FakeOmpDriver): string[] => driver.calls.filter((c) => c.startsWith("steer:"));
const promptsOf = (driver: FakeOmpDriver): string[] => driver.calls.filter((c) => c.startsWith("prompt:"));

async function untilFinal(mailbox: OriginMailbox, driver: FakeOmpDriver): Promise<void> {
	const seen = new Promise<void>((resolve) => {
		const off = driver.onFinal(() => {
			off();
			resolve();
		});
	});
	driver.release();
	await seen;
	await mailbox.sweepIdle();
}

const toolStart = (id: string | undefined, command: string): OmpEvent => ({
	type: "tool_execution_start",
	...(id === undefined ? {} : { toolCallId: id }),
	toolName: "bash",
	args: { command },
});
const toolEnd = (id: string | undefined, command: string, isError = false): OmpEvent => ({
	type: "tool_execution_end",
	...(id === undefined ? {} : { toolCallId: id }),
	toolName: "bash",
	result: { content: [{ type: "text", text: `out ${command}` }] },
	isError,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-steer-cap-"));
	clock = new FakeClock();
	store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
	opened = [];
	logLines = [];
	progress = [];
	open = 0;
	answers = [];
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("mailbox: steer cap", () => {
	test("six owner messages in a running turn: four are steered, the rest stay pending and run in the next turn", async () => {
		const mailbox = makeMailbox();
		try {
			await mailbox.enqueue(msg("lead"));
			const driver = opened[0] as FakeOmpDriver;
			const rows = Array.from({ length: 6 }, (_, i) => msg(`m${i + 1}`));
			for (const row of rows) await mailbox.enqueue(row);
			expect(steersOf(driver)).toEqual(["steer:m1", "steer:m2", "steer:m3", "steer:m4"]);
			expect(store.getInbound((rows[4] as InboundRecord).platformMessageId)?.state).toBe("pending");
			expect(store.getInbound((rows[5] as InboundRecord).platformMessageId)?.state).toBe("pending");
			expect(logLines.filter((line) => line.includes("steer_capped"))).not.toHaveLength(0);
			expect(progress.at(-1)).toMatchObject({ steers: MAX_STEERS, steerCapped: true });
			expect(runningStatusText(false, 0, progress.at(-1))).toContain("이후 메시지는 이 작업 뒤에 이어서 처리");

			// The turn ends: m5 opens the next turn and m6 is steered into it.
			await untilFinal(mailbox, driver);
			expect(promptsOf(driver).map((c) => c.includes("m5"))).toEqual([false, true]);
			expect(steersOf(driver).slice(4)).toEqual(["steer:m6"]);
			const second = store.getInbound((rows[4] as InboundRecord).platformMessageId);
			expect(store.getInbound((rows[5] as InboundRecord).platformMessageId)).toMatchObject({
				state: "dispatched",
				opRef: second?.opRef ?? "missing",
			});
		} finally {
			await mailbox.close();
		}
	});

	test("loop-correction steers and peer rows do not use up the cap", async () => {
		const mailbox = makeMailbox();
		try {
			await mailbox.enqueue(msg("lead"));
			const driver = opened[0] as FakeOmpDriver;
			store.recordInbound({
				originKey: ORIGIN,
				platformMessageId: "peer-cap",
				textRef: "peer",
				threadRef: "peer-cap",
				peerUserId: PEER,
			});
			for (const command of ["a", "b", "c"]) {
				for (let i = 0; i < 3; i++) {
					driver.emitTestEvent(toolStart(`${command}${i}`, command));
					driver.emitTestEvent(toolEnd(`${command}${i}`, command, true));
				}
			}
			for (let i = 1; i <= 5; i++) await mailbox.enqueue(msg(`o${i}`));
			await mailbox.resumePending();
			const owner = steersOf(driver).filter((c) => c.startsWith("steer:o"));
			expect(owner).toEqual(["steer:o1", "steer:o2", "steer:o3", "steer:o4"]);
			expect(steersOf(driver).filter((c) => c.includes("jabbu"))).toHaveLength(3);
			expect(store.getInbound("peer-cap")?.state).toBe("pending");
		} finally {
			await mailbox.close();
		}
	});

	test("!stop runs at once while a capped row waits", async () => {
		const mailbox = makeMailbox();
		try {
			await mailbox.enqueue(msg("lead"));
			const driver = opened[0] as FakeOmpDriver;
			for (let i = 1; i <= 5; i++) await mailbox.enqueue(msg(`m${i}`));
			const waiting = store.listInbound({ originKey: ORIGIN, state: "pending" });
			expect(waiting).toHaveLength(1);
			// A command that reached the ledger but was left to the drain (attach in flight) still runs.
			store.recordInbound({
				originKey: ORIGIN,
				platformMessageId: "stop-cap",
				textRef: "!stop",
				threadRef: "stop-cap",
			});
			await mailbox.resumePending();
			expect(driver.calls.filter((c) => c.startsWith("abort"))).toEqual(["abortAndClearQueue"]);
			expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([
				`${OWNER_STOPPED_TEXT} 대기 1개를 취소했습니다.`,
			]);
		} finally {
			await mailbox.close();
		}
	});

	test("a held-back row never answers a card opened later; a message after the card does", async () => {
		const mailbox = makeMailbox();
		try {
			await mailbox.enqueue(msg("lead"));
			const driver = opened[0] as FakeOmpDriver;
			for (let i = 1; i <= 5; i++) await mailbox.enqueue(msg(`m${i}`));
			expect(steersOf(driver)).toHaveLength(4);
			open = 1;
			await mailbox.enqueue(msg("그걸로 해"));
			expect(answers).toEqual(["그걸로 해"]);
			expect(store.listInbound({ originKey: ORIGIN, state: "pending" }).map((row) => row.textRef)).toEqual(["m5"]);
		} finally {
			await mailbox.close();
		}
	});
});

describe("mailbox: tool states", () => {
	test("start is running, end settles ok or error with the time; end without id or for a pushed-out entry is ignored", async () => {
		const mailbox = makeMailbox();
		try {
			await mailbox.enqueue(msg("lead"));
			const driver = opened[0] as FakeOmpDriver;
			driver.emitTestEvent(toolStart("t1", "ls"));
			expect(progress.at(-1)?.recentTools.map((t) => t.state)).toEqual(["running"]);
			clock.advance(2000);
			driver.emitTestEvent(toolEnd("t1", "ls"));
			expect(progress.at(-1)?.recentTools[0]).toMatchObject({ state: "ok", callId: "t1" });
			expect((progress.at(-1)?.recentTools[0]?.endedAt ?? 0) - (progress.at(-1)?.recentTools[0]?.startedAt ?? 0)).toBe(
				2000,
			);
			driver.emitTestEvent(toolStart("t2", "false"));
			driver.emitTestEvent(toolEnd("t2", "false", true));
			expect(progress.at(-1)?.recentTools[1]?.state).toBe("error");

			const reports = progress.length;
			driver.emitTestEvent(toolEnd(undefined, "ls"));
			for (const id of ["t3", "t4", "t5"]) driver.emitTestEvent(toolStart(id, id));
			const afterStarts = progress.length;
			expect(afterStarts).toBe(reports + 3);
			driver.emitTestEvent(toolEnd("t1", "ls")); // t1 is out of the last three
			expect(progress.length).toBe(afterStarts);
			expect(progress.at(-1)?.recentTools.map((t) => t.callId)).toEqual(["t3", "t4", "t5"]);
		} finally {
			await mailbox.close();
		}
	});
});
