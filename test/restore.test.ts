import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreCommand } from "../src/cli/restore";
import { acquireLock } from "../src/daemon/lock";
import { runBackup } from "../src/ops/backup";
import { RestoreError, runRestore } from "../src/ops/restore";
import { openStore } from "../src/store/db";
import { readSchemaVersion, SCHEMA_VERSION } from "../src/store/schema-version";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-restore-"));
	chmodSync(home, 0o700);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/**
 * A live ledger the daemon can open: today's schema (via `openStore`) plus a `marker` row naming it. The old stub
 * (three one-column tables) passed the shallow checks but no daemon could ever open it — exactly the hole U2 closes —
 * so restore fixtures must be real ledgers.
 */
function seed(marker: string): void {
	for (const ext of ["", "-wal", "-shm", "-journal"]) rmSync(join(home, `jabbu.db${ext}`), { force: true });
	const store = openStore({
		path: join(home, "jabbu.db"),
		clock: { now: () => 1_700_000_000_000 },
		timezone: "Asia/Seoul",
		redact: (text: string) => text,
	});
	store.close();
	const db = new Database(join(home, "jabbu.db"));
	db.run("CREATE TABLE IF NOT EXISTS marker (v TEXT)");
	db.run("DELETE FROM marker");
	db.query("INSERT INTO marker VALUES (?)").run(marker);
	db.close();
}

function markerOf(path: string): string | undefined {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT v FROM marker").get() as { v: string } | null)?.v;
	} finally {
		db.close();
	}
}

const noDaemon = (): Promise<unknown> => Promise.reject(new Error("ENOENT"));

const OLD_LANE = "ompbot/work/fix-login";
const NEW_LANE = "jabbu/work/fix-login";

/**
 * A ledger as schema-8 code left it: today's tables, old-name rows, stamped 8 (same fabrication as
 * test/rename-migration.test.ts). With `collide` both the old and the new lane origin exist, so the schema-9 rename
 * hits the `origins.origin_key` primary key — the current code cannot migrate it.
 */
function schema8Backup(collide: boolean): string {
	const path = join(home, "old-backup.db");
	const store = openStore({
		path,
		clock: { now: () => 1_700_000_000_000 },
		timezone: "Asia/Seoul",
		redact: (text: string) => text,
	});
	try {
		store.ensureOrigin(OLD_LANE, "/s/old");
		if (collide) store.ensureOrigin(NEW_LANE, "/s/new");
	} finally {
		store.close();
	}
	const db = new Database(path);
	db.run("PRAGMA user_version = 8");
	db.close();
	for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
	return path;
}

/** A backup of the "good" ledger, then a live ledger that drifted on. */
function goodBackupThenDrift(): string {
	seed("good");
	const { file } = runBackup({ homeDir: home });
	seed("drifted");
	writeFileSync(join(home, "jabbu.db-wal"), "stale-wal");
	return file;
}

describe("runRestore", () => {
	test("replaces the ledger with the backup and parks the old db and sidecars in pre-restore-<stamp>", async () => {
		const file = goodBackupThenDrift();
		const result = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon });
		expect(result.applied).toBe(true);
		// Before any read of the installed copy: a read of a WAL-mode ledger creates an empty -wal beside it, so the
		// no-sidecar check runs before `markerOf` reads it.
		expect(existsSync(join(home, "jabbu.db-wal"))).toBe(false);
		expect(markerOf(join(home, "jabbu.db"))).toBe("good");
		expect(readdirSync(result.plan.preRestoreDir).sort()).toEqual(["jabbu.db", "jabbu.db-wal"]);
		expect(markerOf(join(result.plan.preRestoreDir, "jabbu.db"))).toBe("drifted");
		expect(existsSync(join(home, "jabbu.lock"))).toBe(false); // lock released
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("a bare daily backup name resolves inside backups/", async () => {
		const file = goodBackupThenDrift();
		const name = file.split("/").pop() as string;
		const result = await runRestore({ homeDir: home, source: name, yes: true, probeDaemon: noDaemon });
		expect(result.plan.source).toBe(file);
		expect(markerOf(join(home, "jabbu.db"))).toBe("good");
	});

	test("without --yes nothing changes", async () => {
		const file = goodBackupThenDrift();
		const result = await runRestore({ homeDir: home, source: file, yes: false, probeDaemon: noDaemon });
		expect(result.applied).toBe(false);
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(existsSync(result.plan.preRestoreDir)).toBe(false);
	});

	test("refuses while a daemon answers on the socket and while the lock is held", async () => {
		const file = goodBackupThenDrift();
		await expect(
			runRestore({ homeDir: home, source: file, yes: true, probeDaemon: async () => ({ ok: true }) }),
		).rejects.toMatchObject({ code: "daemon_running" });
		const lock = acquireLock(join(home, "jabbu.lock"));
		try {
			await expect(runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon })).rejects.toMatchObject(
				{
					code: "daemon_running",
				},
			);
		} finally {
			lock.release();
		}
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
	});

	test("a backup failing quick_check or not being a database leaves the live ledger untouched", async () => {
		goodBackupThenDrift();
		const corrupt = join(home, "corrupt.db");
		writeFileSync(corrupt, Buffer.alloc(8192, 7));
		const error = await runRestore({ homeDir: home, source: corrupt, yes: true, probeDaemon: noDaemon }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(RestoreError);
		expect(error.code).toBe("integrity_check_failed");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(existsSync(join(home, "jabbu.db-wal"))).toBe(true);
		expect(readdirSync(home).filter((n) => n.includes(".tmp") || n.startsWith("pre-restore"))).toEqual([]);
		expect(
			existsSync(join(home, "backups"))
				? readdirSync(join(home, "backups")).some((n) => n.startsWith("pre-restore"))
				: false,
		).toBe(false);
	});

	test("a failure while installing puts the original files back", async () => {
		const file = goodBackupThenDrift();
		let renames = 0;
		const error = await runRestore({
			homeDir: home,
			source: file,
			yes: true,
			probeDaemon: noDaemon,
			rename: (from, to) => {
				renames += 1;
				if (renames === 3) throw new Error("EXDEV simulated"); // db and -wal moved, the install rename fails
				renameSync(from, to);
			},
		}).catch((e) => e);
		expect(error.code).toBe("restore_failed");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(existsSync(join(home, "jabbu.db-wal"))).toBe(true);
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("a failure during the move-back still restores the rest and keeps the original error (F4)", async () => {
		const file = goodBackupThenDrift();
		let renames = 0;
		const error = await runRestore({
			homeDir: home,
			source: file,
			yes: true,
			probeDaemon: noDaemon,
			rename: (from, to) => {
				renames += 1;
				if (renames === 3 || renames === 4) throw new Error("EXDEV simulated"); // install, then the -wal move-back
				renameSync(from, to);
			},
		}).catch((e) => e);
		expect(error.code).toBe("restore_failed");
		expect(error.message).toContain("EXDEV simulated");
		expect(error.message).toContain("rollback also failed: jabbu.db-wal");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		// The -wal move-back failed, so it stays parked; the empty -wal beside the db is the markerOf read itself.
		const preRestore = readdirSync(join(home, "backups")).filter((n) => n.startsWith("pre-restore-"));
		expect(preRestore).toHaveLength(1);
		expect(readFileSync(join(home, "backups", preRestore[0] as string, "jabbu.db-wal"), "utf8")).toBe("stale-wal");
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("rejects sources that are neither a daily backup name nor an absolute file", async () => {
		goodBackupThenDrift();
		for (const source of [
			"../jabbu.db",
			"jabbu.db",
			"backups/nope.db",
			"jabbu-20260101-000000.db",
			join(home, "missing.db"),
		]) {
			const error = await runRestore({ homeDir: home, source, yes: true, probeDaemon: noDaemon }).catch((e) => e);
			expect(error.code).toBe("bad_source");
		}
	});

	test("a source with a -wal beside it is refused and nothing changes", async () => {
		const file = goodBackupThenDrift();
		writeFileSync(`${file}-wal`, "pending pages");
		const error = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon }).catch((e) => e);
		expect(error.code).toBe("bad_source");
		expect(error.message).toContain("-wal");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
	});

	test("a symlinked or hard-linked source cannot dodge the -wal refusal (J-6)", async () => {
		goodBackupThenDrift();
		// The live ledger has a -wal beside it; a link to it from elsewhere must be refused like the ledger itself.
		const viaSymlink = join(home, "via-symlink.db");
		symlinkSync(join(home, "jabbu.db"), viaSymlink);
		const e1 = await runRestore({ homeDir: home, source: viaSymlink, yes: true, probeDaemon: noDaemon }).catch(
			(e) => e,
		);
		expect(e1.code).toBe("bad_source");
		expect(e1.message).toContain("-wal");
		const viaHardlink = join(home, "via-hardlink.db");
		linkSync(join(home, "jabbu.db"), viaHardlink);
		const e2 = await runRestore({ homeDir: home, source: viaHardlink, yes: true, probeDaemon: noDaemon }).catch(
			(e) => e,
		);
		expect(e2.code).toBe("bad_source");
		expect(e2.message).toContain("hard link");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
	});

	test("an empty file or a sqlite db without the jabbu tables is refused (J-7)", async () => {
		goodBackupThenDrift();
		const empty = join(home, "empty.db");
		writeFileSync(empty, "");
		const e1 = await runRestore({ homeDir: home, source: empty, yes: true, probeDaemon: noDaemon }).catch((e) => e);
		expect(e1).toBeInstanceOf(RestoreError);
		expect(e1.code).toBe("integrity_check_failed");
		const foreign = join(home, "foreign.db");
		const db = new Database(foreign, { create: true });
		db.run("CREATE TABLE other (x)");
		db.close();
		const e2 = await runRestore({ homeDir: home, source: foreign, yes: true, probeDaemon: noDaemon }).catch((e) => e);
		expect(e2.code).toBe("integrity_check_failed");
		expect(e2.message).toContain("origins");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("two restores in the same second keep both pre-restore generations (J-8)", async () => {
		const file = goodBackupThenDrift();
		const now = new Date(2026, 10, 12, 10, 0, 0);
		const first = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon, now });
		seed("second-drift");
		const second = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon, now });
		expect(second.plan.preRestoreDir).not.toBe(first.plan.preRestoreDir);
		expect(markerOf(join(first.plan.preRestoreDir, "jabbu.db"))).toBe("drifted");
		expect(markerOf(join(second.plan.preRestoreDir, "jabbu.db"))).toBe("second-drift");
	});

	test("a backup the current code cannot migrate is refused before any file moves (U2)", async () => {
		seed("drifted");
		const backup = schema8Backup(true);
		const error = await runRestore({ homeDir: home, source: backup, yes: true, probeDaemon: noDaemon }).catch((e) => e);
		expect(error).toBeInstanceOf(RestoreError);
		expect(error.code).toBe("migration_failed");
		expect(error.message).toContain("cannot open the backup");
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(
			existsSync(join(home, "backups"))
				? readdirSync(join(home, "backups")).some((n) => n.startsWith("pre-restore"))
				: false,
		).toBe(false);
		expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("an old-schema backup that migrates cleanly restores, keeping the backup's version (U2)", async () => {
		seed("drifted");
		const backup = schema8Backup(false);
		const result = await runRestore({ homeDir: home, source: backup, yes: true, probeDaemon: noDaemon });
		expect(result.applied).toBe(true);
		const db = new Database(join(home, "jabbu.db"), { readonly: true });
		try {
			// The install copy is not migrated in place: a rollback restore must hand old code a ledger at the
			// backup's own version (U1), so the check runs on a throwaway copy and the installed ledger stays at 8.
			expect(readSchemaVersion(db)).toBe(8);
		} finally {
			db.close();
		}
		const store = openStore({
			path: join(home, "jabbu.db"),
			clock: { now: () => 1_700_000_000_000 },
			timezone: "Asia/Seoul",
			redact: (text: string) => text,
		});
		try {
			// The next daemon start migrates it: the old lane origin is renamed and the stamp reaches current.
			expect(store.getOrigin(NEW_LANE)?.epoch).toBe(1);
			expect(store.getOrigin(OLD_LANE)).toBeUndefined();
		} finally {
			store.close();
		}
		const reopened = new Database(join(home, "jabbu.db"), { readonly: true });
		try {
			expect(readSchemaVersion(reopened)).toBe(SCHEMA_VERSION);
		} finally {
			reopened.close();
		}
		expect(markerOf(join(result.plan.preRestoreDir, "jabbu.db"))).toBe("drifted");
	});

	test("restores into a home that has no ledger yet", async () => {
		seed("good");
		const { file } = runBackup({ homeDir: home });
		rmSync(join(home, "jabbu.db"));
		rmSync(join(home, "jabbu.db-wal"), { force: true });
		rmSync(join(home, "jabbu.db-shm"), { force: true });
		mkdirSync(join(home, "backups"), { recursive: true });
		const result = await runRestore({ homeDir: home, source: file, yes: true, probeDaemon: noDaemon });
		expect(result.plan.moves).toEqual([]);
		expect(markerOf(join(home, "jabbu.db"))).toBe("good");
	});
});

describe("jabbu-pocket restore (CLI)", () => {
	test("exit codes: 2 without a path, 3 without --yes, 0 with --yes", async () => {
		const file = goodBackupThenDrift();
		expect(await restoreCommand([], home)).toBe(2);
		expect(await restoreCommand([file], home)).toBe(3);
		expect(markerOf(join(home, "jabbu.db"))).toBe("drifted");
		expect(await restoreCommand([file, "--yes"], home)).toBe(0);
		expect(markerOf(join(home, "jabbu.db"))).toBe("good");
	});
});
