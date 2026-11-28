import { parentPort, workerData } from "node:worker_threads";
import { type BackupOptions, type BackupResult, runBackup } from "../ops/backup";
import type { BootBackupWorkerMessage } from "./boot-backup";

/**
 * The boot backup's own thread: `runBackup` is fully synchronous (VACUUM, tar, sha256), so running it on the
 * daemon's main thread would stall the watchdog beat for the whole run. The worker posts the result back; the
 * main thread stays free to beat, serve signals, and boot on.
 */
const options = workerData as BackupOptions;
let message: BootBackupWorkerMessage;
try {
	const result: BackupResult = runBackup(options);
	message = { ok: true, result };
} catch (error) {
	message = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(message);
