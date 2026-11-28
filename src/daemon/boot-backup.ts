import { Worker } from "node:worker_threads";
import type { JabbuConfig } from "../config";
import type { BackupOptions, BackupResult } from "../ops/backup";

/** What the boot-backup worker posts back: the backup result, or its failure as a string. */
export type BootBackupWorkerMessage = { ok: true; result: BackupResult } | { ok: false; error: string };

/**
 * How long the boot backup may run in its worker before it is abandoned: far above any healthy backup (the bundle
 * is capped at 512 MiB), so a wedged tar or VACUUM cannot hold boot forever. The daemon then boots on without the
 * backup; the `backup_age` gate stays open and the daily backup retries.
 */
export const BOOT_BACKUP_TIMEOUT_MS = 10 * 60_000;

export interface BootBackupHandle {
	/** Resolves with the backup result, or rejects when the worker fails, exits, or times out. */
	done: Promise<BackupResult>;
	/** Stops the worker (a stop requested mid-backup): `done` rejects. */
	terminate(): void;
}

/**
 * Runs the first-install boot backup off the daemon's event loop. `run` is the injected runner (tests): it cannot
 * cross into a worker, so it runs inline on a microtask instead — the caller still awaits `done` either way.
 */
export function startBootBackup(
	config: Pick<JabbuConfig, "homeDir" | "maxBundleBytes">,
	now: Date,
	run?: (options: BackupOptions) => BackupResult,
): BootBackupHandle {
	const options: BackupOptions = {
		homeDir: config.homeDir,
		now,
		...(config.maxBundleBytes === undefined ? {} : { maxBundleBytes: config.maxBundleBytes }),
	};
	if (run !== undefined) return { done: Promise.resolve().then(() => run(options)), terminate() {} };
	const worker = new Worker(new URL("./boot-backup-worker.ts", import.meta.url), { workerData: options });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = new Promise<BackupResult>((resolve, reject) => {
		const fail = (error: Error): void => {
			clearTimeout(timer);
			void worker.terminate();
			reject(error);
		};
		timer = setTimeout(
			() => fail(new Error(`boot backup timed out after ${BOOT_BACKUP_TIMEOUT_MS}ms`)),
			BOOT_BACKUP_TIMEOUT_MS,
		);
		worker.once("message", (message: BootBackupWorkerMessage) => {
			clearTimeout(timer);
			void worker.terminate();
			if (message.ok) resolve(message.result);
			else reject(new Error(message.error));
		});
		worker.once("error", fail);
		worker.once("exit", (code) => {
			if (code !== 0) fail(new Error(`boot backup worker exited with code ${code}`));
		});
	});
	return {
		done,
		terminate() {
			clearTimeout(timer);
			void worker.terminate();
		},
	};
}
