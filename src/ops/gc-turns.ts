import type { Database } from "bun:sqlite";
import { removeTurnRefsSync, TURN_SNAPSHOT_RETENTION_DAYS } from "./turn-snapshot";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Options of `gcSessions` that the turn-snapshot pass reads. */
interface TurnGcOptions {
	now: number;
	dryRun?: boolean;
}

export function hasTable(db: Database, name: string): boolean {
	return db.query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

/**
 * `!undo` rows past the turn-snapshot retention (7 days, independent of the session window) leave the ledger, and the
 * `refs/jabbu/turns/<id>/…` that kept their trees alive go with them. Runs on the writable handle `gcSessions` already
 * opened; a dry run reads the count and writes nothing.
 */
export function gcTurnSnapshots(db: Database, options: TurnGcOptions): number {
	if (!hasTable(db, "turn_snapshots")) return 0;
	const cutoff = options.now - TURN_SNAPSHOT_RETENTION_DAYS * DAY_MS;
	const rows = db.query("SELECT id, repo FROM turn_snapshots WHERE ended_at < ?").all(cutoff) as Array<{
		id: number;
		repo: string;
	}>;
	if (rows.length === 0 || options.dryRun === true) return rows.length;
	// Refs go first: a row whose ref could not be deleted stays in the ledger, so the next gc retries it.
	const kept = new Set<number>();
	removeTurnRefsSync(rows, (id) => kept.add(id));
	const remove = db.query("DELETE FROM turn_snapshots WHERE id = ?");
	for (const row of rows) if (!kept.has(row.id)) remove.run(row.id);
	return rows.length - kept.size;
}
