// T-20261122-06: an owner answer carries the platform's answer id.
// The same id again changes nothing, another value on a card the owner already settled is an `answer_conflict`, and
// the ledger (not memory) decides, so a restart does not change the verdict.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import type { DiscordTransport } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { redact } from "../src/redact";
import {
	ApprovalBroker,
	type ApprovalStore,
	type ApprovalTimers,
	approvalActionId,
	CHOICE_ACTION_PREFIX,
} from "../src/safety/approval";
import { openStore, type Store } from "../src/store/db";
import { OWNER, OWNER_DM } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

let dir: string;
let store: Store;
let logs: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-answer-idempotency-"));
	logs = [];
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock: { now: () => 1_000 }, redact });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

class ManualTimers implements ApprovalTimers {
	readonly callbacks = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.callbacks.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.callbacks.values()]) fn();
	}
}

/** A fake Discord whose first card's id is known once its buttons are up. */
class CardTransport extends FakeDiscordTransport {
	readonly shown = Promise.withResolvers<string>();
	override async editMessage(args: Parameters<FakeDiscordTransport["editMessage"]>[0]): Promise<void> {
		await super.editMessage(args);
		if (args.components !== undefined && args.components.length > 0) this.shown.resolve(args.messageId);
	}
	/** Resolves with the text of the conflict notice ("이미 … 처리됨") once it is posted. */
	readonly noticed = Promise.withResolvers<string>();
	override async createMessage(args: Parameters<FakeDiscordTransport["createMessage"]>[0]): Promise<{ id: string }> {
		const posted = await super.createMessage(args);
		if (args.content?.startsWith("이미 ") === true) this.noticed.resolve(args.content);
		return posted;
	}
}

function makeBroker(transport: DiscordTransport, timers: ApprovalTimers): ApprovalBroker {
	return new ApprovalBroker({
		timezone: "Asia/Seoul",
		channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
		ownerUserId: OWNER,
		log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
		store: store as unknown as ApprovalStore,
		clock: { now: () => 1_000 },
		timers,
	});
}

const click = (broker: ApprovalBroker, decision: "approve" | "deny", ts: string, answerId?: string): boolean =>
	broker.handleAction({ actionId: approvalActionId(decision, OWNER_DM, ts), userId: OWNER, answerId });

type AnswerRow = { answer_id: string; value: string; verdict: string };

const answerRows = (): AnswerRow[] => {
	const db = new Database(join(dir, "jabbu.db"), { readonly: true });
	try {
		return db
			.query("SELECT answer_id, value, verdict FROM card_answers ORDER BY created_at, rowid")
			.all() as AnswerRow[];
	} finally {
		db.close();
	}
};

const conflictsLogged = (): number => logs.filter((line) => line.includes("answer_conflict")).length;

describe("answer idempotency", () => {
	test("AC-3: the same answer id again changes nothing; the first answer stands", async () => {
		const transport = new CardTransport();
		const broker = makeBroker(transport, new ManualTimers());
		const done = broker.request(OWNER_DM, "git push");
		const ts = await transport.shown.promise;
		expect(click(broker, "approve", ts, "i-1")).toBe(true);
		expect(await done).toBe("approved");
		expect(click(broker, "approve", ts, "i-1")).toBe(true);
		expect(click(broker, "approve", ts, "i-2")).toBe(true);
		expect(store.getApproval(`${OWNER_DM}:${ts}`)?.status).toBe("approved");
		expect(answerRows()).toEqual([{ answer_id: "i-1", value: "approved", verdict: "accepted" }]);
		expect(conflictsLogged()).toBe(0);
	});

	test("AC-3: another value on a settled card is an answer_conflict that changes nothing and says so", async () => {
		const transport = new CardTransport();
		const broker = makeBroker(transport, new ManualTimers());
		const done = broker.request(OWNER_DM, "git push");
		const ts = await transport.shown.promise;
		click(broker, "approve", ts, "i-1");
		expect(await done).toBe("approved");
		expect(click(broker, "deny", ts, "i-3")).toBe(true);
		expect(store.getApproval(`${OWNER_DM}:${ts}`)?.status).toBe("approved");
		expect(answerRows()).toEqual([
			{ answer_id: "i-1", value: "approved", verdict: "accepted" },
			{ answer_id: "i-3", value: "denied", verdict: "conflict" },
		]);
		expect(conflictsLogged()).toBe(1);
		expect(await transport.noticed.promise).toContain("이미 승인으로 처리됨");
		// The same conflicting click redelivered is a duplicate of the refused one: no second event.
		expect(click(broker, "deny", ts, "i-3")).toBe(true);
		expect(conflictsLogged()).toBe(1);
	});

	test("AC-3: after a restart the ledger gives the same verdicts", async () => {
		const transport = new CardTransport();
		const first = makeBroker(transport, new ManualTimers());
		const done = first.request(OWNER_DM, "git push");
		const ts = await transport.shown.promise;
		click(first, "deny", ts, "i-1");
		expect(await done).toBe("denied");
		// New process: a new broker over the same database file has no pending card in memory.
		const reopened = openStore({
			timezone: "Asia/Seoul",
			path: join(dir, "jabbu.db"),
			clock: { now: () => 2_000 },
			redact,
		});
		const second = new ApprovalBroker({
			timezone: "Asia/Seoul",
			channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
			ownerUserId: OWNER,
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => 0 }, redact }),
			store: reopened as unknown as ApprovalStore,
			clock: { now: () => 2_000 },
			timers: new ManualTimers(),
		});
		expect(click(second, "deny", ts, "i-1")).toBe(true);
		expect(click(second, "deny", ts, "i-9")).toBe(true);
		expect(conflictsLogged()).toBe(0);
		expect(click(second, "approve", ts, "i-10")).toBe(true);
		expect(conflictsLogged()).toBe(1);
		expect(reopened.getApproval(`${OWNER_DM}:${ts}`)?.status).toBe("denied");
		reopened.close();
	});

	test("AC-3: a card that timed out was not settled by the owner: a late click is no conflict", async () => {
		const transport = new CardTransport();
		const timers = new ManualTimers();
		const broker = makeBroker(transport, timers);
		const done = broker.request(OWNER_DM, "git push");
		const ts = await transport.shown.promise;
		timers.fireAll();
		expect(await done).toBe("timeout");
		expect(click(broker, "approve", ts, "i-late")).toBe(false);
		expect(answerRows()).toEqual([]);
		expect(conflictsLogged()).toBe(0);
	});

	test("AC-3: a click without an answer id is judged by the card alone, as before", async () => {
		const transport = new CardTransport();
		const broker = makeBroker(transport, new ManualTimers());
		const done = broker.request(OWNER_DM, "git push");
		const ts = await transport.shown.promise;
		expect(click(broker, "approve", ts)).toBe(true);
		expect(await done).toBe("approved");
		expect(click(broker, "deny", ts)).toBe(false);
		expect(answerRows()).toEqual([]);
	});

	test("AC-3: a choice card takes a redelivered click once; after the owner's pick another button is a conflict", async () => {
		const transport = new CardTransport();
		const broker = makeBroker(transport, new ManualTimers());
		const origin = { originKey: `discord/dm/${OWNER_DM}`, channel: OWNER_DM };
		const handle = await broker.choose(origin, { text: "❓ 어느 쪽?", buttons: ["A", "B"], fallback: "A" });
		const ts = await transport.shown.promise;
		const choiceClick = (index: number, answerId: string): boolean =>
			broker.handleAction({
				actionId: `${CHOICE_ACTION_PREFIX}:${index}:${OWNER_DM}:${ts}`,
				userId: OWNER,
				answerId,
			});
		expect(choiceClick(0, "c-1")).toBe(true);
		expect(choiceClick(0, "c-1")).toBe(true);
		expect(await handle.next()).toEqual({ kind: "choice", index: 0 });
		await handle.close("A로 처리", "A");
		expect(store.getApproval(`${OWNER_DM}:${ts}`)?.status).toBe("replied");
		expect(choiceClick(1, "c-2")).toBe(true);
		expect(conflictsLogged()).toBe(1);
		expect(answerRows()).toEqual([
			{ answer_id: "c-1", value: "choice:0", verdict: "accepted" },
			{ answer_id: "c-2", value: "choice:1", verdict: "conflict" },
		]);
	});
});
