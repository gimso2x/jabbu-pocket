import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { applyMonitors, exportMonitors, PortableApplyError, type PortableContext } from "../src/monitors/portable";
import { isWakeGateOff, MAX_SCRIPT_OUTPUT_CHARS, runScript, trimmedHash } from "../src/monitors/script";
import { LastLineTracker } from "../src/monitors/script-stream";
import { parseMonitorSpec } from "../src/monitors/spec";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { makeHome, OWNER_DM, type TestHome } from "./helpers/bot-home";
import { killSpawned, runCliCapture } from "./helpers/daemon-process";
import { isRoot } from "./helpers/privileges";

const cleanups: Array<() => void> = [];

afterEach(() => {
	killSpawned();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function home(prefix: string): TestHome {
	const h = makeHome(prefix);
	cleanups.push(h.remove);
	mkdirSync(join(h.dir, "scripts"), { recursive: true });
	return h;
}

function ctxOf(h: TestHome): PortableContext {
	return {
		scriptsRoot: join(h.dir, "scripts"),
		workspaceDir: h.config.workspaceDir,
		defaultTimezone: "Asia/Seoul",
	};
}

function ledgerOf(h: TestHome) {
	const ledger = openMonitorLedger(join(h.dir, "jabbu.db"));
	cleanups.push(() => ledger.close());
	return ledger;
}

function writeExecScript(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

describe("qa-ad #5 & #6: export failed count and resilient stale cleanup", () => {
	test.skipIf(isRoot)(
		"#5: read-only export directory reports written=0 and failed=N in API and CLI",
		async () => {
			const h = home("qa-ad-5-");
			const ledger = ledgerOf(h);
			const ctx = ctxOf(h);
			for (const name of ["alpha", "beta", "gamma"]) {
				ledger.addMonitor(
					parseMonitorSpec({ name, trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "check" }, ctx),
				);
			}
			const dir = tempDir("qa-ad-5-ro-");
			chmodSync(dir, 0o555);
			cleanups.push(() => chmodSync(dir, 0o755));

			const result = exportMonitors(ledger, dir, ctx);
			expect(result.written).toBe(0);
			expect(result.failed).toBe(3);
			expect(result.removed).toBe(0);
			expect(result.warnings.filter((w) => w.includes("not written"))).toHaveLength(3);

			const cli = await runCliCapture(h.dir, ["monitors", "export", "--dir", dir]);
			expect(cli.code).toBe(0);
			expect(cli.stdout).toBe("exported=0 removed=0 failed=3\n");
			expect(cli.stderr).toContain("monitors export: warning:");
		},
		30_000,
	);

	test.skipIf(isRoot /* root ignores permission bits, so the 0o400 file can be written (qa-ad #5) */)(
		"#5: partial write failure counts written vs failed and keeps failed target out of stale deletion",
		async () => {
			const h = home("qa-ad-5p-");
			const ledger = ledgerOf(h);
			const ctx = ctxOf(h);
			for (const name of ["alpha", "beta"]) {
				ledger.addMonitor(
					parseMonitorSpec({ name, trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "check" }, ctx),
				);
			}
			const dir = tempDir("qa-ad-5p-out-");
			writeFileSync(join(dir, "alpha.json"), "{}\n");
			chmodSync(join(dir, "alpha.json"), 0o400);
			cleanups.push(() => chmodSync(join(dir, "alpha.json"), 0o600));

			const cli = await runCliCapture(h.dir, ["monitors", "export", "--dir", dir]);
			expect(cli.code).toBe(0);
			expect(cli.stdout).toBe("exported=1 removed=0 failed=1\n");
			expect(existsSync(join(dir, "alpha.json"))).toBe(true);
			expect(existsSync(join(dir, "beta.json"))).toBe(true);

			chmodSync(join(dir, "alpha.json"), 0o600);
			const clean = await runCliCapture(h.dir, ["monitors", "export", "--dir", dir]);
			expect(clean.code).toBe(0);
			expect(clean.stdout).toBe("exported=2 removed=0\n");
		},
	);

	test.skipIf(isRoot)("#6: stale cleanup EACCES logs per-file warnings and finishes instead of crashing", async () => {
		const h = home("qa-ad-6-");
		const ledger = ledgerOf(h);
		const ctx = ctxOf(h);
		ledger.addMonitor(
			parseMonitorSpec({ name: "live", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "check" }, ctx),
		);
		const dir = tempDir("qa-ad-6-stale-");
		writeFileSync(join(dir, "stale-one.json"), "{}\n");
		writeFileSync(join(dir, "stale-two.json"), "{}\n");
		writeFileSync(join(dir, "owner.json"), JSON.stringify({ customSetting: true }));
		chmodSync(dir, 0o555);
		cleanups.push(() => chmodSync(dir, 0o755));

		const result = exportMonitors(ledger, dir, ctx);
		expect(result.written).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.removed).toBe(0);
		expect(result.warnings.some((w) => w.includes("stale-one.json") && w.includes("not removed"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("stale-two.json") && w.includes("not removed"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("owner.json"))).toBe(false);

		const cli = await runCliCapture(h.dir, ["monitors", "export", "--dir", dir]);
		expect(cli.code).toBe(0);
		expect(cli.stdout).toBe("exported=0 removed=0 failed=1\n");
		expect(cli.stderr).toContain("stale-one.json");
		expect(cli.stderr).toContain("stale-two.json");
	});
});

describe("qa-ad #7: apply rejects *.json symlinks and omits file content on read/JSON errors", () => {
	const fakeSecret = `${["xoxb", "TEST", "secret", "token"].join("-")}\n`;

	test("#7: symlink to external file and dangling symlink are refused without reading target", async () => {
		const h = home("qa-ad-7-sym-");
		const ledger = ledgerOf(h);
		const ctx = ctxOf(h);
		ledger.addMonitor(
			parseMonitorSpec(
				{ name: "existing", trigger: { kind: "cron", schedule: "30 9 * * *" }, instruction: "keep" },
				ctx,
			),
		);
		const outside = tempDir("qa-ad-7-outside-");
		const secretFile = join(outside, "discord-bot-token");
		writeFileSync(secretFile, fakeSecret);

		const dir = tempDir("qa-ad-7-dir-");
		writeFileSync(
			join(dir, "ok.json"),
			JSON.stringify({ name: "newmon", trigger: { kind: "cron", schedule: "0 8 * * *" }, instruction: "x" }),
		);
		symlinkSync(secretFile, join(dir, "leak.json"));
		symlinkSync(join(outside, "missing.json"), join(dir, "dangling.json"));

		let caught: unknown;
		try {
			applyMonitors(ledger, dir, ctx, { prune: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PortableApplyError);
		const problems = (caught as PortableApplyError).problems;
		expect(problems).toContain("leak.json: symlink is not allowed");
		expect(problems).toContain("dangling.json: symlink is not allowed");
		expect(problems.join("\n")).not.toContain("xoxb");
		expect(ledger.listMonitors().map((m) => m.name)).toEqual(["existing"]);

		const cli = await runCliCapture(h.dir, ["monitors", "apply", "--dir", dir, "--prune"]);
		expect(cli.code).toBe(2);
		expect(cli.stderr).toContain("leak.json: symlink is not allowed");
		expect(cli.stderr).toContain("dangling.json: symlink is not allowed");
		expect(cli.stderr).not.toContain("xoxb");
	});

	test("#7: invalid JSON error reports only 'not valid JSON' without leaking file content tokens", async () => {
		const h = home("qa-ad-7-json-");
		const ledger = ledgerOf(h);
		const ctx = ctxOf(h);
		const dir = tempDir("qa-ad-7-json-dir-");
		writeFileSync(join(dir, "broken.json"), fakeSecret);

		let caught: unknown;
		try {
			applyMonitors(ledger, dir, ctx);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PortableApplyError);
		expect((caught as PortableApplyError).problems).toEqual(["broken.json: not valid JSON"]);

		const cli = await runCliCapture(h.dir, ["monitors", "apply", "--dir", dir]);
		expect(cli.code).toBe(2);
		expect(cli.stderr).toContain("broken.json: not valid JSON");
		expect(cli.stderr).not.toContain("xoxb");
	});

	test.skipIf(isRoot)("#7: unreadable regular file reports only errno code without file content", () => {
		const h = home("qa-ad-7-perm-");
		const ledger = ledgerOf(h);
		const ctx = ctxOf(h);
		const dir = tempDir("qa-ad-7-perm-dir-");
		const locked = join(dir, "locked.json");
		writeFileSync(locked, fakeSecret);
		chmodSync(locked, 0o000);
		cleanups.push(() => chmodSync(locked, 0o600));

		let caught: unknown;
		try {
			applyMonitors(ledger, dir, ctx);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PortableApplyError);
		expect((caught as PortableApplyError).problems).toEqual(["locked.json: unreadable file (EACCES)"]);
	});
});

describe("qa-ad #9 & #10: script check error streak on disable and trigger edit", () => {
	test("#9: disabling a monitor mid-check drops late error/met results and blocks recordCheckError at DB level", () => {
		const h = home("qa-ad-9-");
		const script = writeExecScript(join(h.dir, "scripts"), "check.sh", "#!/bin/sh\nexit 0\n");
		let now = 1_700_000_000_000;
		const store = openStore({
			path: join(h.dir, "jabbu.db"),
			clock: { now: () => now },
			timezone: "Asia/Seoul",
			redact,
		});
		cleanups.push(() => store.close());

		const spec = parseMonitorSpec(
			{ name: "m9", trigger: { kind: "script", command: [script], intervalMs: 60_000 }, instruction: "x" },
			ctxOf(h),
		);
		const mon = store.monitors.addMonitor(spec);
		const ranTrigger = mon.trigger;

		store.monitors.recordScriptCheck({ monitorId: mon.id, ranTrigger, outcome: "error", error: "err-1", slotAt: now });
		store.monitors.recordScriptCheck({
			monitorId: mon.id,
			ranTrigger,
			outcome: "error",
			error: "err-2",
			slotAt: now + 1,
		});
		expect(store.monitors.getMonitor(mon.id)?.checkErrorStreak).toBe(2);

		store.monitors.setEnabled(mon.id, false);
		expect(store.monitors.getMonitor(mon.id)?.checkErrorStreak).toBe(0);
		expect(store.monitors.getMonitor(mon.id)?.lastCheckError).toBeNull();

		now += 1000;
		expect(
			store.monitors.recordScriptCheck({
				monitorId: mon.id,
				ranTrigger,
				outcome: "error",
				error: "timed out",
				slotAt: now,
			}),
		).toBeUndefined();
		expect(
			store.monitors.recordScriptCheck({
				monitorId: mon.id,
				ranTrigger,
				outcome: "met",
				slotAt: now + 1,
				payload: "late",
			}),
		).toBeUndefined();
		expect(store.monitors.recordCheckError(mon.id, "direct late error")).toBe(0);

		const after = store.monitors.getMonitor(mon.id);
		expect(after?.enabled).toBe(false);
		expect(after?.checkErrorStreak).toBe(0);
		expect(after?.lastCheckError).toBeNull();
		expect(after?.lastScriptState).toBeNull();
		expect(store.monitors.listEvents({ monitorId: mon.id })).toHaveLength(0);
	});

	test("#10: editing a script monitor's trigger resets check_error_streak and resolves open incidents", () => {
		const h = home("qa-ad-10-");
		const scriptA = writeExecScript(join(h.dir, "scripts"), "a.sh", "#!/bin/sh\nexit 0\n");
		const scriptB = writeExecScript(join(h.dir, "scripts"), "b.sh", "#!/bin/sh\nexit 0\n");
		let now = 1_700_000_000_000;
		const dbPath = join(h.dir, "jabbu.db");
		const store = openStore({ path: dbPath, clock: { now: () => now }, timezone: "Asia/Seoul", redact });
		cleanups.push(() => store.close());

		const origin = `discord/dm/${OWNER_DM}`;
		store.ensureOrigin(origin, "sess/e1");
		store.recordInbound({
			originKey: origin,
			platformMessageId: `${OWNER_DM}:1`,
			textRef: "hi",
			threadRef: `${OWNER_DM}:1`,
		});

		const ctx = ctxOf(h);
		const specA = parseMonitorSpec(
			{ name: "m10", trigger: { kind: "script", command: [scriptA], intervalMs: 60_000 }, instruction: "x" },
			ctx,
		);
		const mon = store.monitors.addMonitor(specA);
		const queuedEvent = store.monitors.admitManual(mon.id, "existing fire");

		for (let i = 0; i < 3; i++) {
			now += 60_000;
			store.monitors.recordScriptCheck({
				monitorId: mon.id,
				ranTrigger: mon.trigger,
				outcome: "error",
				error: "old script failed",
				slotAt: now,
			});
		}
		expect(store.monitors.getMonitor(mon.id)?.checkErrorStreak).toBe(3);

		const raw = new Database(dbPath, { readonly: true, strict: true });
		cleanups.push(() => raw.close());
		expect(raw.query("SELECT status FROM monitor_incidents WHERE monitor_id = ?").all(mon.id)).toEqual([
			{ status: "alerted" },
		]);
		expect((raw.query("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n).toBe(1);

		const specB = parseMonitorSpec(
			{ name: "m10", trigger: { kind: "script", command: [scriptB], intervalMs: 60_000 }, instruction: "x" },
			ctx,
		);
		const updated = store.monitors.updateMonitor(mon.id, specB);
		expect(updated.checkErrorStreak).toBe(0);
		expect(updated.lastCheckError).toBeNull();
		expect(updated.lastCheckErrorAt).toBeNull();
		expect(raw.query("SELECT status FROM monitor_incidents WHERE monitor_id = ?").all(mon.id)).toEqual([
			{ status: "resolved" },
		]);
		// Editing an enabled monitor's trigger must NOT skip already-admitted events.
		expect(store.monitors.getEvent(queuedEvent.eventId)?.stage).toBe("admitted");

		// New command failing 3 times must alert again from streak 1 -> 2 -> 3.
		for (let i = 0; i < 3; i++) {
			now += 60_000;
			store.monitors.recordScriptCheck({
				monitorId: mon.id,
				ranTrigger: updated.trigger,
				outcome: "error",
				error: "new script failed",
				slotAt: now,
			});
		}
		expect(store.monitors.getMonitor(mon.id)?.checkErrorStreak).toBe(3);
		expect((raw.query("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n).toBe(2);
	});
});

describe("qa-ad #31: raw-byte trimmedHash and UTF-8 StringDecoder in runScript", () => {
	test("#31: trimmedHash distinguishes non-UTF-8 byte sequences while trimming ASCII spaces", () => {
		const hashA = trimmedHash();
		hashA.update(Buffer.from(" \t\r\n"));
		hashA.update(Buffer.from([0xff, 0xfe, 0xfd]));
		hashA.update(Buffer.from("  \x0b\x0c "));

		const hashB = trimmedHash();
		hashB.update(Buffer.from([0xff, 0xfe, 0xfc]));

		const expectedA = createHash("sha256")
			.update(Buffer.from([0xff, 0xfe, 0xfd]))
			.digest("hex");
		const expectedB = createHash("sha256")
			.update(Buffer.from([0xff, 0xfe, 0xfc]))
			.digest("hex");

		expect(hashA.digest()).toBe(expectedA);
		expect(hashB.digest()).toBe(expectedB);
		expect(expectedA).not.toBe(expectedB);

		// Multi-chunk internal whitespace + non-ASCII NBSP preserved in Uint8Array mode.
		const hashMid = trimmedHash();
		hashMid.update(Buffer.from("  a"));
		hashMid.update(Buffer.from("   "));
		hashMid.update(Buffer.from([0xc2, 0xa0]));
		hashMid.update(Buffer.from("b  "));
		expect(hashMid.digest()).toBe(
			createHash("sha256")
				.update(Buffer.concat([Buffer.from("a   "), Buffer.from([0xc2, 0xa0]), Buffer.from("b")]))
				.digest("hex"),
		);

		// String mode preserves JS \s trimming (including NBSP).
		const hashStr = trimmedHash();
		hashStr.update(" \u00a0abc\n ");
		expect(hashStr.digest()).toBe(createHash("sha256").update("abc").digest("hex"));
	});

	test("#31: runScript produces distinct outputHash for distinct invalid UTF-8 bytes and decodes split UTF-8", async () => {
		const dir = tempDir("qa-ad-31-");
		const scripts = join(dir, "scripts");
		mkdirSync(scripts);

		const s1 = writeExecScript(
			scripts,
			"raw1.js",
			"#!/usr/bin/env bun\nprocess.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]));\n",
		);
		const s2 = writeExecScript(
			scripts,
			"raw2.js",
			"#!/usr/bin/env bun\nprocess.stdout.write(Buffer.from([0xff, 0xfe, 0xfc]));\n",
		);
		const r1 = await runScript([s1], { scriptsRoot: scripts, cwd: dir });
		const r2 = await runScript([s2], { scriptsRoot: scripts, cwd: dir });
		expect(r1.fired).toBe(true);
		expect(r2.fired).toBe(true);
		expect(r1.outputHash).not.toBe(r2.outputHash);
		expect(r1.outputHash).toBe(
			createHash("sha256")
				.update(Buffer.from([0xff, 0xfe, 0xfd]))
				.digest("hex"),
		);

		// Split 4-byte emoji across writes + incomplete trailing UTF-8 flushed on end().
		const split = writeExecScript(
			scripts,
			"split-utf8.js",
			`#!/usr/bin/env bun
const emoji = Buffer.from("😀");
process.stdout.write(emoji.subarray(0, 2));
process.stdout.write(emoji.subarray(2));
process.stdout.write(Buffer.from("\\n"));
process.stdout.write(Buffer.from([0xf0, 0x9f]));
`,
		);
		const splitRes = await runScript([split], { scriptsRoot: scripts, cwd: dir });
		expect(splitRes.fired).toBe(true);
		expect(splitRes.stdout).toBe("😀\n\uFFFD");
	});
});

describe("qa-ad #32: 4MiB collect boundary does not fabricate line break for wakeOff", () => {
	test("#32: LastLineTracker tracks real last non-empty line across arbitrary splits and overflows", () => {
		const tracker1 = new LastLineTracker(64);
		tracker1.update(`${"A".repeat(100)}\n{"wakeAgent":`);
		tracker1.update(` false}MORE\n\n  \r\n`);
		expect(tracker1.finish()).toEqual({ line: '{"wakeAgent": false}MORE', overflow: false });

		const tracker2 = new LastLineTracker(64);
		tracker2.update(`{"wakeAgent": false}${" ".repeat(200)}\n`);
		expect(tracker2.finish()).toEqual({ line: '{"wakeAgent": false}', overflow: false });

		const tracker3 = new LastLineTracker(64);
		tracker3.update(`{"wakeAgent": false}${"X".repeat(100)}`);
		expect(tracker3.finish().overflow).toBe(true);

		const tracker4 = new LastLineTracker(64);
		tracker4.update(`a${" ".repeat(200)}b`);
		expect(tracker4.finish().overflow).toBe(true);
	});

	test("#32: runScript distinguishes exact 4MiB boundary gate vs non-gate suffix", async () => {
		const dir = tempDir("qa-ad-32-");
		const scripts = join(dir, "scripts");
		mkdirSync(scripts);

		const falsePositive = writeExecScript(
			scripts,
			"boundary-more.js",
			`#!/usr/bin/env bun
process.stdout.write("A".repeat(4_194_283) + '\\n{"wakeAgent": false}MORE\\n');
`,
		);
		const rMore = await runScript([falsePositive], { scriptsRoot: scripts, cwd: dir });
		expect(rMore.fired).toBe(true);
		expect(rMore.wakeOff).toBe(false);
		expect(isWakeGateOff(rMore.stdout)).toBe(false);
		expect(rMore.stdout.endsWith('{"wakeAgent": false}MORE')).toBe(true);
		expect(rMore.stdout).toContain("...[truncated]...");
		expect(rMore.stdout.length).toBeLessThanOrEqual(MAX_SCRIPT_OUTPUT_CHARS);

		const realGate = writeExecScript(
			scripts,
			"boundary-gate.js",
			`#!/usr/bin/env bun
process.stdout.write("A".repeat(4_194_283) + '\\n{"wakeAgent": false}\\n');
`,
		);
		const rGate = await runScript([realGate], { scriptsRoot: scripts, cwd: dir });
		expect(rGate.fired).toBe(true);
		expect(rGate.wakeOff).toBe(true);
		expect(isWakeGateOff(rGate.stdout)).toBe(true);
		expect(rGate.stdout.endsWith('{"wakeAgent": false}')).toBe(true);
		expect(rGate.stdout).toContain("...[truncated]...");
		expect(rGate.stdout.length).toBeLessThanOrEqual(MAX_SCRIPT_OUTPUT_CHARS);

		// A single >64KiB line past 4MiB overflows LastLineTracker -> wakeOff must be false.
		const longLine = writeExecScript(
			scripts,
			"long-last.js",
			`#!/usr/bin/env bun
process.stdout.write("A".repeat(4_194_283) + "\\n" + "B".repeat(70_000) + '{"wakeAgent": false}');
`,
		);
		const rLong = await runScript([longLine], { scriptsRoot: scripts, cwd: dir });
		expect(rLong.fired).toBe(true);
		expect(rLong.wakeOff).toBe(false);
		expect(isWakeGateOff(rLong.stdout)).toBe(false);
		expect(rLong.stdout.length).toBeLessThanOrEqual(MAX_SCRIPT_OUTPUT_CHARS);

		// 4MiB of leading whitespace before a gate line still keeps the gate without spurious leading newline.
		const spaceLead = writeExecScript(
			scripts,
			"space-lead.js",
			`#!/usr/bin/env bun
process.stdout.write(" ".repeat(4_194_304) + '{"wakeAgent": false}\\n');
`,
		);
		const rSpaces = await runScript([spaceLead], { scriptsRoot: scripts, cwd: dir });
		expect(rSpaces.fired).toBe(true);
		expect(rSpaces.wakeOff).toBe(true);
		expect(rSpaces.stdout).toBe('{"wakeAgent": false}');
	});
});
