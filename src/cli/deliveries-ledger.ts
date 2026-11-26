import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DeliveryLedger, openDeliveryLedger } from "../store/db";

/** Whether the file already holds the `deliveries` table: a home where only `monitors add` wrote `jabbu.db` has none. */
function hasDeliveriesTable(path: string): boolean {
	const db = new Database(path, { readonly: true, strict: true });
	try {
		db.run("PRAGMA busy_timeout = 5000");
		return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get() !== null;
	} finally {
		db.close();
	}
}

/**
 * The ledger one `deliveries` CLI run reads, or undefined after saying on stderr why this home has none. No `jabbu.db` at
 * all and a file the daemon never opened as a ledger (a monitors-only `jabbu.db` has no `deliveries` table, so the read
 * used to die on SQLite's raw `no such table: deliveries`) both mean the daemon has not run here yet; its first open
 * creates the table, so both get the same "run the daemon once" sentence and exit code 1.
 */
export function openDeliveriesLedgerFor(homeDir: string): DeliveryLedger | undefined {
	const path = join(homeDir, "jabbu.db");
	if (!existsSync(path)) {
		process.stderr.write(`deliveries: no ledger at ${path} (run the daemon once)\n`);
		return undefined;
	}
	if (!hasDeliveriesTable(path)) {
		process.stderr.write(`deliveries: ${path} has no deliveries table yet (run the daemon once)\n`);
		return undefined;
	}
	return openDeliveryLedger(path);
}
