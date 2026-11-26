import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readWebChanges,
	readWebConversations,
	readWebMessages,
	readWebWatermark,
	WEB_MESSAGES_DDL,
} from "../src/store/web-messages";

let dirs: string[] = [];

beforeEach(() => {
	dirs = [];
});

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-messages-"));
	dirs.push(dir);
	return dir;
}

describe("corrupt web_messages DB degrades to an empty web view", () => {
	test("a garbage jabbu.db returns fallbacks instead of throwing", () => {
		const dir = makeHome();
		writeFileSync(join(dir, "jabbu.db"), "this is not a sqlite database");
		expect(readWebConversations(dir)).toEqual([]);
		expect(readWebMessages(dir, "w_x")).toEqual([]);
		expect(readWebWatermark(dir)).toEqual({ maxId: 0, maxEditedAt: 0 });
		expect(readWebChanges(dir, 0, 0)).toEqual([]);
	});

	test("a valid DB still reads its rows", () => {
		const dir = makeHome();
		const db = new Database(join(dir, "jabbu.db"));
		db.exec(WEB_MESSAGES_DDL);
		db.query("INSERT INTO web_messages (conversation, role, text, created_at) VALUES (?, 'assistant', 'hi', 1000)").run(
			"w_x",
		);
		db.close();
		const rows = readWebMessages(dir, "w_x");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe("hi");
	});
});
