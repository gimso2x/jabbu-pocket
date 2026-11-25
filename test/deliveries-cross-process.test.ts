// `jabbu-pocket deliveries ack|resend` is a second process on the daemon's ledger. Its resolve must not fail with
// SQLITE_BUSY when the daemon commits between its read and its write: the transaction takes the write lock up front.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { openDeliveryLedger } from "../src/store/db";

const ROWS = 1500;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-delivery-xproc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("ack of held deliveries while another process keeps writing the ledger: every row resolves, no SQLITE_BUSY", async () => {
	const path = join(dir, "jabbu.db");
	const origin = "discord/dm/200000000000000001";
	const store = openBotStore(path, { now: () => Date.now() }, "Asia/Seoul");
	store.ensureOrigin(origin, sessionDirFor(join(dir, "sessions"), origin, 1));
	store.close();
	const seed = new Database(path, { strict: true });
	const insert = seed.query(
		"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, attempts, next_at, redelivered, created_at) VALUES (?, ?, 0, 'C:T', ?, 'failed_ambiguous', 0, ?, 0, ?)",
	);
	for (let i = 0; i < ROWS; i++) insert.run(origin, `op${i}`, `body ${i}`, Date.now(), Date.now());
	seed.close();

	const stopFile = join(dir, "stop");
	const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/db-writer-child.ts"), path, stopFile], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = child.stdout.getReader();
	await reader.read(); // "ready": the writer loop is running
	const ledger = openDeliveryLedger(path);
	const errors: string[] = [];
	let resolved = 0;
	try {
		for (let id = 1; id <= ROWS; id++) {
			try {
				ledger.resolveAmbiguous(id, "ack");
				resolved++;
			} catch (error) {
				errors.push(String(error instanceof Error ? error.message : error));
			}
		}
	} finally {
		ledger.close();
		writeFileSync(stopFile, "");
		await child.exited;
	}
	expect(errors).toEqual([]);
	expect(resolved).toBe(ROWS);
	const check = new Database(path, { readonly: true });
	expect(check.query("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'confirmed'").get()).toEqual({ n: ROWS });
	check.close();
}, 60_000);
