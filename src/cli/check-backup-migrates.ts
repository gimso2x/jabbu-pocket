// `jabbu-pocket check-backup-migrates <backup> [--home <dir>]`: exit 0 when this checkout's code can open the
// ledger snapshot (schema migration included). apply spawns it in a fresh process when HEAD moved after preflight:
// this process loaded its modules before the merge, so an in-process check would test the old code.
import { parseArgs } from "node:util";
import { defaultHomeDir, timezoneOfHome } from "../config";
import { checkBackupMigrates } from "./apply";

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
