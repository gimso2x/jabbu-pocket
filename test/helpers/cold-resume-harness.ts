import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColdCacheInfo } from "../../src/core/mailbox";
import { OriginRouter, openBotStore, sessionDirFor } from "../../src/core/origin";
import type { InboundRecord } from "../../src/core/types";
import { createLogger } from "../../src/log";
import type { OmpEvent } from "../../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../../src/omp/fake-driver";
import { recordSpawnPrompt } from "../../src/ops/cache-miss-cause";
import { redact } from "../../src/redact";
import type { Store } from "../../src/store/db";

export const MIN = 60_000;
export const ORIGIN = "discord/dm/200000000000000001";
export const MODEL = "claude-opus-5-5";

export class FakeClock {
	t = 1_000_000_000;
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

/** omp's `message_end` of an assistant call with its usage. */
export const usageEvent = (cacheRead: number, cacheWrite: number): OmpEvent => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		provider: "anthropic",
		model: MODEL,
		usage: { input: 3, output: 5, cacheRead, cacheWrite, cost: { cacheWrite: cacheWrite * 6.25e-6 } },
	},
});

let counter = 0;
export function msg(text: string, originKey = ORIGIN): InboundRecord {
	const id = `cr${++counter}`;
	return { platformMessageId: id, originKey, ownerVerified: true, text, threadRef: id };
}

export interface RouterKnobs {
	/** Omitted: the mailbox gets no `coldResumeRotateTokens` option at all. */
	tokens?: number;
}

/**
 * A router over a real sqlite store and sessions root with `FakeOmpDriver` children that report `events` as each
 * turn's assistant calls. The driver factory records spawn prompt hashes like the daemon's `bot-driver`, so `rebuild`
 * (a new router over the same store and session dirs) stands in for a daemon restart.
 */
export class ColdResumeHarness {
	readonly dir = mkdtempSync(join(tmpdir(), "jabbu-cold-resume-"));
	readonly clock = new FakeClock();
	readonly store: Store = openBotStore(join(this.dir, "jabbu.db"), this.clock, "Asia/Seoul");
	readonly sessionsRoot = join(this.dir, "sessions");
	readonly sessionStore = new FakeSessionStore();
	readonly drivers: FakeOmpDriver[] = [];
	readonly factoryDirs: string[] = [];
	readonly logLines: string[] = [];
	readonly rotated: ColdCacheInfo[] = [];
	readonly coldCaches: ColdCacheInfo[] = [];
	events: OmpEvent[] = [];
	/** What the stand-in `bot-driver` hashes at each spawn. */
	spawnPrompt = "spawn prompt v1";
	/** The assistant text each turn answers with; absent: the fake driver's echo. */
	respond: ((prompt: string) => string) | undefined;
	/** Runs at each spawn, after the mailbox read the session dir and before the child starts (omp writing its first records). */
	onSpawn: ((sessionDir: string) => void) | undefined;
	router!: OriginRouter;

	constructor(knobs: RouterKnobs = {}) {
		this.rebuild(knobs);
	}

	/** A new router and so new mailboxes (no memory of the old ones), the same store and session directories. */
	rebuild(knobs: RouterKnobs = {}): void {
		void this.router?.close();
		this.router = new OriginRouter({
			timezone: "Asia/Seoul",
			store: this.store,
			clock: this.clock,
			sessionsRoot: this.sessionsRoot,
			log: createLogger({ sink: (line) => this.logLines.push(line), clock: this.clock, redact }),
			statusProvider: () => "status: ok",
			onColdCache: (info) => this.coldCaches.push(info),
			onColdResumeRotated: (info) => this.rotated.push(info),
			...(knobs.tokens === undefined ? {} : { coldResumeRotateTokens: () => knobs.tokens ?? 0 }),
			driverFactory: (_origin, sessionDir) => {
				recordSpawnPrompt(sessionDir, this.spawnPrompt);
				this.factoryDirs.push(sessionDir);
				this.onSpawn?.(sessionDir);
				const driver = new FakeOmpDriver({
					sessionDir,
					store: this.sessionStore,
					holdTurns: true,
					events: this.events,
					...(this.respond === undefined ? {} : { respond: this.respond }),
				});
				this.drivers.push(driver);
				return driver;
			},
		});
	}

	sessionDir(origin: string, epoch: number): string {
		return sessionDirFor(this.sessionsRoot, origin, epoch);
	}

	/** A saved session of `origin` epoch 1 (in the fake store) whose last entry is an assistant call at `at`. */
	seedSession(origin: string, at: number, usage: { cacheRead: number; cacheWrite: number }): void {
		const sessionDir = this.sessionDir(origin, 1);
		this.sessionStore.open(sessionDir);
		const session = this.sessionStore.sessions.get(sessionDir);
		if (session === undefined) throw new Error("no session");
		session.entries.push({
			id: "e3",
			parentId: "e2",
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "이전 답" }],
				stopReason: "stop",
				provider: "anthropic",
				model: MODEL,
				usage: { input: 3, output: 5, ...usage, cost: { cacheWrite: usage.cacheWrite * 6.25e-6 } },
			},
		});
		session.nextId = 4;
	}

	/** One finished turn: its usage events and final are handled, and its delivery is confirmed (an exchange of the epoch). */
	async turn(text: string, origin = ORIGIN): Promise<InboundRecord> {
		const record = msg(text, origin);
		await this.router.route(record);
		const driver = this.drivers.at(-1);
		if (driver === undefined) throw new Error("no driver");
		const seen = new Promise<void>((resolve) => {
			const off = driver.onFinal(() => {
				off();
				resolve();
			});
		});
		driver.release();
		await seen;
		await this.router.mailbox(origin).sweepIdle(); // runs behind the final handler on the actor's chain
		for (const delivery of this.store.listDeliveries({ originKey: origin })) {
			if (delivery.state !== "pending") continue;
			this.store.claimDue();
			this.store.confirmDelivery(delivery.deliveryId);
		}
		return record;
	}

	logs(event: string): string[] {
		return this.logLines.filter((line) => line.includes(`event=${event}`));
	}

	async close(): Promise<void> {
		await this.router.close();
		this.store.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}
