import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { timezoneOfHome } from "../config";
import { acquireLock, LockHeldError } from "../daemon/lock";
import { BACKUP_FILE_PATTERN, backupStamp, fsyncPath } from "./backup";
import { RestoreError, verifyRestoreCopy } from "./restore-verify";

export { RestoreError } from "./restore-verify";

export interface RestoreOptions {
	homeDir: string;
	/** A daily backup name/path under `<home>/backups`, or an absolute path to any file. */
	source: string;
	/** Without `yes` nothing changes and the plan is returned. */
	yes: boolean;
	now?: Date;
	/** IPC probe: resolves when a daemon answers on the socket, rejects when nothing listens. */
	probeDaemon: () => Promise<unknown>;
	/** Rename seam (tests inject failures); defaults to `renameSync`. */
	rename?: (from: string, to: string) => void;
}

export interface RestorePlan {
	source: string;
	target: string;
	preRestoreDir: string;
	/** Files of the current ledger that move to `preRestoreDir`. */
	moves: string[];
}

export interface RestoreResult {
	applied: boolean;
	plan: RestorePlan;
}

const SIDECARS = ["", "-wal", "-shm", "-journal"] as const;

/** `backups/pre-restore-<stamp>`, or `-2`, `-3`… when a restore in the same second already used that name. */
function freshPreRestoreDir(homeDir: string, stamp: string): string {
	const base = join(homeDir, "backups", `pre-restore-${stamp}`);
	let dir = base;
	for (let n = 2; existsSync(dir); n += 1) dir = `${base}-${n}`;
	return dir;
}

/** Maps the CLI argument to the backup file: a daily name (or `backups/<name>`) inside the home, or an absolute file. */
export function resolveRestoreSource(homeDir: string, source: string): string {
	const backupsDir = join(homeDir, "backups");
	let path: string;
	if (isAbsolute(source)) path = resolve(source);
	else {
		const name = source.startsWith("backups/") ? source.slice("backups/".length) : source;
		if (name !== basename(name) || !BACKUP_FILE_PATTERN.test(name)) {
			throw new RestoreError(
				"bad_source",
				`${source} is neither a jabbu-YYYYMMDD-HHMMSS.db in backups/ nor an absolute path`,
			);
		}
		path = join(backupsDir, name);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		throw new RestoreError("bad_source", `${path} does not exist`);
	}
	if (!stat.isFile()) throw new RestoreError("bad_source", `${path} is not a regular file`);
	// A hard link hides where its other names live, and a live ledger's -wal sits beside one of those: refuse it.
	if (stat.nlink > 1) {
		throw new RestoreError("bad_source", `${path} is a hard link (${stat.nlink} names): copy the backup file first`);
	}
	// A -wal or -journal next to the source means a live or crashed ledger, not a self-contained backup: copying only
	// the main file would silently drop (or half-apply) its newest pages. A symlink is checked at its real path too.
	for (const sidecar of new Set([path, realpathSync(path)].flatMap((p) => [`${p}-wal`, `${p}-journal`]))) {
		if (existsSync(sidecar)) {
			throw new RestoreError(
				"bad_source",
				`${sidecar} exists: the source is not a self-contained backup (checkpoint it or use a backup file)`,
			);
		}
	}
	return path;
}

/**
 * Replaces `<home>/jabbu.db` with a verified backup while no daemon runs. The copy is made next to the target,
 * checked with `PRAGMA quick_check` plus a throwaway open that runs the schema migration, the current db (+wal/shm)
 * moves to `backups/pre-restore-<stamp>/`, and a rename installs the copy. Any failure after the first move puts the
 * previous files back. The single-instance lock is held throughout so a daemon cannot start halfway.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
	const { homeDir } = options;
	const rename = options.rename ?? renameSync;
	const source = resolveRestoreSource(homeDir, options.source);
	const target = join(homeDir, "jabbu.db");
	const stamp = backupStamp(options.now ?? new Date());
	const preRestoreDir = freshPreRestoreDir(homeDir, stamp);

	let answered = false;
	try {
		await options.probeDaemon();
		answered = true;
	} catch {
		// nothing listening: fine
	}
	if (answered)
		throw new RestoreError(
			"daemon_running",
			"a daemon answers on jabbu.sock; stop it first (systemctl --user stop jabbu)",
		);
	let lock: ReturnType<typeof acquireLock>;
	try {
		lock = acquireLock(join(homeDir, "jabbu.lock"));
	} catch (error) {
		if (error instanceof LockHeldError) throw new RestoreError("daemon_running", error.message);
		throw error;
	}
	try {
		// Listed under the lock: a -wal a dying writer left while the probe ran would otherwise stay beside the new db.
		const plan: RestorePlan = {
			source,
			target,
			preRestoreDir,
			moves: SIDECARS.map((suffix) => `${target}${suffix}`).filter((path) => existsSync(path)),
		};
		if (!options.yes) return { applied: false, plan };
		install(plan, rename, timezoneOfHome(homeDir));
		return { applied: true, plan };
	} finally {
		lock.release();
	}
}

function install(plan: RestorePlan, rename: (from: string, to: string) => void, timezone: string): void {
	const { source, target, preRestoreDir } = plan;
	const tmp = join(dirname(target), `jabbu.db.restore-${crypto.randomUUID()}.tmp`);
	const moved: Array<{ from: string; to: string }> = [];
	let placed = false;
	try {
		copyFileSync(source, tmp);
		chmodSync(tmp, 0o600);
		verifyRestoreCopy(tmp, timezone);
		for (const ext of SIDECARS.slice(1)) rmSync(`${tmp}${ext}`, { force: true });
		fsyncPath(tmp);

		if (plan.moves.length > 0) mkdirSync(preRestoreDir, { recursive: true, mode: 0o700 });
		for (const from of plan.moves) {
			const to = join(preRestoreDir, basename(from));
			rename(from, to);
			moved.push({ from, to });
		}
		rename(tmp, target);
		placed = true;
		fsyncPath(target);
		fsyncPath(dirname(target));
	} catch (error) {
		rmSync(tmp, { force: true });
		// The read-only check opens a WAL-mode copy, which leaves -wal/-shm beside it even when nothing is written.
		for (const ext of SIDECARS.slice(1)) rmSync(`${tmp}${ext}`, { force: true });
		if (placed || moved.length > 0) {
			// The replaced ledger must be exactly what it was: drop the half-installed copy, move the old files back.
			rmSync(target, { force: true });
			for (const { from, to } of moved.reverse()) renameSync(to, from);
		}
		if (error instanceof RestoreError) throw error;
		throw new RestoreError("restore_failed", error instanceof Error ? error.message : String(error));
	}
}
