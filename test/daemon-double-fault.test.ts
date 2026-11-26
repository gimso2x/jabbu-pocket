// Muse-style double-fault drills around lane settle and boot recovery: when BOTH the settle write and its
// compensating discard throw (a locked DB), the row must survive dispatched for the next boot, and when the
// recovery settle write itself throws, no notice may go out before the write succeeds. Complements the
// single-fault "lane settle failure" describe in daemon.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { INTERRUPTED_NOTICE } from "../src/daemon/recovery";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	discordBinding,
	makeHome,
	OWNER_DM,
	ownerMessage,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const BOOT_ID = "kernel-boot-id";
const clock = { now: () => Date.now() };
const MSG = (n: number): string => `70000000000000000${n}`;

let home: TestHome;
let sessions: FakeSessionStore;
let daemons: Daemon[];

beforeEach(() => {
	home = makeHome("jabbu-double-fault-");
	sessions = new FakeSessionStore();
	daemons = [];
});

afterEach(async () => {
	for (const daemon of daemons) await daemon.stop();
	home.remove();
});

function logTap(): { lines: string[]; sink: (line: string) => void; until(needle: string): Promise<void> } {
	const lines: string[] = [];
	const waiters = new Set<() => void>();
	return {
		lines,
		sink: (line) => {
			lines.push(line);
			for (const wake of [...waiters]) wake();
		},
		until(needle) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const check = (): void => {
				if (!lines.some((line) => line.includes(needle))) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			};
			const timer = setTimeout(() => {
				waiters.delete(check);
				reject(new Error(`log line never appeared: ${needle}`));
			}, 5_000);
			waiters.add(check);
			check();
			return promise;
		},
	};
}

function newDaemon(transport: WaitingDiscordTransport, tap: ReturnType<typeof logTap>): Daemon {
	const daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [discordBinding(transport)],
		log: createLogger({ sink: tap.sink, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: BOOT_ID,
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	daemons.push(daemon);
	return daemon;
}

/** Boot 1: a lane trigger whose recordAnswer AND discard both throw leaves the row dispatched. */
async function stickLaneRow(transport: WaitingDiscordTransport, tap: ReturnType<typeof logTap>): Promise<Daemon> {
	const daemon = newDaemon(transport, tap);
	await daemon.start();
	const store = daemon.store;
	const recordAnswer = store.recordAnswer.bind(store);
	store.recordAnswer = (input) => {
		if (input.opRef.startsWith("lane:")) throw new Error("database is locked");
		return recordAnswer(input);
	};
	const discard = store.discard.bind(store);
	store.discard = (id) => {
		if (id === `${OWNER_DM}:${MSG(6)}`) throw new Error("database is locked");
		return discard(id);
	};
	await transport.emitMessage(ownerMessage(MSG(6), "작업: 고착 확인 @/nonexistent/repo"));
	await tap.until("event=lane_settle_failed");
	await tap.until("event=lane_settle_discard_failed");
	return daemon;
}

describe("on-call double-fault drill: lane settle fails AND its discard fails", () => {
	test("the row stays dispatched, the process lives, and the next boot settles it with one interrupted notice", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const transport = new WaitingDiscordTransport();
			const tap = logTap();
			const daemon = await stickLaneRow(transport, tap);
			expect(daemon.store.getInbound(`${OWNER_DM}:${MSG(6)}`)?.state).toBe("dispatched");
			expect(rejections).toEqual([]);
			await daemon.stop();

			const transport2 = new WaitingDiscordTransport();
			const tap2 = logTap();
			const daemon2 = newDaemon(transport2, tap2);
			await daemon2.start();
			await transport2.waitForPosts((text) => text.includes(INTERRUPTED_NOTICE));
			expect(tap2.lines.some((line) => line.includes("event=recovery_interrupted") && line.includes("lane:"))).toBe(
				true,
			);
			expect(daemon2.store.getInbound(`${OWNER_DM}:${MSG(6)}`)?.state).toBe("failed_notified");
			expect(transport2.posts((text) => text.includes(INTERRUPTED_NOTICE))).toHaveLength(1);
			await daemon2.stop();

			const transport3 = new WaitingDiscordTransport();
			const tap3 = logTap();
			const daemon3 = newDaemon(transport3, tap3);
			await daemon3.start();
			// sleep-ok: give a wrongful repeat notice a beat to appear before asserting silence
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(transport3.posts((text) => text.includes(INTERRUPTED_NOTICE))).toHaveLength(0);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});

describe("on-call drill: the recovery settle write itself throws", () => {
	test("a recordTurnFailure that throws during boot recovery sends no notice; the NEXT boot settles it once", async () => {
		const transport = new WaitingDiscordTransport();
		const tap = logTap();
		const daemon = await stickLaneRow(transport, tap);
		await daemon.stop();

		// Boot 2 with the settle write itself failing: no notice may go out, the row stays dispatched.
		const proto = Object.getPrototypeOf(daemon.store) as { recordTurnFailure: (...args: unknown[]) => unknown };
		const real = proto.recordTurnFailure;
		let armed = true;
		proto.recordTurnFailure = function (...args: unknown[]) {
			if (armed) {
				armed = false;
				throw new Error("database is locked");
			}
			return real.apply(this, args);
		};
		const transport2 = new WaitingDiscordTransport();
		const tap2 = logTap();
		try {
			const daemon2 = newDaemon(transport2, tap2);
			await daemon2.start();
			await tap2.until("event=recovery_origin_failed");
			expect(
				tap2.lines.some((line) => line.includes("event=recovery_origin_failed") && line.includes("database is locked")),
			).toBe(true);
			expect(transport2.posts((text) => text.includes(INTERRUPTED_NOTICE))).toHaveLength(0);
			expect(daemon2.store.getInbound(`${OWNER_DM}:${MSG(6)}`)?.state).toBe("dispatched");
			await daemon2.stop();
		} finally {
			proto.recordTurnFailure = real;
		}

		// Boot 3 with the write healthy again: exactly one notice, row terminally settled.
		const transport3 = new WaitingDiscordTransport();
		const tap3 = logTap();
		const daemon3 = newDaemon(transport3, tap3);
		await daemon3.start();
		await transport3.waitForPosts((text) => text.includes(INTERRUPTED_NOTICE));
		expect(daemon3.store.getInbound(`${OWNER_DM}:${MSG(6)}`)?.state).toBe("failed_notified");
		expect(transport3.posts((text) => text.includes(INTERRUPTED_NOTICE))).toHaveLength(1);
	});
});
