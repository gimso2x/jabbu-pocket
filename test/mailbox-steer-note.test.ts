import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_STOPPED_TEXT } from "../src/core/mailbox-notices";
import { OriginRouter, openBotStore } from "../src/core/origin";
import type { InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import type { OmpFinal } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";

const ORIGIN = "discord/dm/200000000000000031";

class FakeClock {
	t = 1_000_000;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/**
 * The agy-print driver's abort shape: no `abortAndClearQueue`, one `aborted` final whose error names the steers
 * still sitting in the driver's queue ("cancelled (steer N건 미전달)"), and the queue is gone right after.
 */
class QueuedAbortDriver extends FakeOmpDriver {
	steersQueued = 0;
	lastOpRef: string | undefined;
	readonly emitted: OmpFinal[] = [];
	readonly #finals = new Set<(final: OmpFinal) => void>();
	override onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finals.add(listener);
		const off = super.onFinal(listener);
		return () => {
			this.#finals.delete(listener);
			off();
		};
	}
	override async prompt(text: string): Promise<string> {
		this.lastOpRef = await super.prompt(text);
		this.steersQueued = 0;
		return this.lastOpRef;
	}
	override async steer(text: string): Promise<void> {
		await super.steer(text);
		this.steersQueued += 1;
	}
	override async state(): Promise<Awaited<ReturnType<FakeOmpDriver["state"]>>> {
		return { ...(await super.state()), queuedMessageCount: this.steersQueued };
	}
	#emit(final: OmpFinal): void {
		this.emitted.push(final);
		for (const listener of [...this.#finals]) listener(final);
	}
	override async abort(): Promise<void> {
		this.calls.push("abort");
		const queued = this.steersQueued;
		this.steersQueued = 0;
		const error = queued === 0 ? "cancelled" : `cancelled (steer ${queued}건 미전달)`;
		this.#emit({
			opRef: this.lastOpRef ?? "",
			status: "aborted",
			text: "",
			error,
			...(queued === 0 ? {} : { droppedSteers: queued }),
		});
	}
	/** A provider-side failure (a 429): the turn ends `error` with the undelivered-steer note appended. */
	failTurn(error: string): void {
		this.#emit({ opRef: this.lastOpRef ?? "", status: "error", text: "", error });
	}
}

let dir: string;
let clock: FakeClock;
let store: Store;
let router: OriginRouter;
let drivers: QueuedAbortDriver[];
let logLines: string[];
let counter = 0;

function msg(text: string): InboundRecord {
	const id = `m${++counter}`;
	return { platformMessageId: id, originKey: ORIGIN, ownerVerified: true, text, threadRef: id };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-steer-note-"));
	clock = new FakeClock();
	store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
	drivers = [];
	logLines = [];
	router = new OriginRouter({
		timezone: "Asia/Seoul",
		store,
		clock,
		sessionsRoot: join(dir, "sessions"),
		log: createLogger({ sink: (line) => logLines.push(line), clock, redact }),
		statusProvider: () => "status: ok",
		restartProvider: async () => "🔄 재시작을 접수했습니다(apply-x).",
		onEscalate: () => {},
		onCacheMiss: () => {},
		onColdCache: () => {},
		driverFactory: (_origin, sessionDir) => {
			const driver = new QueuedAbortDriver({ holdTurns: true, sessionDir, store: new FakeSessionStore() });
			// agy-print has no abort_and_restore_queue RPC: the mailbox falls back to abort() + state().
			(driver as unknown as { abortAndClearQueue?: unknown }).abortAndClearQueue = undefined;
			drivers.push(driver);
			return driver;
		},
	});
});

afterEach(async () => {
	await router.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("mailbox: owner visibility of the undelivered-steer note", () => {
	test("a 429 failure notice carries the note to the thread, exactly once", async () => {
		const mailbox = router.mailbox(ORIGIN);
		const lead = msg("긴 작업");
		const steer = msg("보충 지시");
		await router.route(lead);
		await router.route(steer);
		const driver = drivers[0] as QueuedAbortDriver;
		expect(driver.calls).toContain("steer:보충 지시");
		expect(store.getInbound(steer.platformMessageId)?.state).toBe("dispatched");
		driver.failTurn("agy rate limited (429): 쿼터 초과 (steer 1건 미전달)");
		await mailbox.sweepIdle();
		const deliveries = store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body);
		// One failure notice on the turn's thread; the steered row gets only the merge pointer quoting it.
		expect(deliveries.filter((body) => body.startsWith("[turn failed]"))).toEqual([
			"[turn failed] agy rate limited (429): 쿼터 초과 (steer 1건 미전달) — 공급자 한도입니다. 다시 보내거나 다른 모델로 `/model-jabbu`",
		]);
		expect(deliveries[1]).toStartWith("↪ 이 요청은 진행 중이던 작업에 합쳐져서");
		expect(deliveries[1]).toContain("(steer 1건 미전달)");
		expect(store.getInbound(lead.platformMessageId)?.state).toBe("failed_notified");
		expect(store.getInbound(steer.platformMessageId)?.state).toBe("failed_notified");
		await mailbox.sweepIdle();
		expect(store.listDeliveries({ originKey: ORIGIN })).toHaveLength(2); // no duplicate notice
	});

	test("owner !stop counts the still-queued steer in its answer, apart from the waiting rows, with no failure notice", async () => {
		const mailbox = router.mailbox(ORIGIN);
		const lead = msg("긴 작업");
		const steer = msg("보충 지시");
		const follow = msg("!followup 끝나고 할 일");
		await router.route(lead);
		await router.route(steer);
		await router.route(follow);
		const driver = drivers[0] as QueuedAbortDriver;
		expect(store.getInbound(steer.platformMessageId)?.state).toBe("dispatched"); // accepted as a steer
		expect(store.getInbound(follow.platformMessageId)?.state).toBe("pending"); // a followup is never steered
		await router.route(msg("!stop"));
		await mailbox.sweepIdle(); // runs the driver's abort final queued behind the stop
		// The driver did report the undelivered steer…
		expect(driver.emitted).toEqual([
			{
				opRef: driver.lastOpRef ?? "",
				status: "aborted",
				text: "",
				error: "cancelled (steer 1건 미전달)",
				droppedSteers: 1,
			},
		]);
		// …and the mailbox still settles the turn with its own owner-stop final (the driver's final is ignored)…
		expect(logLines.some((line) => line.includes("final_ignored"))).toBe(true);
		// …but its stop answer now counts the undelivered steer too, apart from the waiting rows.
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([
			`${OWNER_STOPPED_TEXT} 대기 1개를 취소했습니다. 아직 모델에 전달되지 않은 steer 1건도 취소했습니다.`,
		]);
		expect(store.getInbound(steer.platformMessageId)?.state).toBe("discarded");
	});

	test("a driver with abortAndClearQueue (real omp shape): the plain stop answer, no steer count", async () => {
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("긴 작업"));
		await router.route(msg("보충 지시"));
		const driver = drivers[0] as QueuedAbortDriver;
		driver.abortAndClearQueue = FakeOmpDriver.prototype.abortAndClearQueue.bind(driver);
		await router.route(msg("!stop"));
		await mailbox.sweepIdle();
		expect(driver.calls).toContain("abortAndClearQueue");
		expect(driver.calls).not.toContain("abort");
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([OWNER_STOPPED_TEXT]);
	});

	test("owner !stop with nothing queued: a bare cancelled, no note anywhere", async () => {
		const mailbox = router.mailbox(ORIGIN);
		await router.route(msg("긴 작업"));
		const driver = drivers[0] as QueuedAbortDriver;
		await router.route(msg("!stop"));
		await mailbox.sweepIdle();
		expect(driver.emitted).toEqual([
			{ opRef: driver.lastOpRef ?? "", status: "aborted", text: "", error: "cancelled" },
		]);
		expect(store.listDeliveries({ originKey: ORIGIN }).map((d) => d.body)).toEqual([OWNER_STOPPED_TEXT]);
	});
});
