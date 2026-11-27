import { Database } from "bun:sqlite";
import { openBotStore } from "../core/origin";
import { newerSchemaMessage, readSchemaVersion, SCHEMA_VERSION } from "../store/schema-version";

export type RestoreErrorCode =
	| "bad_source"
	| "daemon_running"
	| "newer_schema"
	| "integrity_check_failed"
	| "migration_failed"
	| "restore_failed";

export class RestoreError extends Error {
	readonly code: RestoreErrorCode;

	constructor(code: RestoreErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "RestoreError";
		this.code = code;
	}
}

/** Core ledger tables every jabbu db has: a restore source without them is not a jabbu ledger. */
const REQUIRED_TABLES = ["origins", "inbound", "deliveries"] as const;

/**
 * Verifies a temp copy of a restore source before any file moves: the newer-schema refusal, `PRAGMA quick_check`,
 * the required tables, and — the check `install()` used to skip — a throwaway open with this checkout's code, schema
 * migration included. A ledger the current code cannot migrate (an old backup whose schema-9 rename collides, a row
 * outside a widened CHECK) is refused here instead of bricking the next daemon start. The copy is throwaway, so
 * migrating it is safe — and the installed ledger then starts already migrated.
 */
export function verifyRestoreCopy(path: string, timezone: string): void {
	const copy = new Database(path, { readonly: true, strict: true });
	let check: string;
	let missing: string[];
	let copyVersion: number;
	try {
		copyVersion = readSchemaVersion(copy);
		check = (copy.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined)?.quick_check ?? "";
		// quick_check passes an empty file and any foreign sqlite db alike; the daemon would not start on either.
		const tables = new Set(
			(copy.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
				(row) => row.name,
			),
		);
		missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
	} catch (error) {
		throw new RestoreError("integrity_check_failed", error instanceof Error ? error.message : String(error));
	} finally {
		copy.close();
	}
	if (copyVersion > SCHEMA_VERSION) {
		throw new RestoreError("newer_schema", newerSchemaMessage(copyVersion).replace(/^newer_schema: /, ""));
	}
	if (check !== "ok") throw new RestoreError("integrity_check_failed", `quick_check=${check}`);
	if (missing.length > 0) {
		throw new RestoreError(
			"integrity_check_failed",
			`not a jabbu ledger: missing table${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
		);
	}
	try {
		openBotStore(path, { now: () => Date.now() }, timezone).close();
	} catch (error) {
		throw new RestoreError(
			"migration_failed",
			`this code cannot open the backup: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
