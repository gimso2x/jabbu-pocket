import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { openStore, type Store } from "../src/store/db";
import { readWebConversations, readWebMessages } from "../src/store/web-messages";
import { WebAdapter } from "../src/web/adapter";
import { WebChannel } from "../src/web/channel";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function adapterFor(store: Store, dir: string, channel: WebChannel): WebAdapter {
	const clock = { now: () => 1_700_000_000_000 };
	return new WebAdapter({
		channel,
		webStore: store.web,
		homeDir: dir,
		core: {} as never,
		deliveries: {} as never,
		clock: clock as never,
		log: createLogger({ sink: () => undefined, clock, redact: (t) => t }),
	});
}

function open(dir: string): Store {
	const store = openStore({
		path: join(dir, "jabbu.db"),
		timezone: "Asia/Seoul",
		clock: { now: () => 1_700_000_000_000 },
		redact: (t) => t,
	});
	stores.push(store);
	return store;
}

describe("web: 재시작이 남긴 ⏳ 상태 행", () => {
	test("재시작 뒤 어댑터 생성이 끝나지 않는 상태 행을 닫아 진행 중 표시가 남지 않는다", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-stale-status-"));
		dirs.push(dir);
		const first = open(dir);
		const ch1 = new WebChannel();
		ch1.attach(first.web);
		first.web.insert({ conversation: "w_aaaaaaaa", role: "owner", text: "긴 작업" });
		ch1.postStatus({ conversationId: "w_aaaaaaaa" }, "⏳ 작업 중 · 00:12");
		const done = ch1.postStatus({ conversationId: "w_bbbbbbbb" }, "⏳ 작업 중 · 00:01");
		ch1.editStatus(done.messageId, "", true);
		expect(readWebConversations(dir).find((c) => c.conversation === "w_aaaaaaaa")?.inProgress).toBe(true);
		first.close();
		stores.pop();

		// 새 프로세스: 메모리의 상태 추적은 사라졌다.
		const second = open(dir);
		const ch2 = new WebChannel();
		ch2.attach(second.web);
		adapterFor(second, dir, ch2);
		const rows = readWebMessages(dir, "w_aaaaaaaa");
		const status = rows.filter((r) => r.role === "status");
		expect(status).toHaveLength(1);
		expect(JSON.parse(status[0]?.cardJson ?? "{}").deleted).toBe(true);
		expect(readWebConversations(dir).find((c) => c.conversation === "w_aaaaaaaa")?.inProgress).toBe(false);
		expect(rows.find((r) => r.role === "owner")?.text).toBe("긴 작업");
	});

	test("이미 끝난 상태 행과 일반 메시지는 건드리지 않고, 어댑터를 다시 만들어도 같다", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-stale-status-"));
		dirs.push(dir);
		const store = open(dir);
		const ch = new WebChannel();
		ch.attach(store.web);
		store.web.insert({ conversation: "w_cccccccc", role: "assistant", text: "답", thread: undefined });
		const ref = ch.postStatus({ conversationId: "w_cccccccc" }, "⏳");
		ch.editStatus(ref.messageId, "", true);
		const before = readWebMessages(dir, "w_cccccccc").map((r) => r.editedAt);
		adapterFor(store, dir, ch);
		expect(readWebMessages(dir, "w_cccccccc").map((r) => r.editedAt)).toEqual(before);
	});

	test("다른 봇 홈의 실행 중 상태 행과 어댑터 생성 뒤에 새로 생긴 상태 행은 닫지 않는다", () => {
		const dirA = mkdtempSync(join(tmpdir(), "jabbu-stale-status-"));
		const dirB = mkdtempSync(join(tmpdir(), "jabbu-stale-status-"));
		dirs.push(dirA, dirB);
		const storeB = open(dirB);
		const chB = new WebChannel();
		chB.attach(storeB.web);
		chB.postStatus({ conversationId: "w_dddddddd" }, "⏳ 작업 중 · 00:05");

		const storeA = open(dirA);
		const chA = new WebChannel();
		chA.attach(storeA.web);
		chA.postStatus({ conversationId: "w_eeeeeeee" }, "⏳ 이전 프로세스");
		adapterFor(storeA, dirA, chA);

		// 봇 B는 건드리지 않는다.
		expect(readWebConversations(dirB).find((c) => c.conversation === "w_dddddddd")?.inProgress).toBe(true);
		// A의 이전 행은 닫혔고, 그 뒤에 생긴 새 상태 행은 실행 중으로 남는다.
		expect(readWebConversations(dirA).find((c) => c.conversation === "w_eeeeeeee")?.inProgress).toBe(false);
		const live = chA.postStatus({ conversationId: "w_eeeeeeee" }, "⏳ 작업 중 · 00:00");
		expect(readWebConversations(dirA).find((c) => c.conversation === "w_eeeeeeee")?.inProgress).toBe(true);
		chA.editStatus(live.messageId, "", true);
		expect(readWebConversations(dirA).find((c) => c.conversation === "w_eeeeeeee")?.inProgress).toBe(false);
	});

	test("이미 결과 문구로 끝난 옛 행(🚫 취소됨 등)은 문구를 지우지 않고 final로만 표시하고, 이미 final인 행은 그대로 둔다", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-stale-status-"));
		dirs.push(dir);
		const first = open(dir);
		const ch = new WebChannel();
		ch.attach(first.web);
		const legacy = ch.postStatus({ conversationId: "w_ffffffff" }, "🚫 취소됨 · 00:03");
		const running = ch.postStatus({ conversationId: "w_ffffffff" }, "⏳ 작업 중 · 00:20");
		const marked = first.web.insert({
			conversation: "w_ffffffff",
			role: "status",
			text: "⚠️ 실패 · 00:07",
			cardJson: JSON.stringify({ kind: "status", deleted: false, final: true }),
		});
		const before = readWebMessages(dir, "w_ffffffff").find((r) => r.id === marked.id)?.editedAt;
		first.close();
		stores.pop();

		const second = open(dir);
		const ch2 = new WebChannel();
		ch2.attach(second.web);
		adapterFor(second, dir, ch2);
		const rows = readWebMessages(dir, "w_ffffffff");
		const get = (id: string | number) => rows.find((r) => r.id === Number(id));
		expect(get(legacy.messageId)?.text).toBe("🚫 취소됨 · 00:03");
		expect(JSON.parse(get(legacy.messageId)?.cardJson ?? "{}")).toMatchObject({ deleted: false, final: true });
		expect(get(running.messageId)?.text).toBe("");
		expect(JSON.parse(get(running.messageId)?.cardJson ?? "{}").deleted).toBe(true);
		expect(get(marked.id)?.text).toBe("⚠️ 실패 · 00:07");
		expect(get(marked.id)?.editedAt).toBe(before ?? null);
	});
});
