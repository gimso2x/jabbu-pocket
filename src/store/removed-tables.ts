import type { Database } from "bun:sqlite";

/**
 * Tables of removed features leave the ledger in one transaction, run on every open (a no-op once gone): schema 7
 * the Teams channel's tables (namespace `teams_`, with their indexes), schema 13 the `dead` tables nothing reads or
 * writes (no other table references them; the backup taken before an apply keeps their rows).
 */
export function dropRemovedTables(db: Database, dead: readonly string[]): void {
	const teams = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'teams[_]*'")
		.all() as Array<{
		name: string;
	}>;
	db.transaction(() => {
		for (const name of [...teams.map((table) => table.name), ...dead]) db.run(`DROP TABLE IF EXISTS "${name}"`);
	})();
}
