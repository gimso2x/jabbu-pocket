import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSchemaVersion } from "../store/schema-version";
import { runRestore } from "./restore";
import type { Runner } from "./run-types";

/** How long `systemctl stop` gets before the db restore (the limit apply uses for systemctl). */
const STOP_TIMEOUT_MS = 120_000;

/** Whether the code rollback's ledger is safe to restart on, and what happened to it. */
export interface RollbackDbResult {
	ok: boolean;
	detail: string;
}

/** What `restoreLedgerForRollback` needs: a command runner and the snapshot restore (`runRestore` path). */
export interface RollbackDbDeps {
	run: Runner;
	restoreBackup?: (backupFile: string) => Promise<RollbackDbResult>;
}

/** `PRAGMA user_version` of `<home>/jabbu.db` (read-only); undefined when there is no readable ledger. */
function readLedgerVersion(homeDir: string): number | undefined {
	const path = join(homeDir, "jabbu.db");
	if (!existsSync(path)) return undefined;
	try {
		const db = new Database(path, { readonly: true });
		try {
			return readSchemaVersion(db);
		} finally {
			db.close();
		}
	} catch {
		return undefined; // unreadable ledger: the caller rolls back as before, the restart decides
	}
}

/** The `SCHEMA_VERSION` the checked-out code stamps; undefined when the file is absent or unparsable. */
function readCheckoutSchemaVersion(repoDir: string): number | undefined {
	try {
		const match = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(
			readFileSync(join(repoDir, "src", "store", "schema-version.ts"), "utf8"),
		);
		return match?.[1] === undefined ? undefined : Number(match[1]);
	} catch {
		return undefined; // a checkout without the file rolls back as before
	}
}

/** The manual recovery for a ledger newer than the rolled-back code: `jabbu-pocket restore <backup>`. */
function restoreCommand(backupFile: string | undefined): string {
	return backupFile === undefined ? "jabbu-pocket restore <backup db>" : `jabbu-pocket restore ${backupFile}`;
}

/**
 * Before the code rollback restarts onto head.last-good: the new code already migrated the ledger, so a
 * schema-bumping release would restart old code onto a ledger it refuses (`newer_schema`) and stay down. When the
 * ledger is newer than the rolled-back code's schema, stop the daemon, restore the pre-apply snapshot, and only
 * then let the caller restart. Nothing to do (no ledger, unreadable versions, ledger not newer) is ok with an
 * empty detail; a restore that cannot run fails fast and names the manual restore command.
 */
export async function restoreLedgerForRollback(
	deps: RollbackDbDeps,
	home: { homeDir: string; repoDir: string; unit: string },
	backupFile: string | undefined,
): Promise<RollbackDbResult> {
	const ledgerVersion = readLedgerVersion(home.homeDir);
	const rolledBackVersion = ledgerVersion === undefined ? undefined : readCheckoutSchemaVersion(home.repoDir);
	if (ledgerVersion === undefined || rolledBackVersion === undefined || ledgerVersion <= rolledBackVersion)
		return { ok: true, detail: "" };
	const note = `ledger schema v${ledgerVersion} > rolled-back code v${rolledBackVersion}: db restore first`;
	if (backupFile === undefined)
		return {
			ok: false,
			detail: `${note}; no pre-apply backup in the receipt — restore by hand: ${restoreCommand(undefined)}`,
		};
	if (deps.restoreBackup === undefined)
		return {
			ok: false,
			detail: `${note}; db restore unavailable in this apply — restore by hand: ${restoreCommand(backupFile)}`,
		};
	const stopped = await deps.run(["systemctl", "--user", "stop", home.unit], { timeoutMs: STOP_TIMEOUT_MS });
	if (stopped.code !== 0)
		return {
			ok: false,
			detail: `${note}; systemctl stop rc=${stopped.code}: ${stopped.stderr.trim()} — restore by hand: ${restoreCommand(backupFile)}`,
		};
	const restored = await deps.restoreBackup(backupFile);
	if (!restored.ok)
		return {
			ok: false,
			detail: `${note}; db restore failed: ${restored.detail} — restore by hand: ${restoreCommand(backupFile)}`,
		};
	return { ok: true, detail: `${note}; db restored from ${backupFile}: ${restored.detail}` };
}

/**
 * The `restoreBackup` an apply wires in (`homeDeps`): the pre-apply snapshot through the `runRestore` install
 * path. The daemon is already stopped by then, so the probe finds nothing listening.
 */
export async function restoreBackupFile(
	homeDir: string,
	probeDaemon: () => Promise<unknown>,
	backupFile: string,
): Promise<RollbackDbResult> {
	try {
		await runRestore({ homeDir, source: backupFile, yes: true, probeDaemon });
		return { ok: true, detail: `db restored from ${backupFile}` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
