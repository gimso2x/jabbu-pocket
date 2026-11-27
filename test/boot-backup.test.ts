import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBootBackup } from "../src/daemon/boot-backup";
import { readStamp } from "../src/ops/backup";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-boot-backup-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("startBootBackup", () => {
	test("runs the backup in a worker and resolves with its result", async () => {
		new Database(join(home, "jabbu.db")).close();
		const result = await startBootBackup({ homeDir: home }, new Date()).done;
		expect(result.file).toContain("backups");
		expect(readStamp(join(home, "backups"))).toBeDefined();
	});

	test("a failing backup rejects instead of hanging", async () => {
		// No jabbu.db at all: runBackup throws db_missing inside the worker.
		await expect(startBootBackup({ homeDir: home }, new Date()).done).rejects.toThrow("db_missing");
	});
});
