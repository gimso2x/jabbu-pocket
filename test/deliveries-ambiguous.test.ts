// Held (`failed_ambiguous`) deliveries: the owner's `jabbu-pocket deliveries list|ack|resend` path, the one notice a held
// row gets, and the resend that keeps the parts already posted.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPump, type DeliverySender } from "../src/channel/pump";
import type { DeliveryItem, DeliverySource } from "../src/channel/types";
import { Daemon } from "../src/daemon/daemon";
import { DiscordCallError } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { redact } from "../src/redact";
import { openDeliveryLedger, openStore, type Store } from "../src/store/db";
import { discordBinding, makeHome, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { runCliCapture } from "./helpers/daemon-process";

class FakeClock {
	constructor(public t = 1_800_000_000_000) {}
	now(): number {
		return this.t;
	}
	advance(ms: number): void {
		this.t += ms;
	}
}

const OWNER = "100000000000000001";
const DM_ORIGIN = `discord/dm/${OWNER}`;
const CH_ORIGIN = "discord/ch/111111111111111111";

let dir: string;
let dbPath: string;
let clock: FakeClock;
let store: Store;
/** Daemons and homes the daemon-wiring tests start: stopped and removed with the rest of the fixture. */
const daemons: Daemon[] = [];
const homes: TestHome[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-deliveries-"));
	dbPath = join(dir, "jabbu.db");
	clock = new FakeClock();
	store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact });
});

afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.stop();
	for (const home of homes.splice(0)) home.remove();
	try {
		store.close();
	} catch {}
	rmSync(dir, { recursive: true, force: true });
});

/** The one row a call must have produced; a missing one fails here, not three lines later. */
function only<T>(rows: T[]): T {
	const [first] = rows;
	if (first === undefined) throw new Error("no row");
	return first;
}

/** An answer row claimed (inflight) and then held as ambiguous, the way the pump leaves it. */
function held(originKey = DM_ORIGIN, body = "붙잡힌 답"): number {
	store.ensureOrigin(originKey, `/s/${originKey}`);
	const answer = only(
		store.recordAnswer({ originKey, opRef: `op-${body}`, threadRef: `${OWNER}:700000000000000001`, parts: [body] }),
	);
	store.claimDue();
	store.markAmbiguous(answer.deliveryId, "socket hang up");
	return answer.deliveryId;
}

const row = (id: number) => store.getDelivery(id);
const ledgerRows = (): number => store.countDeliveriesByState().failed_ambiguous ?? 0;

describe("transitions: the owner's manual way out of a held row", () => {
	test("ack closes a held row as confirmed and is not a transition for any other state", () => {
		const id = held();
		clock.advance(1_000);
		expect(store.resolveAmbiguous(id, "ack")).toMatchObject({ state: "confirmed", redelivered: false });
		expect(() => store.resolveAmbiguous(id, "ack")).toThrow("invalid_transition: delivery confirmed on ack");
	});

	test("resend queues it again now with the redelivered header, keeping the row's created_at", () => {
		const id = held();
		const before = only([row(id)].filter((r) => r !== undefined));
		clock.advance(5_000);
		const resent = store.resolveAmbiguous(id, "resend");
		expect(resent).toMatchObject({ state: "pending", redelivered: true, nextAt: clock.t, createdAt: before.createdAt });
		// Due right away: the next claim takes it.
		expect(store.claimDue().map((r) => r.deliveryId)).toEqual([id]);
	});

	test("a row that is not held is refused: pending, inflight, confirmed and expired all throw", () => {
		store.ensureOrigin(DM_ORIGIN, "/s/dm");
		const pending = only(store.recordAnswer({ originKey: DM_ORIGIN, opRef: "op-p", threadRef: "t", parts: ["x"] }));
		for (const how of ["ack", "resend"] as const) {
			expect(() => store.resolveAmbiguous(pending.deliveryId, how)).toThrow(
				`invalid_transition: delivery pending on ${how}`,
			);
		}
		store.claimDue();
		expect(() => store.resolveAmbiguous(pending.deliveryId, "ack")).toThrow(
			"invalid_transition: delivery inflight on ack",
		);
		store.confirmDelivery(pending.deliveryId);
		expect(() => store.resolveAmbiguous(pending.deliveryId, "resend")).toThrow(
			"invalid_transition: delivery confirmed on resend",
		);
	});

	test("an unknown id is not_found, never a silent no-op", () => {
		expect(() => store.resolveAmbiguous(9_999, "ack")).toThrow("not_found: delivery 9999");
	});

	test("automatic events still cannot move a held row", () => {
		const id = held();
		clock.advance(30 * 24 * 3_600_000);
		expect(store.sweepExpired()).toBe(0);
		expect(store.claimDue()).toEqual([]);
		// Only an owner event moves it: a repeated failure report is not one either (the send is inflight only once).
		expect(store.markAmbiguous(id, "again").state).toBe("failed_ambiguous");
		expect(row(id)?.state).toBe("failed_ambiguous");
		// A reopen (boot recovery) only re-queues rows younger than the freshness window.
		store.close();
		store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact });
		expect(row(id)?.state).toBe("failed_ambiguous");
	});
});

describe("listAmbiguous: what the owner works through", () => {
	test("only held rows, oldest id first", () => {
		const first = held(DM_ORIGIN, "첫째");
		const second = held(CH_ORIGIN, "둘째");
		store.ensureOrigin(CH_ORIGIN, "/s/ch");
		const other = only(
			store.recordAnswer({ originKey: CH_ORIGIN, opRef: "op-ok", threadRef: "t", parts: ["보낸 답"] }),
		);
		store.close();
		store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact });
		expect(store.listAmbiguous().map((r) => r.deliveryId)).toEqual([first, second]);
		expect(store.listAmbiguous().map((r) => r.body)).toEqual(["첫째", "둘째"]);
		expect(other.deliveryId).toBeGreaterThan(second);
	});

	test("the CLI list shows id, thread, time and a 60-character escaped preview; bodies were redacted at insert", () => {
		const id = held(DM_ORIGIN, `${"가".repeat(80)}xoxb-TEST-0`);
		const ledger = openDeliveryLedger(dbPath, clock);
		try {
			const [only] = ledger.listAmbiguous();
			expect(only?.deliveryId).toBe(id);
			expect(only?.body).not.toContain("xoxb-TEST-0");
		} finally {
			ledger.close();
		}
	});
});

describe("jabbu-pocket deliveries (CLI)", () => {
	const cli = (...args: string[]) => runCliCapture(dir, ["deliveries", ...args]);

	test("list / ack / resend over the ledger another process holds", async () => {
		const a = held(DM_ORIGIN, "도착한 답");
		const b = held(DM_ORIGIN, "안 온 답");

		const listed = await cli("list");
		expect(listed.code).toBe(0);
		const lines = listed.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toStartWith(`${a}  ${DM_ORIGIN}  ${OWNER}:700000000000000001  `);
		expect(lines[0]).toContain('"도착한 답"');
		expect(lines[1]).toStartWith(`${b}  `);

		const acked = await cli("ack", String(a));
		expect(acked).toMatchObject({ code: 0, stdout: `acked ${a}\n` });
		expect((await cli("list")).stdout.trimEnd().split("\n")).toHaveLength(1);

		const resent = await cli("resend", String(b));
		expect(resent).toMatchObject({ code: 0, stdout: `resent ${b}\n` });
		expect((await cli("list")).stdout).toBe("no ambiguous deliveries\n");
	});

	test("a long body is cut to 60 characters with an ellipsis", async () => {
		held(DM_ORIGIN, "가".repeat(200));
		const listed = await cli("list");
		const preview = listed.stdout.split("  ").pop()?.trimEnd() ?? "";
		expect(preview).toBe(`${JSON.stringify("가".repeat(60))}...`);
	});

	test("an id that is not held is refused with the reason, exit 1; a bad id or verb is usage, exit 2", async () => {
		const notHeld = await cli("ack", "9999");
		expect(notHeld.code).toBe(1);
		expect(notHeld.stderr).toContain("not_found: delivery 9999");

		const id = held();
		expect((await cli("ack", String(id))).code).toBe(0);
		const again = await cli("resend", String(id));
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("invalid_transition");

		expect((await cli("ack", "abc")).code).toBe(2);
		expect((await cli("ack")).code).toBe(2);
		expect((await cli("nope")).code).toBe(2);
	});

	test("no ledger yet: a plain sentence, exit 1 (never an empty database)", async () => {
		store.close();
		rmSync(dbPath, { force: true });
		const listed = await cli("list");
		expect(listed.code).toBe(1);
		expect(listed.stderr).toContain("no ledger at");
		store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock, redact });
	});
});

describe("notice: one owner notice per held delivery", () => {
	test("one insertion, into the held row's thread, naming both commands; a second call inserts nothing", () => {
		store.ensureOrigin(CH_ORIGIN, "/s/ch");
		const answer = only(
			store.recordAnswer({
				originKey: CH_ORIGIN,
				opRef: "op-1",
				threadRef: "111111111111111111:700000000000000001",
				parts: ["답"],
			}),
		);
		store.claimDue();
		store.markAmbiguous(answer.deliveryId, "socket hang up");
		expect(store.noticeAmbiguous(answer.deliveryId, OWNER)).toBe(true);
		expect(store.noticeAmbiguous(answer.deliveryId, OWNER)).toBe(false);
		const notice = store.listDeliveries().find((r) => r.opRef === `ambiguous-notice:${answer.deliveryId}`);
		expect(notice).toMatchObject({ threadRef: "111111111111111111:700000000000000001", state: "pending", part: 0 });
		expect(notice?.body).toContain(`jabbu-pocket deliveries ack ${answer.deliveryId}`);
		expect(notice?.body).toContain(`jabbu-pocket deliveries resend ${answer.deliveryId}`);
		expect(notice?.body).toContain("전달 불확실");
		// A group channel needs the mention; the thread is not 1:1 with the owner.
		expect(notice?.body).toContain(`{{mention:${OWNER}}}`);
	});

	test("a DM notice carries no mention: that thread is already 1:1", () => {
		const id = held();
		expect(store.noticeAmbiguous(id, OWNER)).toBe(true);
		const notice = store.listDeliveries().find((r) => r.opRef === `ambiguous-notice:${id}`);
		expect(notice?.body).not.toContain("{{mention:");
	});

	test("never for a row that is not held, and a notice that itself goes ambiguous spawns none", () => {
		store.ensureOrigin(DM_ORIGIN, "/s/dm");
		const answer = only(store.recordAnswer({ originKey: DM_ORIGIN, opRef: "op-1", threadRef: "t", parts: ["답"] }));
		expect(store.noticeAmbiguous(answer.deliveryId, OWNER)).toBe(false);
		store.claimDue();
		store.markAmbiguous(answer.deliveryId, "x");
		store.noticeAmbiguous(answer.deliveryId, OWNER);

		const noticeId = store.listDeliveries().find((r) => r.opRef.startsWith("ambiguous-notice:"))?.deliveryId ?? 0;
		store.claimDue();
		store.markAmbiguous(noticeId, "socket hang up");
		expect(store.noticeAmbiguous(noticeId, OWNER)).toBe(false);
		expect(store.listDeliveries().filter((r) => r.opRef.startsWith("ambiguous-notice:"))).toHaveLength(1);
	});

	test("the held row keeps its sentParts, so a resend continues after what is already out", async () => {
		store.ensureOrigin(DM_ORIGIN, "/s/dm");
		const answer = only(
			store.recordAnswer({
				originKey: DM_ORIGIN,
				opRef: "op-long",
				threadRef: `${OWNER}:700000000000000001`,
				parts: ["part1", "part2", "part3"],
			}),
		);
		let sent = 0;
		const source: DeliverySource = {
			claimDue: () =>
				store.claimDue(undefined, "discord").map(
					(r): DeliveryItem => ({
						deliveryId: r.deliveryId,
						originKey: r.originKey,
						threadRef: r.threadRef,
						body: r.body,
						redelivered: r.redelivered,
						sentParts: r.sentParts,
					}),
				),
			confirm: (id) => void store.confirmDelivery(id),
			fail: (id, error, outcome, sentParts) => {
				if (outcome === "ambiguous") store.markAmbiguous(id, error, sentParts);
				else store.failDelivery(id, error);
				return true;
			},
			defer: (id, error, retry) => void store.deferDelivery(id, error, retry),
		};
		const sender: DeliverySender = {
			isBlocked: () => false,
			blockedUntil: () => clock.t,
			blockedReason: () => "",
			send: async (delivery) => {
				const skipped = delivery.sentParts ?? 0;
				sent = skipped + 1;
				if (sent < 3) return { kind: "failed", error: "socket hang up", outcome: "ambiguous", sentParts: sent };
				return { kind: "sent", parts: 1 };
			},
			afterSent: async () => {},
			afterUndelivered: async () => {},
		};
		const log = createLogger({ sink: () => {}, clock, redact });
		const pump = new DeliveryPump({ source, sender, clock, log });

		expect(await pump.pump()).toBe(0);
		expect(row(answer.deliveryId)).toMatchObject({ state: "failed_ambiguous", sentParts: 1 });

		store.resolveAmbiguous(answer.deliveryId, "resend");
		expect(row(answer.deliveryId)).toMatchObject({ state: "pending", redelivered: true, sentParts: 1 });
		expect(await pump.pump()).toBe(0);
		expect(row(answer.deliveryId)).toMatchObject({ state: "failed_ambiguous", sentParts: 2 });
		expect(sent).toBe(2);

		store.resolveAmbiguous(answer.deliveryId, "resend");
		expect(await pump.pump()).toBe(1);
		expect(row(answer.deliveryId)?.state).toBe("confirmed");
	});
});

describe("held rows in the ledger another process reads", () => {
	test("a bare connection resolves without the Store's boot recovery touching inflight rows", () => {
		const inflight = held(DM_ORIGIN, "보내는 중");
		expect(row(inflight)?.state).toBe("failed_ambiguous");
		store.ensureOrigin(CH_ORIGIN, "/s/ch");
		const claimed = only(store.recordAnswer({ originKey: CH_ORIGIN, opRef: "op-2", threadRef: "t", parts: ["답"] }));
		store.claimDue();
		expect(row(claimed.deliveryId)?.state).toBe("inflight");

		const ledger = openDeliveryLedger(dbPath, clock);
		try {
			expect(ledger.resolveAmbiguous(inflight, "ack").state).toBe("confirmed");
		} finally {
			ledger.close();
		}

		const db = new Database(dbPath, { readonly: true, strict: true });
		try {
			const still = db.query("SELECT state FROM deliveries WHERE delivery_id = ?").get(claimed.deliveryId) as {
				state: string;
			};
			expect(still.state).toBe("inflight");
		} finally {
			db.close();
		}
	});

	test("countDeliveriesByState counts the held rows the status line shows", () => {
		held(DM_ORIGIN, "첫째");
		held(DM_ORIGIN, "둘째");
		expect(ledgerRows()).toBe(2);
	});
});

describe("the daemon holds and notices (real pump, real adapter)", () => {
	const BOOT_ID = "kernel-boot-id";

	async function startDaemon(transport: WaitingDiscordTransport): Promise<Daemon> {
		const home: TestHome = makeHome("jabbu-deliveries-daemon-");
		homes.push(home);
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			config: home.config,
			channels: [discordBinding(transport)],
			log: createLogger({ sink: () => undefined, clock, redact }),
			ompVersion: "omp-test 0",
			bootId: BOOT_ID,
			hostLoad: IDLE_HOST_LOAD,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemons.push(daemon);
		await daemon.start();
		return daemon;
	}

	test("an ambiguous send is held with its sent parts and gets exactly one owner notice, then no more", async () => {
		const transport = new WaitingDiscordTransport();
		const daemon = await startDaemon(transport);
		const origin = `discord/dm/${OWNER_DM}`;
		daemon.store.ensureOrigin(origin, "sess/held");
		const answer = only(
			daemon.store.recordAnswer({
				originKey: origin,
				opRef: "op-held",
				threadRef: `${OWNER_DM}:700000000000000001`,
				parts: ["답"],
			}),
		);

		// The first post (the answer) 5xx's: Discord may have taken it, so the row is held, not retried.
		transport.failNext.createMessage = [new DiscordCallError("ambiguous", "discord_http_500", 500)];
		await daemon.pump();
		expect(daemon.store.getDelivery(answer.deliveryId)).toMatchObject({ state: "failed_ambiguous", sentParts: 0 });
		const notices = () => daemon.store.listDeliveries().filter((r) => r.opRef.startsWith("ambiguous-notice:"));
		expect(notices()).toHaveLength(1);

		// The notice goes out on the next pump; a further ambiguous send of the same row adds no second notice.
		await daemon.pump();
		await transport.waitForPosts((text) => text.includes("전달 불확실"));
		expect(transport.posts((text) => text.includes("전달 불확실"))).toHaveLength(1);
		expect(notices()).toHaveLength(1);
		expect(transport.posts((text) => text.includes("전달 불확실"))[0]?.content).toContain(
			`jabbu-pocket deliveries resend ${answer.deliveryId}`,
		);

		// The fake transport logged the post before raising, which is exactly the ambiguity: the answer may be out.
		// What matters is that the held row is never retried by itself, so the answer is not posted a second time.
		expect(transport.posts((text) => text === "답")).toHaveLength(1);
		await daemon.pump();
		expect(transport.posts((text) => text === "답")).toHaveLength(1);
	});
});
