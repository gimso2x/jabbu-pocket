import { describe, expect, test } from "bun:test";
import { type StatusEntry, type StatusPlatform, StatusTracker } from "../src/channel/status";
import type { TurnProgress } from "../src/core/mailbox";

const INTERVAL_MS = 15_000;
const THREAD = "C1/P1";
const ORIGIN = "discord/dm/u1";
const progress = (tools: number): TurnProgress => ({ tools, recentTools: [], steers: 0, retries: 0 });

/** A platform whose running edits stay in flight until the test settles them (`true` = rate limited). */
function harness(): {
	tracker: StatusTracker;
	clock: { at: number };
	edits: Array<(limited: boolean) => void>;
} {
	const clock = { at: 0 };
	const edits: Array<(limited: boolean) => void> = [];
	const platform: StatusPlatform = {
		create: async (entry: StatusEntry) => {
			entry.statusChannel = "c1";
			entry.statusId = "s1";
		},
		edit: () => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			edits.push(resolve);
			return promise;
		},
		remove: async () => false,
		removeEyes: async () => false,
		addMark: async () => false,
	};
	const tracker = new StatusTracker({ platform, clock: { now: () => clock.at }, intervalMs: INTERVAL_MS });
	return { tracker, clock, edits };
}

async function begin(tracker: StatusTracker): Promise<void> {
	await tracker.begin(THREAD, ORIGIN, {
		channel: "c1",
		root: "r1",
		reaction: { channelId: "c1", messageId: "m1" },
		showStatus: true,
		setup: Promise.resolve(),
	});
}

/** The edit promises stay pending until the test settles them, so draining the queue cannot change the count. */
async function drain(): Promise<void> {
	for (let hop = 0; hop < 32; hop++) await Promise.resolve();
}

describe("status (qa residue: a burst of progress events)", () => {
	test("a burst of progress events sends one status edit, not one per event", async () => {
		const { tracker, clock, edits } = harness();
		await begin(tracker);
		clock.at = INTERVAL_MS + 1;
		const burst = Array.from({ length: 16 }, (_, index) => tracker.setProgress(THREAD, ORIGIN, progress(index + 1)));
		await drain();
		expect(edits.length).toBe(1);
		for (const settle of edits) settle(false);
		await Promise.all(burst);
		expect(edits.length).toBe(1);
	});

	test("a rate-limited status edit is retried by the next tick", async () => {
		const { tracker, clock, edits } = harness();
		await begin(tracker);
		clock.at = INTERVAL_MS + 1;
		const first = tracker.setProgress(THREAD, ORIGIN, progress(1));
		await drain();
		expect(edits.length).toBe(1);
		edits[0]?.(true);
		await first;
		const tick = tracker.tick();
		await drain();
		expect(edits.length).toBe(2);
		edits[1]?.(false);
		await tick;
		// The edit went out: the cadence starts over and the next tick inside the interval sends nothing.
		await tracker.tick();
		expect(edits.length).toBe(2);
	});
});
