import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDeps } from "../src/cli/apply";
import { checkBackupMigratesCommand } from "../src/cli/check-backup-migrates";
import { openBotStore } from "../src/core/origin";
import { applyPathEnv } from "../src/ops/apply";
import { SCHEMA_VERSION } from "../src/store/schema-version";

const REPO_ROOT = join(import.meta.dir, "..");
const MAIN = join(REPO_ROOT, "src", "main.ts");

let root: string;
let home: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jabbu-check-backup-"));
	home = join(root, "home");
	mkdirSync(home, { mode: 0o700 });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A ledger this checkout's code opens (stamped at SCHEMA_VERSION by the open itself). */
function migratableBackup(): string {
	const path = join(home, "jabbu.db");
	openBotStore(path, { now: () => Date.now() }, "Asia/Seoul").close();
	return path;
}

/** The same ledger re-stamped as written by newer code: this code refuses it with `newer_schema`. */
function unmigratableBackup(): string {
	const path = migratableBackup();
	const db = new Database(path);
	db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
	db.close();
	return path;
}

function captureStderr(): { written: string[]; restore: () => void } {
	const written: string[] = [];
	const write = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		written,
		restore: () => {
			process.stderr.write = write;
		},
	};
}

describe("check-backup-migrates command", () => {
	test("a ledger this code can open exits 0", () => {
		expect(checkBackupMigratesCommand([migratableBackup(), "--home", home])).toBe(0);
	});

	test("a ledger written by newer code exits 1 and names the cause", () => {
		const captured = captureStderr();
		try {
			expect(checkBackupMigratesCommand([unmigratableBackup(), "--home", home])).toBe(1);
		} finally {
			captured.restore();
		}
		expect(captured.written.join("")).toContain("this code cannot open the ledger snapshot");
	});

	test("no backup argument exits 2", () => {
		const captured = captureStderr();
		try {
			expect(checkBackupMigratesCommand([])).toBe(2);
		} finally {
			captured.restore();
		}
		expect(captured.written.join("")).toContain("check-backup-migrates: <backup> is required");
	});

	test("as a fresh process it loads the checkout's code from disk", () => {
		const ok = Bun.spawnSync([process.execPath, MAIN, "check-backup-migrates", migratableBackup(), "--home", home], {
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(ok.exitCode, ok.stderr.toString()).toBe(0);
		const refused = Bun.spawnSync(
			[process.execPath, MAIN, "check-backup-migrates", unmigratableBackup(), "--home", home],
			{ env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
		);
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr.toString()).toContain("this code cannot open the ledger snapshot");
	});
});

describe("homeDeps revalidateBackup wiring", () => {
	test("it runs the check in a fresh process and refuses a backup the new code cannot open", async () => {
		const revalidate = homeDeps(home, "jabbu", applyPathEnv(process.env)).revalidateBackup;
		if (revalidate === undefined) throw new Error("homeDeps has no revalidateBackup");
		await revalidate(migratableBackup());
		await expect(revalidate(unmigratableBackup())).rejects.toThrow("the new code cannot open the ledger snapshot");
	});
});
