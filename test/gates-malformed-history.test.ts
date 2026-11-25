import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAMP_FILE } from "../src/ops/backup";
import { collectGates } from "../src/ops/gates";

let home: string;
const now = Date.now();

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-gates-history-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const DDL = `
CREATE TABLE inbound (inbound_id INTEGER PRIMARY KEY AUTOINCREMENT, platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL, epoch INTEGER NOT NULL, text_ref TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL, dispatched_at INTEGER, last_event_at INTEGER);
CREATE TABLE deliveries (delivery_id INTEGER PRIMARY KEY AUTOINCREMENT, origin_key TEXT NOT NULL, op_ref TEXT NOT NULL,
	part INTEGER NOT NULL, thread_ref TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, redelivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL, last_error TEXT, UNIQUE (origin_key, op_ref, part));
CREATE TABLE lanes (name TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'working', history TEXT,
	created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

test("a lane row whose history is not JSON does not blind the other ledger gates", () => {
	mkdirSync(join(home, "backups"), { recursive: true });
	writeFileSync(
		join(home, "backups", STAMP_FILE),
		`ts=${new Date(now).toISOString()} file=jabbu-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`,
	);
	const db = new Database(join(home, "jabbu.db"), { create: true, strict: true });
	db.run(DDL);
	const old = now - 25 * 3_600_000;
	db.run(
		"INSERT INTO lanes (name, status, history, created_at, updated_at) VALUES ('bad', 'working', 'not json', ?, ?)",
		[old, old],
	);
	db.run(
		"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'r', 0, 't', 'b', 'pending', ?, ?)",
		[old, old],
	);
	db.close();
	const gates = collectGates({ homeDir: home, now });
	expect(gates.find((g) => g.name === "ledger_unreadable")).toBeUndefined();
	expect(gates.find((g) => g.name === "deliveries_overdue")?.state).toBe("open");
	expect(gates.find((g) => g.name === "lanes_stuck")?.detail).toStartWith("working_old=1 ");
});
