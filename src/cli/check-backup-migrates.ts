// `jabbu-pocket check-backup-migrates <backup> [--home <dir>]`: exit 0 when this checkout's code can open the
// ledger snapshot (schema migration included). apply spawns it in a fresh process when HEAD moved after preflight:
// this process loaded its modules before the merge, so an in-process check would test the old code.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultHomeDir, timezoneOfHome } from "../config";
import { openBotStore } from "../core/origin";
import { BackupUnusableError, findBun, isExecutableFile, SYSTEMCTL_TIMEOUT_MS, spawnRunner } from "../ops/apply";

/** Checkout holding this file's `src/main.ts` (src/cli/check-backup-migrates.ts → repo root). */
const REPO_DIR = resolve(import.meta.dir, "..", "..");

/**
 * Opens a throwaway copy of the snapshot with this checkout's code, schema migration included. A ledger the new code
 * cannot migrate fails the backup step, with nothing drained or restarted (apply 20261120-153002 found out only in the
 * restarted daemon: a crash loop, then the code rollback).
 */
export function checkBackupMigrates(backupFile: string, timezone: string): void {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-apply-schema-"));
	try {
		const copy = join(dir, "jabbu.db");
		copyFileSync(backupFile, copy);
		openBotStore(copy, { now: () => Date.now() }, timezone).close();
	} catch (error) {
		throw new BackupUnusableError(
			backupFile,
			`this code cannot open the ledger snapshot: ${error instanceof Error ? error.message : error}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Runs `checkBackupMigrates` in a fresh process, for a backup taken with other code than the one the daemon is about to
 * load. Rejects with `BackupUnusableError` when that code cannot open the snapshot.
 */
export async function revalidateBackup(homeDir: string, pathEnv: string, backupFile: string): Promise<void> {
	const bun = findBun(pathEnv, isExecutableFile);
	if (bun === undefined) throw new Error(`bun을 PATH에서 찾지 못했습니다(${pathEnv})`);
	const checked = await spawnRunner(
		[bun, join(REPO_DIR, "src", "main.ts"), "check-backup-migrates", backupFile, "--home", homeDir],
		{ env: { PATH: pathEnv }, timeoutMs: SYSTEMCTL_TIMEOUT_MS },
	);
	if (checked.code === 0) return;
	const cause = checked.stderr.trim().split("\n").at(0) ?? "";
	throw new BackupUnusableError(backupFile, `the new code cannot open the ledger snapshot: ${cause}`);
}

/** Runs `checkBackupMigrates` and reports the outcome as an exit code (0 opens, 1 cannot, 2 usage). */
export function checkBackupMigratesCommand(args: string[]): number {
	const { values, positionals } = parseArgs({
		args,
		options: { home: { type: "string" } },
		allowPositionals: true,
	});
	const [backupFile] = positionals;
	if (backupFile === undefined || positionals.length > 1) {
		process.stderr.write("check-backup-migrates: <backup> is required\n");
		return 2;
	}
	try {
		checkBackupMigrates(backupFile, timezoneOfHome(values.home ?? defaultHomeDir(process.env)));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	return 0;
}
