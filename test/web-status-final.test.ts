import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryItem, DeliverySource } from "../src/channel/types";
import { TOP_LEVEL_TS, threadRefOf } from "../src/core/normalize";
import { chatOriginKey } from "../src/core/origin-key";
import { createLogger } from "../src/log";
import { openStore, type Store } from "../src/store/db";
import { readWebConversations, readWebMessages, readWebThreads, type WebMessageRow } from "../src/store/web-messages";
import { WebAdapter } from "../src/web/adapter";
import { WebChannel } from "../src/web/channel";
import { renderWebChatPage, webChatAssets } from "../src/web/chat-page";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-status-final-"));
	dirs.push(dir);
	const clock = {
		t: 1_700_000_000_000,
		now() {
			return this.t;
		},
	};
	const store = openStore({ path: join(dir, "jabbu.db"), timezone: "Asia/Seoul", clock, redact: (t) => t });
	stores.push(store);
	const channel = new WebChannel();
	channel.attach(store.web);
	const queue: DeliveryItem[] = [];
	const deliveries: DeliverySource = {
		claimDue: () => queue.splice(0),
		confirm: () => undefined,
		fail: () => undefined,
		defer: () => undefined,
	};
	const adapter = new WebAdapter({
		channel,
		webStore: store.web,
		core: { onInbound: async () => ({}) } as never,
		deliveries,
		clock,
		log: createLogger({ sink: () => undefined, clock, redact: (t) => t }),
	});
	return { dir, clock, adapter, queue };
}

const refOf = (conversation: string) => threadRefOf(conversation, TOP_LEVEL_TS);
const originOf = (conversation: string) => chatOriginKey({ platform: "web", kind: "dm", conversationId: conversation });
const inProgress = (dir: string, conversation: string) =>
	readWebConversations(dir).find((c) => c.conversation === conversation)?.inProgress;
const statusRows = (dir: string, conversation: string) =>
	readWebMessages(dir, conversation).filter((m) => m.role === "status");

describe("web: 끝난 상태 행(취소·실패)은 진행 중으로 남지 않는다", () => {
	test("취소(🚫)로 끝난 상태 행은 문구를 남기고 final로 표시되며, 동시에 실행 중인 다른 대화는 진행 중으로 남는다", async () => {
		const { dir, clock, adapter, queue } = setup();
		await adapter.sendFromWeb({ conversation: "w_aaaaaaaa", text: "오래 걸리는 일" });
		await adapter.sendFromWeb({ conversation: "w_bbbbbbbb", text: "다른 일" });
		clock.t += 60_000;
		await adapter.tick();
		expect(inProgress(dir, "w_aaaaaaaa")).toBe(true);
		expect(inProgress(dir, "w_bbbbbbbb")).toBe(true);

		queue.push({
			deliveryId: 1,
			originKey: originOf("w_aaaaaaaa"),
			threadRef: refOf("w_aaaaaaaa"),
			body: "⏹ 멈췄습니다.",
			redelivered: false,
			cancelThreadRefs: [refOf("w_aaaaaaaa")],
		});
		await adapter.pumpDeliveries();

		const [row] = statusRows(dir, "w_aaaaaaaa");
		expect(row?.text).toStartWith("🚫 취소됨");
		expect(JSON.parse(row?.cardJson ?? "{}")).toMatchObject({ kind: "status", deleted: false, final: true });
		expect(inProgress(dir, "w_aaaaaaaa")).toBe(false);
		// 실행 중인 다른 대화의 상태 행은 그대로 실행 중이다.
		expect(JSON.parse(statusRows(dir, "w_bbbbbbbb")[0]?.cardJson ?? "{}").final).toBeUndefined();
		expect(inProgress(dir, "w_bbbbbbbb")).toBe(true);
	});

	test("같은 대화의 스레드 턴이 취소돼도 최상위의 실행 중 턴은 진행 중으로 남고, 스레드는 진행 중이 아니다", async () => {
		const { dir, clock, adapter, queue } = setup();
		const conv = "w_dddddddd";
		const thread = "w_tttttttt";
		await adapter.sendFromWeb({ conversation: conv, text: "최상위 일" });
		await adapter.sendFromWeb({ conversation: conv, thread, text: "스레드 일" });
		clock.t += 60_000;
		await adapter.tick();
		const threadOrigin = chatOriginKey({ platform: "web", kind: "dm", conversationId: conv, threadId: thread });
		const threadRef = threadRefOf(conv, thread);
		expect(readWebThreads(dir, conv).find((t) => t.thread === thread)?.inProgress).toBe(true);
		queue.push({
			deliveryId: 3,
			originKey: threadOrigin,
			threadRef,
			body: "⏹ 멈췄습니다.",
			redelivered: false,
			cancelThreadRefs: [threadRef],
		});
		await adapter.pumpDeliveries();
		const rows = readWebMessages(dir, conv, { thread }).filter((m) => m.role === "status");
		expect(rows[0]?.text).toStartWith("🚫 취소됨");
		expect(readWebThreads(dir, conv).find((t) => t.thread === thread)?.inProgress).toBe(false);
		expect(inProgress(dir, conv)).toBe(true); // 최상위 턴은 아직 실행 중
	});

	test("첫 화면 렌더링: final 행은 is-final(스피너 숨김), 실행 중 행은 그대로, 옛 행(플래그 없음)도 깨지지 않는다", () => {
		const row = (id: number, text: string, card: string): WebMessageRow => ({
			id,
			conversation: "w_eeeeeeee",
			thread: null,
			role: "status",
			text,
			cardJson: card,
			buttonsJson: null,
			filesJson: null,
			createdAt: 1_700_000_000_000 + id,
			editedAt: null,
		});
		const html = renderWebChatPage({
			conversations: [],
			activeConversation: "w_eeeeeeee",
			csrfToken: "t",
			messages: [
				row(1, "🚫 취소됨 · 00:03", '{"kind":"status","deleted":false,"final":true}'),
				row(2, "⏳ 작업 중 · 00:09", '{"kind":"status","deleted":false}'),
				row(3, "", '{"kind":"status","deleted":true}'),
				row(4, "🚫 취소됨 · 옛 행", "not json"),
			],
		});
		const cls = (id: number) => new RegExp(`<div class="(wc-msg-status[^"]*)" data-msg-id="${id}">`).exec(html)?.[1];
		expect(cls(1)).toBe("wc-msg-status is-final");
		expect(cls(2)).toBe("wc-msg-status");
		expect(cls(3)).toBe("wc-msg-status is-deleted");
		expect(cls(4)).toBe("wc-msg-status");
		expect(html).toContain("🚫 취소됨 · 00:03");
		expect(webChatAssets().css.body).toContain(".wc-msg-status.is-final .wc-spin");
		expect(webChatAssets().js.body).toContain("is-final");
	});
});
