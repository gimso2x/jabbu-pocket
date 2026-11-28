import { describe, expect, test } from "bun:test";
import { RemoteJudgeClock } from "../src/tasks/remote-judge";

describe("RemoteJudgeClock", () => {
	const row = { taskId: "T-20261128-01", host: "wsl" };
	const idle = async () => ({ ok: true as const, status: "idle" as const });
	const working = async () => ({ ok: true as const, status: "working" as const });

	test("a stop found by the waits() probe is judged once even when the judgement read no agent status", async () => {
		const clock = new RemoteJudgeClock();
		// The judgement's reads kept failing, so it never read the agent: `judged` got `undefined`.
		clock.judged(row, 0, undefined);
		expect(await clock.waits(row, 60_000, false, idle)).toBe(false); // judge once
		expect(await clock.waits(row, 120_000, false, idle)).toBe(true); // the probe recorded the stop: wait for the slot
		expect(await clock.waits(row, 300_000, false, idle)).toBe(false); // the slot is due again
	});

	test("a working agent clears the stop, so the next stop is judged once again", async () => {
		const clock = new RemoteJudgeClock();
		clock.judged(row, 0, { ok: true, status: "idle" });
		expect(await clock.waits(row, 60_000, false, working)).toBe(true);
		expect(await clock.waits(row, 120_000, false, idle)).toBe(false);
		expect(await clock.waits(row, 180_000, false, idle)).toBe(true);
	});
});
