import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { applyMonitors, exportMonitors } from "../src/monitors/portable";
import { parseMonitorSpec } from "../src/monitors/spec";
import { runBackup } from "../src/ops/backup";
import { gcSessions } from "../src/ops/gc";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { dailyBackupNames, seedDb } from "./helpers/backup-fixtures";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { runBounded } from "./helpers/bounded-child";
import { runCliCapture } from "./helpers/daemon-process";
import { isRoot } from "./helpers/privileges";

// qa-z ops/store fixes: backup, gc and monitor export items.

const NOW = new Date(2026, 10, 23, 4, 30, 0);
const cleanups: Array<() => void> = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A home whose `jabbu.db` is a real ledger (what `gc` reads), without a config.json. */
function ledgerHome(): string {
	const home = tempDir("jabbu-qa-z-store-");
	const store = openStore({
		timezone: "Asia/Seoul",
		path: join(home, "jabbu.db"),
		clock: { now: () => Date.now() },
		redact,
	});
	store.close();
	return home;
}

describe("qa-z #6: gc refuses a FIFO ledger", () => {
	test("gc on a home whose jabbu.db is a FIFO fails fast instead of blocking", async () => {
		const home = tempDir("jabbu-qa-z-gc-fifo-");
		expect(Bun.spawnSync(["mkfifo", join(home, "jabbu.db")]).exitCode).toBe(0);
		const gcModule = join(import.meta.dir, "..", "src", "ops", "gc");
		const result = await runBounded(
			`const { gcSessions } = await import(${JSON.stringify(gcModule)});
			 try { gcSessions({ homeDir: ${JSON.stringify(home)}, retentionDays: 30, now: Date.now() }); console.log("ran"); }
			 catch (error) { console.log(String(error)); }`,
			10_000,
		);
		expect(result.timedOut).toBe(false);
		expect(result.stdout).toContain("ledger is not a regular file");
	});
});

describe("qa-z backup", () => {
	let home: string;
	beforeEach(() => {
		home = tempDir("jabbu-qa-z-backup-");
		seedDb(home);
	});

	test("#17: a symlinked token in secrets/ still guards its inode against a hard link in a source", () => {
		const real = join(tempDir("jabbu-qa-z-token-"), "real.token");
		writeFileSync(real, "TEST-discord-0\n");
		mkdirSync(join(home, "secrets"));
		symlinkSync(real, join(home, "secrets", "bot.token"));
		mkdirSync(join(home, "workspace"));
		linkSync(real, join(home, "workspace", "leak.txt"));
		expect(() => runBackup({ homeDir: home, now: NOW })).toThrow(/hard link to a secrets\/ file/);
		expect(dailyBackupNames(home)).toEqual([]);
	});

	test("#18: a source holding only a socket is bundled instead of failing the backup", () => {
		mkdirSync(join(home, "workspace"));
		const socket = Bun.listen({ unix: join(home, "workspace", "s.sock"), socket: { data() {} } });
		try {
			const result = runBackup({ homeDir: home, now: NOW });
			expect(result.bundle).toBeDefined();
		} finally {
			socket.stop(true);
		}
	});

	test("#56: a file or a dangling link in the place of backups/ is a BackupError, not a raw EEXIST", () => {
		writeFileSync(join(home, "backups"), "x");
		expect(() => runBackup({ homeDir: home, now: NOW })).toThrow(/^backups_not_a_directory/);
		rmSync(join(home, "backups"));
		symlinkSync(join(home, "nowhere"), join(home, "backups"));
		expect(() => runBackup({ homeDir: home, now: NOW })).toThrow(/^backups_not_a_directory/);
	});

	test("#68: a plain source of the wrong kind fails the bundle", () => {
		writeFileSync(join(home, "sessions"), "not a directory");
		expect(() => runBackup({ homeDir: home, now: NOW })).toThrow(/sessions is the wrong kind of file/);
		rmSync(join(home, "sessions"));
		mkdirSync(join(home, "config.json"));
		expect(() => runBackup({ homeDir: home, now: NOW })).toThrow(/config.json is the wrong kind of file/);
	});
});

describe("qa-z gc", () => {
	test("#19: an unreadable lane directory does not fail gc after the deletions were committed", () => {
		if (isRoot) return; // root reads a 0o000 directory
		const home = ledgerHome();
		const lane = join(home, "lanes", "L-locked");
		mkdirSync(join(lane, "artifacts"), { recursive: true });
		chmodSync(lane, 0o000);
		cleanups.push(() => chmodSync(lane, 0o700));
		const result = gcSessions({ homeDir: home, retentionDays: 30, now: Date.now() + 365 * 24 * 60 * 60 * 1000 });
		expect(result.laneArtifactsRemoved).toEqual([]);
	});

	test("#58: gc runs on a db-only home with no config.json, on the default retention", async () => {
		const home = ledgerHome();
		const result = await runCliCapture(home, ["gc", "--dry-run"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("gc_done would_remove=0");
	});
});

describe("qa-z monitors export", () => {
	let h: TestHome;
	const ctx = () => ({
		scriptsRoot: join(h.dir, "scripts"),
		workspaceDir: h.config.workspaceDir,
		webhook: { port: 1 },
		defaultTimezone: "Asia/Seoul",
	});
	const ledger = () => {
		const opened = openMonitorLedger(join(h.dir, "jabbu.db"));
		cleanups.push(() => opened.close());
		return opened;
	};
	const add = (led: ReturnType<typeof ledger>, name: string, extra: Record<string, unknown> = {}) =>
		led.addMonitor(
			parseMonitorSpec({ name, trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "x", ...extra }, ctx()),
		);
	beforeEach(() => {
		h = makeHome("qa-z-store-export-");
		cleanups.push(h.remove);
		mkdirSync(join(h.dir, "scripts"));
	});

	test("#50: an owner's *.json with a monitor's stem is kept; the monitor lands under a suffix and a warning", () => {
		const led = ledger();
		add(led, "notes");
		const dir = tempDir("qa-z-export-");
		writeFileSync(join(dir, "notes.json"), '{"mine":true}\n');
		const { warnings } = exportMonitors(led, dir, ctx());
		expect(readFileSync(join(dir, "notes.json"), "utf8")).toBe('{"mine":true}\n');
		expect(JSON.parse(readFileSync(join(dir, "notes-2.json"), "utf8")).name).toBe("notes");
		expect(warnings.some((w) => w.includes("notes.json belongs to the owner"))).toBe(true);
		// Exporting again keeps the owner file and reuses the suffixed one.
		exportMonitors(led, dir, ctx());
		expect(readFileSync(join(dir, "notes.json"), "utf8")).toBe('{"mine":true}\n');
		expect(readdirSync(dir).sort()).toEqual(["notes-2.json", "notes.json"]);
	});

	test("#51: a *.json whose name is not valid UTF-8 does not abort the stale cleanup", () => {
		const led = ledger();
		add(led, "keep");
		const dir = tempDir("qa-z-export-");
		writeFileSync(join(dir, "gone.json"), "{}\n");
		writeFileSync(Buffer.concat([Buffer.from(`${dir}/bad`), Buffer.from([0xff]), Buffer.from(".json")]), "{}\n");
		const result = exportMonitors(led, dir, ctx());
		expect(result.removed).toBe(1);
		expect(existsSync(join(dir, "gone.json"))).toBe(false);
	});

	test("#111: a 63-emoji name exports under a file name within 255 bytes, distinct per name", () => {
		const led = ledger();
		const a = `${"\u{1F600}".repeat(63)}a`;
		const b = `${"\u{1F600}".repeat(63)}b`;
		add(led, a);
		add(led, b);
		const dir = tempDir("qa-z-export-");
		exportMonitors(led, dir, ctx());
		const files = readdirSync(dir);
		expect(files).toHaveLength(2);
		for (const file of files) expect(Buffer.byteLength(file)).toBeLessThanOrEqual(255);
		const names = files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")).name).sort();
		expect(names).toEqual([a, b].sort());
	});

	test("#112: a short option glued to an absolute path (-o/abs) becomes a placeholder and applies back", () => {
		const led = ledger();
		const out = join(h.dir, "scripts", "out.txt");
		const script = join(h.dir, "scripts", "run.sh");
		writeFileSync(script, "#!/bin/sh\n");
		chmodSync(script, 0o755);
		add(led, "glued", {
			trigger: { kind: "script", command: [script, `-o${out}`], intervalMs: 300_000 },
		});
		const dir = tempDir("qa-z-export-");
		exportMonitors(led, dir, ctx());
		const exported = JSON.parse(readFileSync(join(dir, "glued.json"), "utf8"));
		expect(exported.trigger.command).toEqual(["@SCRIPTS@/run.sh", "-o@SCRIPTS@/out.txt"]);
		const other = makeHome("qa-z-store-apply-");
		cleanups.push(other.remove);
		mkdirSync(join(other.dir, "scripts"));
		writeFileSync(join(other.dir, "scripts", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
		const target = openMonitorLedger(join(other.dir, "jabbu.db"));
		cleanups.push(() => target.close());
		applyMonitors(target, dir, {
			scriptsRoot: join(other.dir, "scripts"),
			workspaceDir: other.config.workspaceDir,
			webhook: { port: 1 },
			defaultTimezone: "Asia/Seoul",
		});
		const [row] = target.listMonitors();
		expect(row?.trigger).toMatchObject({
			command: [join(other.dir, "scripts", "run.sh"), `-o${join(other.dir, "scripts", "out.txt")}`],
		});
	});

	test("#113: --with-files drops the copies of a deleted monitor on the next export", () => {
		const led = ledger();
		const script = join(h.dir, "scripts", "gone.sh");
		writeFileSync(script, "#!/bin/sh\n");
		chmodSync(script, 0o755);
		const doomed = add(led, "doomed", { trigger: { kind: "script", command: [script], intervalMs: 300_000 } });
		const dir = tempDir("qa-z-export-");
		exportMonitors(led, dir, ctx(), { withFiles: true });
		expect(existsSync(join(dir, "files", "scripts", "gone.sh"))).toBe(true);
		led.removeMonitor(doomed.id);
		exportMonitors(led, dir, ctx(), { withFiles: true });
		expect(existsSync(join(dir, "files", "scripts", "gone.sh"))).toBe(false);
		expect(existsSync(join(dir, "doomed.json"))).toBe(false);
	});

	test("#114: a directory in a monitor's file slot warns and the rest is still exported and cleaned", () => {
		const led = ledger();
		add(led, "a");
		add(led, "b");
		const dir = tempDir("qa-z-export-");
		mkdirSync(join(dir, "a.json"));
		writeFileSync(join(dir, "stale.json"), "{}\n");
		const result = exportMonitors(led, dir, ctx());
		expect(result.written).toBe(2);
		expect(result.removed).toBe(1);
		expect(existsSync(join(dir, "a-2.json"))).toBe(true);
		expect(existsSync(join(dir, "b.json"))).toBe(true);
	});

	test("#114: a write that fails is a warning, and the stale cleanup still runs", () => {
		if (isRoot) return; // root writes into a read-only file
		const led = ledger();
		add(led, "a");
		add(led, "b");
		const dir = tempDir("qa-z-export-");
		writeFileSync(join(dir, "a.json"), "{}\n");
		chmodSync(join(dir, "a.json"), 0o400);
		writeFileSync(join(dir, "stale.json"), "{}\n");
		const result = exportMonitors(led, dir, ctx());
		expect(result.warnings.some((w) => w.startsWith("a: not written"))).toBe(true);
		expect(existsSync(join(dir, "b.json"))).toBe(true);
		expect(existsSync(join(dir, "stale.json"))).toBe(false);
	});

	test("#117: --with-files does not copy a script that is a hard link to a secrets/ file", () => {
		const led = ledger();
		mkdirSync(join(h.dir, "secrets"), { recursive: true });
		const secret = join(h.dir, "secrets", "api-key");
		writeFileSync(secret, "#!/bin/sh\n# TEST-secret-0\n");
		chmodSync(secret, 0o755);
		const leak = join(h.dir, "scripts", "leak.sh");
		linkSync(secret, leak);
		add(led, "leaky", { trigger: { kind: "script", command: [leak], intervalMs: 300_000 } });
		const dir = tempDir("qa-z-export-");
		const { warnings } = exportMonitors(led, dir, ctx(), { withFiles: true });
		expect(existsSync(join(dir, "files", "scripts", "leak.sh"))).toBe(false);
		expect(warnings.some((w) => w.includes("hard link to a secrets/ file"))).toBe(true);
	});
});
