import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDeps } from "../src/cli/apply";
import { restoreLedgerForRollback } from "../src/ops/apply-rollback-db";
import type { Runner } from "../src/ops/run-types";
import { openStore } from "../src/store/db";

let root: string;
let home: string;
let repo: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jabbu-rollback-db-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(join(repo, "src", "store"), { recursive: true });
	writeFileSync(join(home, "config.json"), '{"v":"before"}', { mode: 0o600 });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * A ledger file stamped at `version`; with `tables`, a real jabbu ledger `runRestore` accepts — built with
 * `openStore`, then stamped back down. The old three one-column-table stub passed the shallow checks but no daemon
 * could open it, and restore now refuses such a backup (U2). Without `tables` the file is version-only, for the
 * tests that only compare `user_version`.
 */
function writeLedger(path: string, version: number, tables = false): void {
	if (!tables) {
		const db = new Database(path);
		db.run(`PRAGMA user_version = ${version}`);
		db.close();
		return;
	}
	const store = openStore({
		path,
		clock: { now: () => Date.now() },
		timezone: "Asia/Seoul",
		redact: (text: string) => text,
	});
	store.close();
	const db = new Database(path);
	db.run(`PRAGMA user_version = ${version}`);
	db.close();
	for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
}

function writeSchemaVersion(version: number): void {
	writeFileSync(join(repo, "src", "store", "schema-version.ts"), `export const SCHEMA_VERSION = ${version};\n`);
}

function ledgerVersion(path: string): number {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	} finally {
		db.close();
	}
}

describe("restoreLedgerForRollback", () => {
	test("no ledger: nothing to restore, no stop, no restore call", async () => {
		writeSchemaVersion(12);
		const calls: string[][] = [];
		let restores = 0;
		const run: Runner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", stderr: "" };
		};
		const result = await restoreLedgerForRollback(
			{
				run,
				restoreBackup: async () => {
					restores += 1;
					return { ok: true, detail: "db restored (test stub)" };
				},
			},
			{ homeDir: home, repoDir: repo, unit: "jabbu" },
			join(home, "backups", "jabbu-20261030-050000.db"),
		);
		expect(result).toEqual({ ok: true, detail: "" });
		expect(calls).toEqual([]);
		expect(restores).toBe(0);
	});

	test("ledger not newer: nothing to restore, no stop, no restore call", async () => {
		writeLedger(join(home, "jabbu.db"), 12);
		writeSchemaVersion(12);
		const calls: string[][] = [];
		let restores = 0;
		const run: Runner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", stderr: "" };
		};
		const result = await restoreLedgerForRollback(
			{
				run,
				restoreBackup: async () => {
					restores += 1;
					return { ok: true, detail: "db restored (test stub)" };
				},
			},
			{ homeDir: home, repoDir: repo, unit: "jabbu" },
			join(home, "backups", "jabbu-20261030-050000.db"),
		);
		expect(result).toEqual({ ok: true, detail: "" });
		expect(calls).toEqual([]);
		expect(restores).toBe(0);
	});

	test("ledger newer, no backup recorded: fails fast naming jabbu-pocket restore <backup db>", async () => {
		writeLedger(join(home, "jabbu.db"), 13);
		writeSchemaVersion(12);
		const calls: string[][] = [];
		let restores = 0;
		const run: Runner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", stderr: "" };
		};
		const result = await restoreLedgerForRollback(
			{
				run,
				restoreBackup: async () => {
					restores += 1;
					return { ok: true, detail: "db restored (test stub)" };
				},
			},
			{ homeDir: home, repoDir: repo, unit: "jabbu" },
			undefined,
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("ledger schema v13 > rolled-back code v12");
		expect(result.detail).toContain("jabbu-pocket restore <backup db>");
		expect(calls).toEqual([]);
		expect(restores).toBe(0);
	});

	test("ledger newer, no restore dep: fails fast naming jabbu-pocket restore <backup>", async () => {
		writeLedger(join(home, "jabbu.db"), 13);
		writeSchemaVersion(12);
		const calls: string[][] = [];
		const run: Runner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", stderr: "" };
		};
		const backupFile = join(home, "backups", "jabbu-20261030-050000.db");
		const result = await restoreLedgerForRollback({ run }, { homeDir: home, repoDir: repo, unit: "jabbu" }, backupFile);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain(`jabbu-pocket restore ${backupFile}`);
		expect(calls).toEqual([]);
	});

	test("ledger newer, restore ok: stops the daemon first, then restores", async () => {
		writeLedger(join(home, "jabbu.db"), 13);
		writeSchemaVersion(12);
		const order: string[] = [];
		const run: Runner = async (cmd) => {
			order.push(`run:${cmd.join(" ")}`);
			return { code: 0, stdout: "", stderr: "" };
		};
		const backupFile = join(home, "backups", "jabbu-20261030-050000.db");
		const result = await restoreLedgerForRollback(
			{
				run,
				restoreBackup: async (file) => {
					order.push(`restore:${file}`);
					return { ok: true, detail: "db restored (test stub)" };
				},
			},
			{ homeDir: home, repoDir: repo, unit: "jabbu" },
			backupFile,
		);
		expect(result.ok).toBe(true);
		expect(result.detail).toContain("ledger schema v13 > rolled-back code v12");
		expect(result.detail).toContain(`db restored from ${backupFile}`);
		expect(order).toEqual(["run:systemctl --user stop jabbu", `restore:${backupFile}`]);
	});

	test("a stop that fails names the manual restore and never touches the backup", async () => {
		writeLedger(join(home, "jabbu.db"), 13);
		writeSchemaVersion(12);
		let restores = 0;
		const run: Runner = async () => ({ code: 1, stdout: "", stderr: "unit gone" });
		const backupFile = join(home, "backups", "jabbu-20261030-050000.db");
		const result = await restoreLedgerForRollback(
			{
				run,
				restoreBackup: async () => {
					restores += 1;
					return { ok: true, detail: "db restored (test stub)" };
				},
			},
			{ homeDir: home, repoDir: repo, unit: "jabbu" },
			backupFile,
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("systemctl stop rc=1");
		expect(result.detail).toContain(`jabbu-pocket restore ${backupFile}`);
		expect(restores).toBe(0);
	});
});

describe("homeDeps restoreBackup wiring", () => {
	test("the wired restore installs the snapshot through runRestore", async () => {
		mkdirSync(join(home, "backups"), { recursive: true });
		mkdirSync(join(home, "secrets"), { mode: 0o700 });
		writeFileSync(join(home, "secrets", "bot.token"), "TEST-discord-0\n", { mode: 0o600 });
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				schemaVersion: 1,
				channels: {
					discord: {
						ownerUserId: "100000000000000001",
						applicationId: "600000000000000000",
						botTokenFile: "secrets/bot.token",
					},
				},
				ompExecutable: "/usr/local/bin/omp",
				workspaceDir: "workspace",
			}),
		);
		writeLedger(join(home, "jabbu.db"), 13, true);
		const backupFile = join(home, "backups", "jabbu-20261030-050000.db");
		writeLedger(backupFile, 12, true);
		const result = await homeDeps(home, "jabbu", "/usr/bin").restoreBackup?.(backupFile);
		expect(result?.ok).toBe(true);
		expect(result?.detail).toContain(`db restored from ${backupFile}`);
		expect(ledgerVersion(join(home, "jabbu.db"))).toBe(12);
		const preRestore = readdirSync(join(home, "backups")).filter((name) => name.startsWith("pre-restore-"));
		expect(preRestore).toHaveLength(1);
		expect(ledgerVersion(join(home, "backups", preRestore[0] as string, "jabbu.db"))).toBe(13);
	});
});
