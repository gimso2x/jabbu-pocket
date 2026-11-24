// T-20261124-14: the broker tells the daemon when the owner's answer closed a card, and
// never for a timeout, a cancel or an abort. The adapter side (`resumeTyping`) is in discord-adapter.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
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

/** Resolves with the card id once its buttons are up. */
class CardTransport extends FakeDiscordTransport {
	shown = Promise.withResolvers<string>();
	override async editMessage(args: Parameters<FakeDiscordTransport["editMessage"]>[0]): Promise<void> {
		await super.editMessage(args);
		if (args.components !== undefined && args.components.length > 0) this.shown.resolve(args.messageId);
	}
}

const THREAD = "9001";
const origin = { originKey: `discord/dm/${OWNER_DM}`, channel: OWNER_DM, threadTs: THREAD };

let dir: string;
let store: Store;
let transport: CardTransport;
let timers: ManualTimers;
let answered: Array<{ originKey: string; threadRef: string }>;
let broker: ApprovalBroker;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-ask-click-typing-"));
	store = openStore({ timezone: "Asia/Seoul", path: join(dir, "jabbu.db"), clock: { now: () => 1_000 }, redact });
	transport = new CardTransport();
	timers = new ManualTimers();
	answered = [];
	broker = new ApprovalBroker({
		timezone: "Asia/Seoul",
		channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
		ownerUserId: OWNER,
		log: createLogger({ sink: () => {}, clock: { now: () => 0 }, redact }),
		store: store as unknown as ApprovalStore,
		clock: { now: () => 1_000 },
		timers,
		onOwnerAnswered: (info) => answered.push(info),
	});
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const expected = [{ originKey: origin.originKey, threadRef: `${OWNER_DM}:${THREAD}` }];

describe("owner answer notice", () => {
	test("AC-1: a choice card answered by a button reports the thread once", async () => {
		const handle = await broker.choose(origin, { text: "❓ 어느 쪽?", buttons: ["A", "B"], fallback: "A" });
		const ts = await transport.shown.promise;
		broker.handleAction({ actionId: `${CHOICE_ACTION_PREFIX}:0:${OWNER_DM}:${ts}`, userId: OWNER });
		expect(await handle.next()).toEqual({ kind: "choice", index: 0 });
		expect(answered).toEqual([]);
		await handle.close("A로 처리", "A");
		expect(answered).toEqual(expected);
	});

	test("AC-2: an approval card closed by approve or deny reports the thread", async () => {
		for (const decision of ["approve", "deny"] as const) {
			answered.length = 0;
			transport.shown = Promise.withResolvers<string>();
			const done = broker.ask(OWNER_DM, `작업 ${decision}`, { origin });
			const ts = await transport.shown.promise;
			broker.handleAction({ actionId: approvalActionId(decision, OWNER_DM, ts), userId: OWNER });
			expect(await done).toBe(decision === "approve" ? "approved" : "denied");
			expect(answered).toEqual(expected);
		}
	});

	test("AC-2: an approval card without a thread reports nothing", async () => {
		const done = broker.ask(OWNER_DM, "스레드 없음", { origin: { originKey: origin.originKey, channel: OWNER_DM } });
		const ts = await transport.shown.promise;
		broker.handleAction({ actionId: approvalActionId("approve", OWNER_DM, ts), userId: OWNER });
		await done;
		expect(answered).toEqual([]);
	});

	test("AC-3: a timed-out approval card reports nothing", async () => {
		const done = broker.ask(OWNER_DM, "시간초과", { origin });
		await transport.shown.promise;
		timers.fireAll();
		expect(await done).toBe("timeout");
		expect(answered).toEqual([]);
	});

	test("AC-3: an aborted approval card reports nothing", async () => {
		const controller = new AbortController();
		const done = broker.ask(OWNER_DM, "취소", { origin, signal: controller.signal });
		await transport.shown.promise;
		controller.abort();
		await done;
		expect(answered).toEqual([]);
	});

	test("AC-3: a choice card closed after a timeout or a cancel reports nothing, even with a partial answer", async () => {
		const handle = await broker.choose(origin, { text: "❓ 시간초과", buttons: ["A"], fallback: "A" });
		await transport.shown.promise;
		timers.fireAll();
		expect(await handle.next()).toMatchObject({ kind: "timeout" });
		await handle.close("시간초과", "부분 응답");
		expect(answered).toEqual([]);

		const controller = new AbortController();
		const second = await broker.choose(
			origin,
			{ text: "❓ 취소", buttons: ["A"], fallback: "A" },
			{ signal: controller.signal },
		);
		controller.abort();
		expect(await second.next()).toMatchObject({ kind: "cancelled" });
		await second.close("취소됨", undefined);
		expect(answered).toEqual([]);
	});
});
