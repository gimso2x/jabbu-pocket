import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginMailbox } from "../src/core/mailbox";
import type { ColdCacheInfo } from "../src/core/mailbox-types";
import { OriginRouter, openBotStore, sessionDirFor } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

class Clock {
	t = Date.now();
	now(): number {
		return this.t;
	}
}

const ORIGIN = "discord/ch/300000000000000001";
const REF = "300000000000000001:400000000000000222";

function msg(threadRef: string, platformMessageId: string, text: string): InboundRecord {
	return { platformMessageId, originKey: ORIGIN, ownerVerified: true, text, threadRef };
}

let dir: string;
let clock: Clock;
let store: Store;
let router: OriginRouter;
let drivers: FakeOmpDriver[];
let coldCaches: ColdCacheInfo[];
const sessionStore = new FakeSessionStore();

function buildRouter(): OriginRouter {
	return new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: () => undefined, clock, redact }),
		statusProvider: () => "status: ok",
		onColdCache: (info) => coldCaches.push(info),
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({
				sessionDir,
				store: sessionStore,
				holdTurns: true,
				turnUsage: () => ({ calls: 1, input: 1000, cacheRead: 0, output: 10, rotated: false }),
			});
			drivers.push(driver);
			return driver;
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-cache-seed-"));
	clock = new Clock();
	store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
	drivers = [];
	coldCaches = [];
	router = buildRouter();
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One held turn: route the record, then release the driver's turn and let the mailbox settle it. */
async function turn(mailbox: OriginMailbox, driverIndex: number, route: () => Promise<void>): Promise<void> {
	await route();
	const driver = drivers[driverIndex];
	if (driver === undefined) throw new Error(`driver ${driverIndex} missing`);
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = driver.onFinal(() => {
		off();
		resolve();
	});
	driver.release();
	await promise;
	await mailbox.sweepIdle();
}

/** The origin's epoch directory (in production omp creates it; the fake driver does not). */
function epochDir(): string {
	const path = sessionDirFor(join(dir, "sessions"), ORIGIN, 1);
	mkdirSync(path, { recursive: true });
	return path;
}

describe("cache seeding from the session file tail", () => {
	test("a restart seeds the baseline from the session file and warns about the cold cache", async () => {
		const mailbox = router.mailbox(ORIGIN);
		await turn(mailbox, 0, () => router.route(msg(REF, "C1:111.222", "첫 질문")));
		expect(coldCaches).toHaveLength(0);

		// A previous turn left a large cached prefix two hours ago; the fake driver's entries carry no usage,
		// so only the session file can seed the baseline.
		const then = clock.now() - 2 * 60 * 60_000;
		writeFileSync(
			join(epochDir(), "11111111-aaaa.jsonl"),
			[
				JSON.stringify({
					id: "e1",
					parentId: null,
					type: "model_change",
					timestamp: new Date(then - 60_000).toISOString(),
				}),
				JSON.stringify({
					id: "e2",
					parentId: "e1",
					type: "message",
					timestamp: new Date(then).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "old answer" }],
						usage: { input: 1000, cacheRead: 300000, cacheWrite: 5000, cost: { cacheWrite: 0.5 } },
						provider: "anthropic",
						model: "claude-sonnet-4",
					},
				}),
			].join("\n"),
		);

		await router.close();
		router = buildRouter();
		const restarted = router.mailbox(ORIGIN);
		await turn(restarted, 1, () => router.route(msg(REF, "C1:111.333", "다시 질문")));
		expect(coldCaches).toHaveLength(1);
		expect(coldCaches[0]).toMatchObject({ originKey: ORIGIN, prefixTokens: 305000 });
		expect(coldCaches[0]?.idleMs).toBeGreaterThan(60 * 60_000);
	});
});
