import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";

const DISCORD_CH = "111111111111111111";
const DISCORD_THREAD = "222222222222222222";

let dir: string;
let now: number;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-delivery-platform-"));
	now = 1_800_000_000_000;
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock: { now: () => now }, redact });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One owner message on `originKey` in `threadRef`, answered with `body` (a pending delivery). */
function answer(originKey: string, threadRef: string, messageId: string, body: string): void {
	store.ensureOrigin(originKey, join(dir, "sessions", messageId));
	store.recordInbound({ originKey, platformMessageId: messageId, textRef: `질문 ${body}`, threadRef });
	store.markDispatched(messageId, { opRef: `op-${messageId}`, entryCursor: null });
	store.recordAnswer({ originKey, opRef: `op-${messageId}`, threadRef, parts: [body] });
}

describe("claimDue by platform", () => {
	beforeEach(() => {
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread",
		);
		answer(`discord/dm/${DISCORD_CH}`, `${DISCORD_CH}:-`, `${DISCORD_CH}:999`, "discord top level");
		// A monitor answer: its origin is no chat key, its thread ref is the owner's Discord DM.
		store.recordInterim({
			originKey: "monitor/x",
			opRef: "mon-1",
			threadRef: `${DISCORD_CH}:-`,
			index: 0,
			body: "monitor",
		});
		// A row whose thread ref names no platform stays unclaimed by a platform-scoped claim.
		store.recordInterim({
			originKey: "monitor/y",
			opRef: "mon-2",
			threadRef: "unknown:-",
			index: 0,
			body: "unknown platform",
		});
	});

	const bodies = (rows: Array<{ body: string }>) => rows.map((row) => row.body);
	const states = () => Object.fromEntries(store.listDeliveries().map((row) => [row.body, row.state]));

	test("discord takes the Discord thread refs (the monitor delivery included) and leaves the unknown one pending", () => {
		expect(bodies(store.claimDue(20, "discord"))).toEqual(["discord thread", "discord top level", "monitor"]);
		expect(states()).toEqual({
			"discord thread": "inflight",
			"discord top level": "inflight",
			monitor: "inflight",
			"unknown platform": "pending",
		});
	});

	test("the limit counts only the platform's rows; without a platform every due row is claimed as before", () => {
		expect(bodies(store.claimDue(1, "discord"))).toEqual(["discord thread"]);
		expect(bodies(store.claimDue())).toEqual(["discord top level", "monitor", "unknown platform"]);
	});

	test("without a platform every due row is claimed, in delivery order", () => {
		expect(bodies(store.claimDue())).toEqual(["discord thread", "discord top level", "monitor", "unknown platform"]);
		expect(states()).toEqual({
			"discord thread": "inflight",
			"discord top level": "inflight",
			monitor: "inflight",
			"unknown platform": "inflight",
		});
	});
});

describe("ledger reads by platform", () => {
	beforeEach(() => {
		answer(`discord/dm/${DISCORD_CH}`, `${DISCORD_CH}:333333333333333333`, `${DISCORD_CH}:333`, "discord dm answer");
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord thread answer",
		);
		for (const row of store.claimDue()) store.confirmDelivery(row.deliveryId);
	});

	test("listOrigins returns the platform's origin keys only", () => {
		expect(store.listOrigins("discord")).toEqual([
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`discord/dm/${DISCORD_CH}`,
		]);
	});

	test("listThreadTargets returns the platform's answered threads only", () => {
		const sorted = (targets: Array<{ channel: string; rootTs: string }>) =>
			targets.map((t) => `${t.channel}:${t.rootTs}`).sort();
		expect(sorted(store.listThreadTargets("discord", 0, 50))).toEqual([
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:333333333333333333`,
		]);
	});

	test("listRecallCandidates of a Discord conversation reads its Discord rows", () => {
		const candidates = store.listRecallCandidates(DISCORD_CH, "none", 50);
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) expect(candidate.originKey.startsWith(`discord/`)).toBe(true);
		expect(new Set(candidates.map((c) => c.originKey))).toEqual(
			new Set([`discord/dm/${DISCORD_CH}`, `discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`]),
		);
		expect(candidates.map((c) => c.text)).toContain("discord thread answer");
	});

	test("ownerDmOrigin reads the platform's DM origin", () => {
		expect(store.ownerDmOrigin("discord")).toBe(`discord/dm/${DISCORD_CH}`);
	});
});

describe("expired rows go back to their platform's adapter", () => {
	const DAY = 24 * 60 * 60_000;
	const bodies = (rows: Array<{ body: string }>) => rows.map((row) => row.body);

	test("a row the sweep expired is handed once to the adapter of its platform", () => {
		answer(
			`discord/ch/${DISCORD_CH}/t/${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			`${DISCORD_CH}:${DISCORD_THREAD}`,
			"discord answer",
		);
		now += DAY;
		expect(store.claimDue(20, "discord")).toEqual([]);
		expect(store.listDeliveries().map((row) => row.state)).toEqual(["expired"]);
		expect(bodies(store.takeExpired("discord"))).toEqual(["discord answer"]);
		expect(store.takeExpired("discord")).toEqual([]);
	});

	test("a failed send that expires is not handed over again: the pump already finished it", () => {
		answer(`discord/dm/${DISCORD_CH}`, `${DISCORD_CH}:1.1`, `${DISCORD_CH}:1.1`, "discord answer");
		const [claimed] = store.claimDue(20, "discord");
		if (claimed === undefined) throw new Error("nothing claimed");
		now += DAY;
		expect(store.failDelivery(claimed.deliveryId, "channel_not_found").state).toBe("expired");
		expect(store.claimDue(20, "discord")).toEqual([]);
		expect(store.takeExpired("discord")).toEqual([]);
	});
});
