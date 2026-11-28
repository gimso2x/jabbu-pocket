import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GatesCommandDeps, gatesCommand } from "../src/cli/gates";
import { readSweepHeartbeat, SweepHeartbeatWriter } from "../src/daemon/heartbeat";
import { currentBootId } from "../src/daemon/lock";
import { readStatusFromDb } from "../src/daemon/status";
import { gateText } from "../src/dashboard/text";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { APPLY_LOCK_FILE } from "../src/ops/apply-lock";
import { STAMP_FILE } from "../src/ops/backup";
import { clearFreeze, writeFreeze } from "../src/ops/freeze";
import {
	collectGates,
	DRAIN_ORPHANED_MS,
	GATE_NAMES,
	gateOptionsFromConfig,
	INBOUND_STARVATION_MS,
	MONITOR_OVERDUE_MS,
	ORIGIN_SILENT_MS,
	SOCKET_DOWN_MS,
	SWEEP_STALLED_MS,
} from "../src/ops/gates";
import { HERDR_HEALTH_FILE, HERDR_HEALTH_STALE_MS, HerdrHealthProbe, readHerdrHealth } from "../src/ops/herdr-health";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { ROOMY_STATFS, testHostLoad, testStatfs } from "../src/ops/test-host-hooks";
import { localDay } from "../src/time";

let home: string;
let now: number;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-gates-"));
	now = Date.now();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const DDL = `
CREATE TABLE inbound (
	inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
	platform_message_id TEXT NOT NULL UNIQUE,
	origin_key TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	text_ref TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	dispatched_at INTEGER,
	last_event_at INTEGER
);
CREATE TABLE deliveries (
	delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
	origin_key TEXT NOT NULL,
	op_ref TEXT NOT NULL,
	part INTEGER NOT NULL,
	thread_ref TEXT NOT NULL,
	body TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	redelivered INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_error TEXT,
	UNIQUE (origin_key, op_ref, part)
);
CREATE TABLE lanes (
	name TEXT PRIMARY KEY,
	status TEXT NOT NULL DEFAULT 'working',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE monitors (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE monitor_events (
	event_id INTEGER PRIMARY KEY AUTOINCREMENT,
	monitor_id TEXT NOT NULL,
	slot_at INTEGER NOT NULL,
	stage TEXT NOT NULL,
	payload TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER,
	inbound_id TEXT,
	answer TEXT,
	error TEXT,
	delivery_id INTEGER,
	skipped_by INTEGER,
	manual INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

function seedDb(mutate: (db: Database) => void): void {
	const db = new Database(join(home, "jabbu.db"), { create: true, strict: true });
	db.run(DDL);
	mutate(db);
	db.close();
}

function gateState(name: string): { state: string; detail: string } {
	const gate = collectGates({ homeDir: home, now }).find((g) => g.name === name);
	if (gate === undefined) throw new Error(`gate ${name} not found`);
	return { state: gate.state, detail: gate.detail };
}

/** Writes a stamp whose ts field is `ageMs` in the past. */
function writeStamp(ageMs: number): void {
	mkdirSync(join(home, "backups"), { recursive: true });
	writeFileSync(
		join(home, "backups", STAMP_FILE),
		`ts=${new Date(now - ageMs).toISOString()} file=jabbu-x.db bytes=1 sha256=abc integrity=ok check=quick_check\n`,
	);
}

/** Writes a sweep heartbeat `ageMs` old (fake clock: no waiting), optionally with an observed loop delay. */
function writeHeartbeat(ageMs: number, loopMs = 0): void {
	writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now - ageMs).toISOString()} loop_ms=${loopMs}\n`, {
		mode: 0o600,
	});
}

describe("collectGates", () => {
	describe("host resources", () => {
		const GIB = 1024 ** 3;
		/** `statfs` answering `[free, total]` GiB per path (4 KiB blocks); any other path cannot be asked. */
		const statfs =
			(disks: Record<string, [number, number]>) =>
			(path: string): { bavail: number; blocks: number; bsize: number } => {
				const disk = disks[path];
				if (disk === undefined) throw new Error(`ENOENT: ${path}`);
				return { bavail: (disk[0] * GIB) / 4096, blocks: (disk[1] * GIB) / 4096, bsize: 4096 };
			};
		const diskGate = (disks: Record<string, [number, number]>, paths = Object.keys(disks)) =>
			collectGates({ homeDir: home, now, diskPaths: paths, statfs: statfs(disks) }).find((g) => g.name === "disk_low");
		const MEMINFO = (availableKb: number, totalKb = 1_000_000) =>
			`MemTotal:       ${totalKb} kB\nMemFree:          1000 kB\nMemAvailable:   ${availableKb} kB\n`;
		const pressure = (load15: number, cpuCount: number, meminfo: string | undefined) =>
			collectGates({
				homeDir: home,
				now,
				hostLoad: {
					loadavg: () => [0, 0, load15],
					cpuCount: () => cpuCount,
					meminfo: () => meminfo,
					cgroup: () => undefined,
				},
			}).find((g) => g.name === "host_pressure");

		test("AC-6: disk_low opens under 5 GiB or under 10% free, whichever trips first", () => {
			expect(diskGate({ "/a": [4, 100] })).toEqual({
				name: "disk_low",
				state: "open",
				detail: "path=/a free_gib=4.0 pct=4",
			});
			expect(diskGate({ "/a": [8, 50] })).toEqual({
				name: "disk_low",
				state: "closed",
				detail: "path=/a free_gib=8.0 pct=16",
			});
			expect(diskGate({ "/a": [20, 400] })).toMatchObject({ state: "open", detail: "path=/a free_gib=20.0 pct=5" });
			// Exactly 5 GiB and exactly 10% are not low.
			expect(diskGate({ "/a": [5, 50] })?.state).toBe("closed");
		});

		test("disk_low: any low path opens it and the detail names the tightest; unreadable paths are skipped", () => {
			expect(diskGate({ "/home": [80, 100], "/agent": [4, 100], "/x": [9, 100] })).toMatchObject({
				state: "open",
				detail: "path=/agent free_gib=4.0 pct=4",
			});
			expect(diskGate({ "/home": [80, 100] }, ["/home", "/gone"])).toMatchObject({
				state: "closed",
				detail: "path=/home free_gib=80.0 pct=80",
			});
			expect(diskGate({}, ["/gone"])).toEqual({ name: "disk_low", state: "closed", detail: "statfs=unavailable" });
		});

		test("AC-6: host_pressure opens at load15 >= 2 x cpus or MemAvailable under 5%, closed otherwise", () => {
			expect(pressure(8, 4, MEMINFO(500_000))).toEqual({
				name: "host_pressure",
				state: "open",
				detail: "load15=8.00 cpus=4 mem_avail_pct=50 cgroup=absent cgroup_high_free_pct=? cgroup_hard_free_pct=?",
			});
			expect(pressure(7.99, 4, MEMINFO(500_000))?.state).toBe("closed");
			expect(pressure(0.5, 4, MEMINFO(49_999))).toMatchObject({
				state: "open",
				detail: "load15=0.50 cpus=4 mem_avail_pct=4 cgroup=absent cgroup_high_free_pct=? cgroup_hard_free_pct=?",
			});
			expect(pressure(0.5, 4, MEMINFO(50_000))?.state).toBe("closed");
			expect(pressure(1, 4, undefined)).toMatchObject({
				state: "closed",
				detail: "load15=1.00 cpus=4 mem_avail_pct=unknown cgroup=absent cgroup_high_free_pct=? cgroup_hard_free_pct=?",
			});
		});

		test("host_pressure opens on a tight cgroup budget and names version·pcts·incompleteness in the detail", () => {
			const budget = (pct: number) => ({
				path: "/cg/app.slice",
				limitBytes: 1000,
				currentBytes: 1000 - Math.round(10 * pct),
				reclaimableBytes: 0,
				chargedFreePct: pct,
				freePct: pct,
			});
			const tight = (highPct: number | null, hardPct: number | null, incomplete = false) =>
				collectGates({
					homeDir: home,
					now,
					hostLoad: {
						loadavg: () => [0, 0, 0],
						cpuCount: () => 4,
						meminfo: () => MEMINFO(500_000),
						cgroup: () => ({
							version: 2,
							hard: hardPct === null ? null : budget(hardPct),
							high: highPct === null ? null : budget(highPct),
							incomplete,
						}),
					},
				}).find((g) => g.name === "host_pressure");
			// 9% free on the tightest visible budget: open at the 10% floor, with the pcts in the detail.
			expect(tight(null, 9)).toEqual({
				name: "host_pressure",
				state: "open",
				detail: "load15=0.00 cpus=4 mem_avail_pct=50 cgroup=v2 cgroup_high_free_pct=? cgroup_hard_free_pct=9",
			});
			expect(tight(9.9, 60)).toMatchObject({
				state: "open",
				detail: "load15=0.00 cpus=4 mem_avail_pct=50 cgroup=v2 cgroup_high_free_pct=9 cgroup_hard_free_pct=60",
			});
			// Exactly 10% is not under the floor; an incomplete read alone never opens the gate.
			expect(tight(10, 10)?.state).toBe("closed");
			expect(tight(null, null, true)).toMatchObject({
				state: "closed",
				detail:
					"load15=0.00 cpus=4 mem_avail_pct=50 cgroup=v2 cgroup_high_free_pct=? cgroup_hard_free_pct=? cgroup_incomplete=1",
			});
			// A read that found no hierarchy at all says so.
			expect(
				collectGates({
					homeDir: home,
					now,
					hostLoad: {
						loadavg: () => [0, 0, 0],
						cpuCount: () => 4,
						meminfo: () => MEMINFO(500_000),
						cgroup: () => ({ version: null, hard: null, high: null, incomplete: false }),
					},
				}).find((g) => g.name === "host_pressure"),
			).toMatchObject({
				state: "closed",
				detail: "load15=0.00 cpus=4 mem_avail_pct=50 cgroup=none cgroup_high_free_pct=? cgroup_hard_free_pct=?",
			});
		});

		test("both gates sit with the filesystem gates, so a missing ledger still reports them", () => {
			const names = collectGates({
				homeDir: home,
				now,
				diskPaths: ["/a"],
				statfs: statfs({ "/a": [50, 100] }),
				hostLoad: {
					loadavg: () => [0, 0, 0],
					cpuCount: () => 4,
					meminfo: () => MEMINFO(500_000),
					cgroup: () => undefined,
				},
			}).map((g) => g.name);
			expect(names.slice(names.indexOf("frozen"), names.indexOf("inbound_starved"))).toEqual([
				"frozen",
				"disk_low",
				"host_pressure",
			]);
		});
	});

	test("all gates close for a freshly backed-up, idle bot", () => {
		writeStamp(0);
		writeHeartbeat(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at) VALUES ('C:1.1', 'discord/dm/200000000000000001', 1, 't', 'answered', ?, ?)",
				[now, now],
			);
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('discord/dm/200000000000000001', 'op1', 0, '1.1', 'b', 'confirmed', ?, ?)",
				[now, now],
			);
			db.run("INSERT INTO lanes (name, status, created_at, updated_at) VALUES ('l1', 'closed', ?, ?)", [now, now]);
		});
		for (const name of [
			"backup_age",
			"sweep_stalled",
			"inbound_starved",
			"deliveries_overdue",
			"lanes_stuck",
			"monitors_failed",
			"monitors_stalled",
			"turns_failing",
		]) {
			expect(gateState(name).state).toBe("closed");
		}
	});

	test("backup_age opens without a stamp and after the 36h window", () => {
		expect(gateState("backup_age").state).toBe("open");
		expect(gateState("backup_age").detail).toBe("stamp=missing");
		writeStamp(37 * 3_600_000);
		expect(gateState("backup_age").state).toBe("open");
		writeStamp(1 * 3_600_000);
		expect(gateState("backup_age").state).toBe("closed");
	});

	test("sweep_stalled: missing stamp is unknown (nothing to judge); the gate opens past 3 sweeps", () => {
		writeStamp(0);
		expect(gateState("sweep_stalled")).toEqual({ state: "unknown", detail: "stamp=missing" });
		// The heartbeat ages on the fake clock alone: exactly three sweeps is still alive, one past opens.
		writeHeartbeat(SWEEP_STALLED_MS);
		expect(gateState("sweep_stalled").state).toBe("closed");
		writeHeartbeat(SWEEP_STALLED_MS + 1);
		expect(gateState("sweep_stalled").state).toBe("open");
		// A daemon dated ahead of `now` is corruption, not an immortal heartbeat (same rule as backup_age).
		writeHeartbeat(-2 * 60 * 60_000);
		expect(gateState("sweep_stalled")).toEqual({ state: "open", detail: "ts_in_future" });
	});

	test("readSweepHeartbeat parses the observed loop delay and falls back gracefully", () => {
		expect(readSweepHeartbeat(home)).toBeUndefined();
		writeHeartbeat(0, 137);
		expect(readSweepHeartbeat(home)).toMatchObject({ loopMs: 137 });
		// No usable ts= is no evidence of a sweep, not a fresh one from the file's mtime (qa-l #12).
		writeFileSync(join(home, "sweep-heartbeat"), "ts=not-a-date loop_ms=x\n");
		expect(readSweepHeartbeat(home)).toBeUndefined();
	});

	/** Writes a heartbeat stamped now with extra raw fields (discord, draining). */
	function writeFields(fields: string): void {
		writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now).toISOString()} loop_ms=0 ${fields}\n`, {
			mode: 0o600,
		});
	}

	function resetDb(): void {
		rmSync(join(home, "jabbu.db"), { force: true });
	}

	test("heartbeat round-trip: discord and draining fields parse; malformed or absent fields stay undefined", () => {
		writeFields(`discord=down discord_since=${new Date(now - 5_000).toISOString()} draining=1`);
		const parsed = readSweepHeartbeat(home);
		expect(parsed?.discord).toEqual({ state: "down", since: new Date(now - 5_000) });
		expect(parsed?.draining).toBe(true);
		writeFields(`discord=up discord_since=${new Date(now).toISOString()} draining=0`);
		expect(readSweepHeartbeat(home)).toMatchObject({ discord: { state: "up" }, draining: false });
		writeFields("discord=weird discord_since=nope draining=2");
		const bad = readSweepHeartbeat(home);
		expect(bad?.discord).toBeUndefined();
		expect(bad?.draining).toBeUndefined();
		writeHeartbeat(0);
		expect(readSweepHeartbeat(home)?.discord).toBeUndefined();
		expect(readSweepHeartbeat(home)?.draining).toBeUndefined();
	});

	test("heartbeat round-trip: the Discord gateway state is written only when given", () => {
		const writer = new SweepHeartbeatWriter(home);
		try {
			writer.beat(now, { discord: { state: "down", since: now - 4_000 }, draining: false });
			expect(readSweepHeartbeat(home)).toMatchObject({
				discord: { state: "down", since: new Date(now - 4_000) },
				draining: false,
			});
			writer.beat(now, { draining: false });
			expect(readSweepHeartbeat(home)?.discord).toBeUndefined();
		} finally {
			writer.stop();
		}
	});

	test("discord_disconnected (UX-22): only with channels.discord; no discord field is unknown, 10 minutes down opens, a future since opens", () => {
		const discordGate = (discordConfigured?: boolean) =>
			collectGates({ homeDir: home, now, ...(discordConfigured === undefined ? {} : { discordConfigured }) }).find(
				(g) => g.name === "discord_disconnected",
			);
		const down = (sinceMs: number) =>
			writeFields(`discord=down discord_since=${new Date(sinceMs).toISOString()} draining=0`);
		down(now - 3 * SOCKET_DOWN_MS);
		expect(discordGate()).toBeUndefined();
		expect(discordGate(false)).toBeUndefined();
		expect(discordGate(true)).toEqual({
			name: "discord_disconnected",
			state: "open",
			detail: "discord=down minutes=30",
		});
		down(now - SOCKET_DOWN_MS);
		expect(discordGate(true)).toEqual({
			name: "discord_disconnected",
			state: "open",
			detail: "discord=down minutes=10",
		});
		down(now - SOCKET_DOWN_MS + 1);
		expect(discordGate(true)?.state).toBe("closed");
		down(now + 2 * 60 * 60_000);
		expect(discordGate(true)).toEqual({
			name: "discord_disconnected",
			state: "open",
			detail: "discord=down ts_in_future",
		});
		writeFields(`discord=up discord_since=${new Date(now - 3 * SOCKET_DOWN_MS).toISOString()} draining=0`);
		expect(discordGate(true)).toEqual({ name: "discord_disconnected", state: "closed", detail: "discord=up" });
		// A stamp without the discord field: the gateway never reported, nothing to judge.
		writeFields("draining=0");
		expect(discordGate(true)).toEqual({ name: "discord_disconnected", state: "unknown", detail: "discord=missing" });
		rmSync(join(home, "sweep-heartbeat"));
		expect(discordGate(true)).toEqual({ name: "discord_disconnected", state: "unknown", detail: "stamp=missing" });
		expect(gateText("discord_disconnected")).toEqual({
			label: "Discord 게이트웨이가 10분 넘게 끊김",
			todo: "네트워크·Discord 토큰과 데몬 로그 확인",
		});
	});

	describe("monitors_stalled", () => {
		const CRON = '{"kind":"cron","schedule":"*/5 * * * *","timezone":"UTC"}';
		const INTERVAL = '{"kind":"script","command":["/bin/true"],"intervalMs":300000}';

		/** Interval trigger: next fire = cursor_at + intervalMs, so cursor_at is set to put it `overdueMs` in the past. */
		function seedMonitor(overdueMs: number, trigger = INTERVAL, cursorAt = now - overdueMs - 300_000): void {
			seedDb((db) => {
				db.run("ALTER TABLE monitors ADD COLUMN trigger_json TEXT");
				db.run("ALTER TABLE monitors ADD COLUMN cursor_at INTEGER");
				db.run(
					"INSERT INTO monitors (id, name, enabled, created_at, updated_at, trigger_json, cursor_at) VALUES ('m1', 'n1', 1, ?, ?, ?, ?)",
					[now, now, trigger, cursorAt],
				);
			});
		}

		test("a cron monitor 2h behind opens; draining closes it; a heartbeat without draining is closed heartbeat=old", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedMonitor(0, CRON, now - 2 * 3_600_000);
			expect(gateState("monitors_stalled").state).toBe("open");
			expect(gateState("monitors_stalled").detail).toMatch(/^overdue=1$/);
			writeFields("draining=1");
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "draining" });
			writeHeartbeat(0);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "heartbeat=old" });
		});

		test("frozen: a script monitor held back is closed with detail frozen, and stays closed right after unfreeze (#140)", () => {
			const SCRIPT = '{"kind":"script","command":["/bin/true"],"intervalMs":300000}';
			writeStamp(0);
			writeFields("draining=0");
			writeFreeze(home, { reason: "조사", by: "cli", now: now - 3 * 3_600_000 });
			// The scheduler does not move a script's cursor while frozen: its next fire is 2h past.
			seedMonitor(2 * 3_600_000, SCRIPT);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "frozen" });
			expect(gateState("frozen").state).toBe("open");
			clearFreeze(home, now);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
			// Still not fired a full overdue window after the unfreeze: now it is a stall.
			now += MONITOR_OVERDUE_MS - 1;
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
			now += 1;
			expect(gateState("monitors_stalled")).toEqual({ state: "open", detail: "overdue=1" });
		});

		test("boundary: next fire exactly 15 minutes past opens, 1 ms less is closed", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedMonitor(MONITOR_OVERDUE_MS);
			expect(gateState("monitors_stalled")).toEqual({ state: "open", detail: "overdue=1" });
			resetDb();
			seedMonitor(MONITOR_OVERDUE_MS - 1);
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
		});

		test("old schema is closed schema=old; unparsable trigger is skipped; disabled never counts", () => {
			writeStamp(0);
			writeFields("draining=0");
			seedDb(() => {});
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "schema=old" });
			resetDb();
			seedMonitor(2 * 3_600_000, "not json");
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
			resetDb();
			seedMonitor(2 * 3_600_000);
			const db = new Database(join(home, "jabbu.db"), { strict: true });
			db.run("UPDATE monitors SET enabled = 0");
			db.close();
			expect(gateState("monitors_stalled")).toEqual({ state: "closed", detail: "overdue=0" });
		});

		test("db missing: unknown db=missing", () => {
			writeStamp(0);
			expect(gateState("monitors_stalled")).toEqual({ state: "unknown", detail: "db=missing" });
		});
	});

	test("a hung turn (old dispatched inbound) opens inbound_starved", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at) VALUES ('C:2.1', 'discord/dm/200000000000000001', 1, 't', 'dispatched', ?, ?)",
				[now - 60_000, now - 11 * 60_000],
			);
		});
		expect(gateState("inbound_starved").state).toBe("open");
	});

	test("inbound_starved measures silence since the last omp event, not the turn's age", () => {
		writeStamp(0);
		seedDb((db) => {
			const insert =
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES (?, 'discord/dm/200000000000000001', 1, 't', 'dispatched', ?, ?, ?)";
			db.run(insert, ["C:3.1", now - 36 * 60_000, now - 35 * 60_000, now - 9 * 60_000]);
		});
		expect(gateState("inbound_starved")).toEqual({ state: "closed", detail: "silent_old=0" });

		now += 2 * 60_000;
		expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
	});

	describe("origin_silent", () => {
		const pending = (db: Database, id: string, origin: string, ageMs: number) =>
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES (?, ?, 1, 't', 'pending', ?)",
				[id, origin, now - ageMs],
			);

		test("a message pending 15 minutes opens it; one minute younger does not; monitor rows never count", () => {
			writeStamp(0);
			seedDb((db) => {
				pending(db, "C:10.1", "discord/dm/200000000000000001", ORIGIN_SILENT_MS - 60_000);
				pending(db, "C:10.2", "monitor/m1", 2 * ORIGIN_SILENT_MS);
			});
			expect(gateState("origin_silent")).toEqual({ state: "closed", detail: "waiting=0" });
			now += 60_000;
			expect(gateState("origin_silent")).toEqual({ state: "open", detail: "waiting=1 origins=1 oldest_min=15" });
		});

		test("queued behind a turn still emitting events is closed; behind a hung turn it opens", () => {
			writeStamp(0);
			seedDb((db) => {
				pending(db, "C:11.1", "discord/dm/200000000000000001", 20 * 60_000);
				db.run(
					"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES ('C:11.0', 'discord/dm/200000000000000001', 1, 't', 'dispatched', ?, ?, ?)",
					[now - 30 * 60_000, now - 30 * 60_000, now - 60_000],
				);
			});
			expect(gateState("origin_silent").state).toBe("closed");
			now += INBOUND_STARVATION_MS;
			expect(gateState("origin_silent").state).toBe("open");
		});

		test("a restart drain holds pending rows on purpose: closed while draining", () => {
			writeStamp(0);
			seedDb((db) => pending(db, "C:12.1", "discord/dm/200000000000000001", 2 * ORIGIN_SILENT_MS));
			writeFields("draining=1");
			expect(gateState("origin_silent")).toEqual({ state: "closed", detail: "draining" });
			writeFields("draining=0");
			expect(gateState("origin_silent").state).toBe("open");
		});
	});

	test("a turn waiting on a pending approval card is not starved; once the card is decided it is", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES ('C:4.1', 'discord/ch/300000000000000001/t/1700000000000000001', 1, 't', 'dispatched', ?, ?, ?)",
				[now - 21 * 60_000, now - 20 * 60_000, now - 20 * 60_000],
			);
			db.run(
				"CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, status TEXT NOT NULL, origin_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
			);
			db.run(
				"INSERT INTO approvals VALUES ('E:5.5', 'pending', 'discord/ch/300000000000000001/t/1700000000000000001', ?, ?), ('E:6.6', 'pending', NULL, ?, ?)",
				[now - 20 * 60_000, now + 10 * 60_000, now - 20 * 60_000, now + 10 * 60_000],
			);
		});
		expect(gateState("inbound_starved")).toEqual({ state: "closed", detail: "silent_old=0" });

		const db = new Database(join(home, "jabbu.db"), { strict: true });
		db.run("UPDATE approvals SET status = 'approved' WHERE approval_id = 'E:5.5'");
		db.close();
		expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
	});

	test("stuck delivery pump opens deliveries_overdue but sticky ambiguous does not", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'op1', 0, 't', 'b', 'pending', ?, ?)",
				[now - 11 * 60_000, now - 3_600_000],
			);
			db.run(
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('o', 'op2', 0, 't', 'b', 'failed_ambiguous', ?, ?)",
				[now - 3_600_000, now - 3_600_000],
			);
		});
		expect(gateState("deliveries_overdue").state).toBe("open");
		expect(gateState("deliveries_overdue").detail).toBe("overdue=1");
		// Only the pending row gates; the ambiguous row is visible in status instead.
		const db = new Database(join(home, "jabbu.db"), { strict: true });
		db.run("UPDATE deliveries SET state = 'confirmed' WHERE op_ref = 'op1'");
		db.close();
		expect(gateState("deliveries_overdue").state).toBe("closed");
	});

	test("qa-l #12: empty or garbage stamp files are no evidence: sweep unknown, backup_age open, not closed by mtime", () => {
		mkdirSync(join(home, "backups"), { recursive: true });
		for (const content of ["", "\0\u0001binary\u00ff", "ts=not-a-date\n"]) {
			writeFileSync(join(home, "backups", STAMP_FILE), content);
			writeFileSync(join(home, "sweep-heartbeat"), content);
			expect(gateState("backup_age")).toEqual({ state: "open", detail: "stamp=missing" });
			expect(gateState("sweep_stalled")).toEqual({ state: "unknown", detail: "stamp=missing" });
		}
	});

	test("qa-l #13: a lane whose last history `at` is not a number falls back to updated_at", () => {
		writeStamp(0);
		const old = now - 25 * 3_600_000;
		seedDb((db) => {
			db.run("ALTER TABLE lanes ADD COLUMN history TEXT");
			for (const [name, at] of [
				["iso", new Date(now - 60_000).toISOString()],
				["nul", null],
			] as const) {
				db.run("INSERT INTO lanes (name, status, history, created_at, updated_at) VALUES (?, 'working', ?, ?, ?)", [
					name,
					JSON.stringify([{ at, event: "created" }]),
					old,
					old,
				]);
			}
		});
		expect(gateState("lanes_stuck").detail).toStartWith("working_old=2 ");
	});

	test("qa-l #14: with a daily ceiling and no ledger, cost_cap is unknown instead of missing", () => {
		const gate = collectGates({ homeDir: home, now, dailyCap: { usd: 10, timezone: "Asia/Seoul" } }).find(
			(g) => g.name === "cost_cap",
		);
		expect(gate).toEqual({ name: "cost_cap", state: "unknown", detail: "db=missing" });
	});

	test("AC-1: a closed lane with land pending or blocked opens lanes_stuck after a day, not before", () => {
		writeStamp(0);
		const lane = (name: string, state: string, age: number) => (db: Database) => {
			db.run("INSERT INTO lanes (name, status, meta, created_at, updated_at) VALUES (?, 'closed', ?, ?, ?)", [
				name,
				JSON.stringify({ land: { state } }),
				now - age,
				now - age,
			]);
		};
		seedDb((db) => {
			db.run("ALTER TABLE lanes ADD COLUMN meta TEXT");
			lane("fresh", "pending", 3_600_000)(db);
			lane("landed", "landed", 25 * 3_600_000)(db);
		});
		expect(gateState("lanes_stuck").state).toBe("closed");
		const db = new Database(join(home, "jabbu.db"), { strict: true });
		lane("old", "pending", 25 * 3_600_000)(db);
		db.close();
		expect(gateState("lanes_stuck").state).toBe("open");
		expect(gateState("lanes_stuck").detail).toContain("unlanded=1");
	});

	test("an old working lane opens lanes_stuck", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run("INSERT INTO lanes (name, status, created_at, updated_at) VALUES ('l1', 'working', ?, ?)", [
				now - 25 * 3_600_000,
				now - 25 * 3_600_000,
			]);
		});
		expect(gateState("lanes_stuck").state).toBe("open");
	});

	describe("lanes_stuck: orphan, running and approval-wait lanes", () => {
		const old = () => now - 25 * 3_600_000;

		/**
		 * The real ledger's columns on top of the shared DDL (pre-history lanes table, no approvals): lanes get
		 * origin_key and history, approvals the schema's status/origin_key/created_at/expires_at (ms epoch, like
		 * `ApprovalBroker`'s `now + timeoutMs`). Returns a working lane inserter whose last activity is `at`.
		 */
		function laneLedger(db: Database): (name: string, at: number) => void {
			db.run("ALTER TABLE lanes ADD COLUMN origin_key TEXT");
			db.run("ALTER TABLE lanes ADD COLUMN history TEXT");
			db.run(
				"CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, status TEXT NOT NULL, origin_key TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
			);
			return (name, at) =>
				db.run(
					"INSERT INTO lanes (name, status, origin_key, history, created_at, updated_at) VALUES (?, 'working', ?, ?, ?, ?)",
					[name, `jabbu/work/${name}`, JSON.stringify([{ at, event: "created" }]), at, at],
				);
		}

		function turn(db: Database, origin: string, dispatchedAt: number, lastEventAt: number): void {
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at) VALUES (?, ?, 1, 't', 'dispatched', ?, ?, ?)",
				[`${origin}:${dispatchedAt}`, origin, dispatchedAt, dispatchedAt, lastEventAt],
			);
		}

		function pendingApproval(db: Database, origin: string, expiresAt: number): void {
			db.run(
				"INSERT INTO approvals (approval_id, status, origin_key, created_at, expires_at) VALUES (?, 'pending', ?, ?, ?)",
				[`E:${origin}`, origin, expiresAt - 30 * 60_000, expiresAt],
			);
		}

		test("lanes_stuck counts only orphan working lanes: a running turn or a pending approval keeps it closed", () => {
			writeStamp(0);
			const seedLanes = (withOrphan: boolean) =>
				seedDb((db) => {
					const lane = laneLedger(db);
					lane("running", old());
					turn(db, "jabbu/work/running", now - 60_000, now - 60_000);
					lane("approval", old());
					pendingApproval(db, "jabbu/work/approval", now + 10 * 60_000);
					if (withOrphan) lane("orphan", old());
				});
			seedLanes(true);
			expect(gateState("lanes_stuck")).toEqual({
				state: "open",
				detail: "working_old=1 running=1 approval_wait=1 unlanded=0",
			});
			rmSync(join(home, "jabbu.db"), { force: true });
			seedLanes(false);
			expect(gateState("lanes_stuck")).toEqual({
				state: "closed",
				detail: "working_old=0 running=1 approval_wait=1 unlanded=0",
			});
		});

		test("an expired card still marked pending (expireStale failing, sweep alive) waits on nobody: the lane is an orphan, the turn starved", () => {
			writeStamp(0);
			writeHeartbeat(0);
			seedDb((db) => {
				laneLedger(db)("approval", old());
				pendingApproval(db, "jabbu/work/approval", now - 60_000);
				// A chat turn hung behind the same kind of stale card.
				turn(db, "discord/ch/300000000000000001/t/1700000000000000001", now - 20 * 60_000, now - 20 * 60_000);
				pendingApproval(db, "discord/ch/300000000000000001/t/1700000000000000001", now - 60_000);
			});
			expect(gateState("sweep_stalled").state).toBe("closed");
			expect(gateState("lanes_stuck")).toEqual({
				state: "open",
				detail: "working_old=1 running=0 approval_wait=0 unlanded=0",
			});
			expect(gateState("inbound_starved")).toEqual({ state: "open", detail: "silent_old=1" });
		});

		test("a turn that keeps emitting events but was dispatched before the lane's 24h silence does not exempt the lane", () => {
			writeStamp(0);
			seedDb((db) => {
				laneLedger(db)("busy", old());
				turn(db, "jabbu/work/busy", old(), now - 60_000);
			});
			expect(gateState("lanes_stuck")).toEqual({
				state: "open",
				detail: "working_old=1 running=0 approval_wait=0 unlanded=0",
			});
		});
	});

	test("recent failed_no_retry on an enabled monitor opens monitors_failed", () => {
		writeStamp(0);
		seedDb((db) => {
			db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('m1', '아침', 1, ?, ?)", [
				now,
				now,
			]);
			db.run(
				"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES ('m1', ?, 'failed_no_retry', ?, ?)",
				[now - 3_600_000, now - 3_600_000, now - 3_600_000],
			);
		});
		expect(gateState("monitors_failed").state).toBe("open");
		// Old failures do not gate: they already notified once.
		const db = new Database(join(home, "jabbu.db"), { strict: true });
		db.run("UPDATE monitor_events SET updated_at = ?", [now - 48 * 3_600_000]);
		db.close();
		expect(gateState("monitors_failed").state).toBe("closed");
	});

	test("a monitor that succeeded after its recent failed_no_retry has recovered and does not gate", () => {
		writeStamp(0);
		const insert =
			"INSERT INTO monitor_events (monitor_id, slot_at, stage, created_at, updated_at) VALUES ('m1', ?, ?, ?, ?)";
		seedDb((db) => {
			db.run("INSERT INTO monitors (id, name, enabled, created_at, updated_at) VALUES ('m1', '회고', 1, ?, ?)", [
				now,
				now,
			]);
			db.run(insert, [now - 3_600_000, "failed_no_retry", now - 3_600_000, now - 3_600_000]);
			db.run(insert, [now - 1_800_000, "no_report", now - 1_800_000, now - 1_800_000]);
		});
		expect(gateState("monitors_failed")).toEqual({ state: "closed", detail: "failed_recent=0" });
		// A failure after the success opens it again.
		const db = new Database(join(home, "jabbu.db"), { strict: true });
		db.run(insert, [now - 600_000, "failed_no_retry", now - 600_000, now - 600_000]);
		db.close();
		expect(gateState("monitors_failed")).toEqual({ state: "open", detail: "failed_recent=1" });
	});

	test("three recent [turn failed] notices open turns_failing; fewer or older ones do not", () => {
		writeStamp(0);
		seedDb((db) => {
			const insert =
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('discord/dm/200000000000000001', ?, 0, 't', ?, 'confirmed', ?, ?)";
			db.run(insert, ["op0", "ECHO fine", now, now - 5 * 60_000]);
			db.run(insert, ["op1", "[turn failed] rpc_error — 다시 보내 주세요", now, now - 10 * 60_000]);
			db.run(insert, ["op2", "[turn failed] rpc_error — 다시 보내 주세요", now, now - 20 * 60_000]);
			db.run(insert, ["op3", "[turn failed] omp_exited code=137 — 다시 보내 주세요", now, now - 30 * 60_000]);
		});
		expect(gateState("turns_failing")).toEqual({ state: "open", detail: "recent=3" });

		const db = new Database(join(home, "jabbu.db"), { strict: true });
		db.run("UPDATE deliveries SET created_at = ? WHERE op_ref = 'op3'", [now - 2 * 3_600_000]);
		db.close();
		expect(gateState("turns_failing")).toEqual({ state: "closed", detail: "recent=2" });
	});

	test("recent peer failure notices open turns_failing; quoting or discussing the mark does not", () => {
		writeStamp(0);
		const peer = (op: string, head: string) => [
			op,
			`${head} 응답 실패(rpc_error) — 다시 요청하거나 직접 검토해 주세요`,
			now,
			now - 600_000,
		];
		seedDb((db) => {
			const insert =
				"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, state, next_at, created_at) VALUES ('discord/ch/300000000000000001/t/1', ?, 0, 't', ?, 'confirmed', ?, ?)";
			db.run(insert, peer("pf1", "<@222222222222222222> <@111111111111111111>"));
			db.run(insert, peer("pf2", "{{mention:222222222222222222}}"));
			db.run(insert, peer("pf3", "<@222222222222222222>"));
			// Not failure notices: an answer quoting the mark mid-body, a code block about it, a bare mention head.
			db.run(insert, ["q1", "방금 거기서 응답 실패(rpc_error)가 떴다고 하던데", now, now - 600_000]);
			db.run(insert, ["q2", "```\n<@222222222222222222> 응답 실패(x)\n```", now, now - 600_000]);
			db.run(insert, ["q3", "<@222222222222222222> 확인했어", now, now - 600_000]);
			db.run(insert, [
				"q4",
				"<@222222222222222222> 아까 <@111111111111111111> 응답 실패(rpc_error) 봤어?",
				now,
				now - 600_000,
			]);
			db.run(insert, ["q5", "<@222222222222222222> 확인\n> 응답 실패(500)", now, now - 600_000]);
		});
		expect(gateState("turns_failing")).toEqual({ state: "open", detail: "recent=3" });
	});

	test("inbound_identity_conflicts reports the last 24h and never opens; a ledger without the table reads zero", () => {
		writeStamp(0);
		seedDb(() => {});
		expect(gateState("inbound_identity_conflicts")).toEqual({ state: "closed", detail: "last24h=0" });
		const db = new Database(join(home, "jabbu.db"), { strict: true });
		{
			db.run(
				"CREATE TABLE inbound_conflicts (conflict_id INTEGER PRIMARY KEY AUTOINCREMENT, platform_message_id TEXT NOT NULL, origin_key TEXT NOT NULL, created_at INTEGER NOT NULL)",
			);
			const insert = "INSERT INTO inbound_conflicts (platform_message_id, origin_key, created_at) VALUES (?, 'o1', ?)";
			db.run(insert, ["m1", now - 3_600_000]);
			db.run(insert, ["m2", now - 23 * 3_600_000]);
			db.run(insert, ["m3", now - 25 * 3_600_000]);
		}
		db.close();
		expect(gateState("inbound_identity_conflicts")).toEqual({ state: "closed", detail: "last24h=2" });
	});

	test("cost_cap exists only with a daily ceiling: open at the day's total, closed under it", () => {
		const day = localDay(now, "Asia/Seoul");
		seedDb((db) => {
			db.run(
				"CREATE TABLE usage_daily (day TEXT NOT NULL, origin_key TEXT NOT NULL, cost REAL NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day, origin_key))",
			);
			db.run(
				"INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES (?, 'discord/dm/200000000000000001', 12.5, 3)",
				[day],
			);
			db.run(
				"INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES ('20200101', 'discord/dm/200000000000000001', 99, 1)",
			);
		});
		const capGate = (dailyCapUsd: number | undefined) =>
			collectGates({
				homeDir: home,
				now,
				...(dailyCapUsd === undefined ? {} : { dailyCap: { usd: dailyCapUsd, timezone: "Asia/Seoul" } }),
			}).find((g) => g.name === "cost_cap");
		expect(capGate(undefined)).toBeUndefined();
		expect(capGate(10)).toEqual({ name: "cost_cap", state: "open", detail: "today=12.50 cap=10.00" });
		expect(capGate(12.5)?.state).toBe("open");
		expect(capGate(12.51)).toMatchObject({ state: "closed", detail: "today=12.50 cap=12.51" });
	});

	test("cost_cap reads zero spend on a ledger without usage_daily (an older bot) instead of judging unknown", () => {
		seedDb(() => undefined);
		const gate = collectGates({ homeDir: home, now, dailyCap: { usd: 10, timezone: "Asia/Seoul" } }).find(
			(g) => g.name === "cost_cap",
		);
		expect(gate).toEqual({ name: "cost_cap", state: "closed", detail: "today=0.00 cap=10.00" });
	});

	test("no database file leaves the db gates unknown while backup_age still reports", () => {
		expect(gateState("inbound_starved").detail).toBe("db=missing");
		expect(gateState("inbound_starved").state).toBe("unknown");
		expect(gateState("backup_age").state).toBe("open");
	});

	test("omp_runtime opens for a non-omp or missing executable, closes for one answering omp/<x.y.z>, and is omitted without omp", () => {
		const runtimeGate = (ompExecutable: string) =>
			collectGates({ homeDir: home, now, ompExecutable }).find((g) => g.name === "omp_runtime");
		const executable = (version: string) => {
			const root = mkdtempSync(join(home, "bin-"));
			writeFileSync(join(root, "omp"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
			return join(root, "omp");
		};
		expect(runtimeGate(executable("1.4.4"))).toMatchObject({ state: "open" });
		expect(runtimeGate(executable("1.4.4"))?.detail).toStartWith("omp_executable_missing version=unrecognized");
		expect(runtimeGate(executable("omp/19.0.0"))).toMatchObject({ state: "closed", detail: "ok" });
		expect(runtimeGate(join(home, "no-such-omp"))).toMatchObject({ state: "open" });
		expect(collectGates({ homeDir: home, now }).some((g) => g.name === "omp_runtime")).toBe(false);
	});
});

describe("jabbu-pocket gates: open, closed and unknown (판정불가)", () => {
	/** Disk and host load injected calm, so the exit code never depends on this machine. */
	const calm: GatesCommandDeps = {
		now: () => now,
		statfs: () => ({ bavail: 50 * 262_144, blocks: 100 * 262_144, bsize: 4096 }), // 50 of 100 GiB free
		hostLoad: IDLE_HOST_LOAD,
	};

	function runGates(args: string[]): { code: number; out: string } {
		const out: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			return { code: gatesCommand(args, home, calm), out: out.join("") };
		} finally {
			process.stdout.write = write;
		}
	}
	const lastLine = (out: string) => out.trimEnd().split("\n").pop();

	test("a home no daemon ever ran in (fresh backup stamp only): exit 0, unknown=9; --strict exits 1; --json counts unknown", () => {
		writeStamp(0);
		const plain = runGates([]);
		expect(plain.code).toBe(0);
		expect(lastLine(plain.out)).toBe(
			"gates_done open=0 unknown=9 total=13 unknown_gates=sweep_stalled,inbound_starved,origin_silent,deliveries_overdue,deliveries_ambiguous_stuck,lanes_stuck,monitors_failed,monitors_stalled,turns_failing",
		);
		expect(runGates(["--strict"]).code).toBe(1);
		const json = runGates(["--json"]);
		expect(json.code).toBe(0);
		const parsed = JSON.parse(json.out) as { open: number; unknown: number; gates: Array<{ state: string }> };
		expect(parsed).toMatchObject({ open: 0, unknown: 9 });
		expect(parsed.gates.filter((gate) => gate.state === "unknown")).toHaveLength(9);
		expect(runGates(["--json", "--strict"]).code).toBe(1);
	});

	test("a healthy home passes --strict; a corrupt ledger still opens ledger_unreadable with exit 1", () => {
		writeStamp(0);
		writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now).toISOString()} loop_ms=0 draining=0\n`);
		seedDb(() => {});
		const strict = runGates(["--strict"]);
		expect(lastLine(strict.out)).toBe("gates_done open=0 unknown=0 total=14");
		expect(strict.code).toBe(0);

		writeFileSync(join(home, "jabbu.db"), "not a database at all\n".repeat(500));
		const corrupt = runGates([]);
		expect(corrupt.code).toBe(1);
		expect(corrupt.out).toContain("gate=ledger_unreadable state=open");
		expect(lastLine(corrupt.out)).toStartWith("gates_done open=1 unknown=0 total=6 opened=ledger_unreadable(");
		expect(runGates(["--strict"]).code).toBe(1);
	});

	test("--ko keeps the exit code and the gate lines, and names open and unjudged gates by their dashboard label", () => {
		writeStamp(0);
		const fresh = runGates(["--ko", "--strict"]);
		expect(fresh.code).toBe(1);
		expect(fresh.out).toContain("gate=lanes_stuck state=unknown");
		expect(lastLine(fresh.out)).toStartWith("판정 못 한 게이트 9개 — ");
		expect(lastLine(fresh.out)).toContain(gateText("lanes_stuck").label);

		writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now).toISOString()} loop_ms=0 draining=0\n`);
		seedDb(() => {});
		const healthy = runGates(["--ko", "--strict"]);
		expect(healthy.code).toBe(0);
		expect(lastLine(healthy.out)).toBe("게이트 14개 모두 정상");

		writeFileSync(join(home, "jabbu.db"), "not a database at all\n".repeat(500));
		const corrupt = runGates(["--ko"]);
		expect(corrupt.code).toBe(1);
		expect(lastLine(corrupt.out)).toStartWith(`게이트 1/6개 열림 — ${gateText("ledger_unreadable").label}(`);
		expect(lastLine(corrupt.out)).toEndWith(` · 할 일: ${gateText("ledger_unreadable").todo}`);
	});
});

describe("JABBU_TEST_HOST_LOAD test hook", () => {
	test("inert without JABBU_TEST_HOOKS=1, so production always reads this machine", () => {
		expect(testHostLoad({})).toBeUndefined();
		expect(testHostLoad({ JABBU_TEST_HOST_LOAD: "idle" })).toBeUndefined();
		expect(testHostLoad({ JABBU_TEST_HOOKS: "0", JABBU_TEST_HOST_LOAD: "idle" })).toBeUndefined();
		expect(testHostLoad({ JABBU_TEST_HOOKS: "1" })).toBeUndefined();
	});

	test("with JABBU_TEST_HOOKS=1, idle closes host_pressure and any other value is refused", () => {
		const idle = testHostLoad({ JABBU_TEST_HOOKS: "1", JABBU_TEST_HOST_LOAD: "idle" });
		expect(idle).toBe(IDLE_HOST_LOAD);
		const gate = collectGates({ homeDir: home, now, hostLoad: idle }).find((g) => g.name === "host_pressure");
		expect(gate?.state).toBe("closed");
		expect(() => testHostLoad({ JABBU_TEST_HOOKS: "1", JABBU_TEST_HOST_LOAD: "busy" })).toThrow("unknown value busy");
	});
});

describe("JABBU_TEST_STATFS test hook", () => {
	test("inert without JABBU_TEST_HOOKS=1, so production always reads this machine", () => {
		expect(testStatfs({})).toBeUndefined();
		expect(testStatfs({ JABBU_TEST_STATFS: "roomy" })).toBeUndefined();
		expect(testStatfs({ JABBU_TEST_HOOKS: "0", JABBU_TEST_STATFS: "roomy" })).toBeUndefined();
		expect(testStatfs({ JABBU_TEST_HOOKS: "1" })).toBeUndefined();
	});

	test("with JABBU_TEST_HOOKS=1, roomy closes disk_low and any other value is refused", () => {
		const roomy = testStatfs({ JABBU_TEST_HOOKS: "1", JABBU_TEST_STATFS: "roomy" });
		expect(roomy).toBe(ROOMY_STATFS);
		const gate = collectGates({ homeDir: home, now, statfs: roomy }).find((g) => g.name === "disk_low");
		expect(gate?.state).toBe("closed");
		expect(gate?.detail).toContain("free_gib=50.0 pct=50");
		expect(() => testStatfs({ JABBU_TEST_HOOKS: "1", JABBU_TEST_STATFS: "tight" })).toThrow("unknown value tight");
	});
});

describe("drain_orphaned", () => {
	const orphanGate = (isAlive: (pid: number) => boolean = () => false) =>
		collectGates({ homeDir: home, now, isAlive }).find((g) => g.name === "drain_orphaned");
	const beat = (draining: 0 | 1) =>
		writeFileSync(join(home, "sweep-heartbeat"), `ts=${new Date(now).toISOString()} loop_ms=0 draining=${draining}\n`);
	const lock = (startedAgoMs: number, bootId = currentBootId()) =>
		writeFileSync(
			join(home, APPLY_LOCK_FILE),
			`${JSON.stringify({ pid: 4242, stamp: "20261121-020000", startedAt: new Date(now - startedAgoMs).toISOString(), bootId })}\n`,
		);

	test("no drain and no apply lock: no gate; a drain without an apply lock (by hand) stays closed", () => {
		beat(0);
		expect(orphanGate()).toBeUndefined();
		beat(1);
		expect(orphanGate()).toEqual({ name: "drain_orphaned", state: "closed", detail: "apply=none" });
	});

	test("a drain whose apply died opens after DRAIN_ORPHANED_MS; a live apply or no drain keeps it closed", () => {
		beat(1);
		lock(DRAIN_ORPHANED_MS - 60_000);
		expect(orphanGate()).toMatchObject({ state: "closed" });
		lock(DRAIN_ORPHANED_MS + 60_000);
		expect(orphanGate()).toEqual({
			name: "drain_orphaned",
			state: "open",
			detail: "apply=20261121-020000 pid=4242 gone minutes=11",
		});
		expect(orphanGate(() => true)).toMatchObject({ state: "closed", detail: "apply=20261121-020000 running" });
		beat(0);
		expect(orphanGate()).toMatchObject({ state: "closed", detail: "draining=0" });
		expect(gateText("drain_orphaned").label).toContain("10분");
	});

	test("an apply lock from before a reboot counts as dead even when its pid runs again", () => {
		beat(1);
		lock(DRAIN_ORPHANED_MS + 60_000, "boot-before-reboot");
		expect(orphanGate(() => true)).toMatchObject({ state: "open" });
	});

	test("an apply lock without a heartbeat stamp has nothing to judge", () => {
		lock(DRAIN_ORPHANED_MS + 60_000);
		expect(orphanGate()).toEqual({ name: "drain_orphaned", state: "unknown", detail: "stamp=missing" });
	});
});

describe("herdr_unreachable (herdr-health stamp)", () => {
	const herdrGate = () => collectGates({ homeDir: home, now }).find((g) => g.name === "herdr_unreachable");
	const stamp = (ageMs: number, fails: number) =>
		writeFileSync(
			join(home, HERDR_HEALTH_FILE),
			`ts=${new Date(now - ageMs).toISOString()} ok=${fails === 0 ? 1 : 0} fails=${fails} since=2026-11-05T00:00:00.000Z\n`,
		);

	test("no stamp: no gate; two failures closed, three open; a stamp older than three task sweeps is stale", () => {
		expect(herdrGate()).toBeUndefined();
		stamp(60_000, 2);
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "ok" });
		stamp(60_000, 3);
		expect(herdrGate()).toEqual({
			name: "herdr_unreachable",
			state: "open",
			detail: "fails=3 since=2026-11-05T00:00:00.000Z",
		});
		stamp(HERDR_HEALTH_STALE_MS + 1_000, 5);
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "stamp=stale" });
		expect(HERDR_HEALTH_STALE_MS).toBe(15 * 60_000);
	});

	test("the probe counts consecutive failed status checks, resets on success, and continues the streak after a restart", async () => {
		const answers: RunProcessResult[] = [];
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd, opts) => {
			calls.push(cmd);
			expect(opts.timeoutMs).toBe(10_000);
			return answers.shift() ?? { code: 0, stdout: "", timedOut: false };
		};
		const running: RunProcessResult = {
			code: 0,
			stdout: "status: running\nversion: 0.9.5\nsocket: /tmp/h.sock\n",
			timedOut: false,
		};
		const down: RunProcessResult = { code: 1, stdout: "", stderr: "server not running\n", timedOut: false };
		const probe = () => new HerdrHealthProbe({ homeDir: home, bin: "/opt/herdr", run, now: () => now });

		const first = probe();
		answers.push(down, down);
		expect((await first.check()).fails).toBe(1);
		expect(await first.check()).toMatchObject({ ok: false, fails: 2, error: "server_not_running" });
		expect(calls[0]).toEqual(["/opt/herdr", "status", "server"]);
		expect(herdrGate()?.state).toBe("closed");

		const restarted = probe();
		answers.push(down);
		expect((await restarted.check()).fails).toBe(3);
		expect(herdrGate()?.state).toBe("open");
		expect(readHerdrHealth(home)?.since).toBe(new Date(now).toISOString());

		answers.push(running);
		expect(await restarted.check()).toMatchObject({ ok: true, fails: 0, since: "-" });
		expect(herdrGate()).toMatchObject({ state: "closed", detail: "ok" });
		// exit 0 without a running line still counts as a failure
		answers.push({ code: 0, stdout: "status: stopped\n", timedOut: false });
		expect((await restarted.check()).fails).toBe(1);
	});

	test("a stale pre-outage streak is not continued after a restart: one fresh failure starts at 1", async () => {
		stamp(HERDR_HEALTH_STALE_MS + 1_000, 2); // fails=2 from before a >15min outage
		const answers: RunProcessResult[] = [];
		const run: ProcessRunner = async (_cmd, opts) => {
			expect(opts.timeoutMs).toBe(10_000);
			return answers.shift() ?? { code: 0, stdout: "", timedOut: false };
		};
		const down: RunProcessResult = { code: 1, stdout: "", stderr: "server not running\n", timedOut: false };
		const restarted = new HerdrHealthProbe({ homeDir: home, bin: "/opt/herdr", run, now: () => now });
		answers.push(down, down);
		expect((await restarted.check()).fails).toBe(1);
		expect(herdrGate()?.state).toBe("closed");
		expect((await restarted.check()).fails).toBe(2);
		expect(herdrGate()?.state).toBe("closed");
	});
});

describe("gateOptionsFromConfig: the sweep, /status, `jabbu-pocket status` and the dashboard judge the same gates", () => {
	test("maps the config to the omp, offsite and cost-cap options; none without a config", () => {
		const ompExecutable = join(home, "no-such-omp");
		expect(gateOptionsFromConfig({ timezone: "Asia/Seoul", ompExecutable, costCap: { dailyUsd: 5 } })).toEqual({
			ompExecutable,
			offsiteConfigured: false,
			discordConfigured: false,
			dailyCap: { usd: 5, timezone: "Asia/Seoul" },
			hostSessionCeiling: 8,
		});
		expect(
			gateOptionsFromConfig({
				timezone: "Asia/Seoul",
				ompExecutable,
				agent: "agy",
				ompProfile: "work",
				offsite: { ssh: "backup", remoteDir: "/b" },
				channels: { discord: { guildIds: ["1"] } },
			}),
		).toEqual({ ompProfile: "work", offsiteConfigured: true, discordConfigured: true, hostSessionCeiling: 8 });
		expect(gateOptionsFromConfig(undefined)).toEqual({});
	});

	test("an omp_runtime gate the sweep opens is listed by the status fallback too", () => {
		const options = gateOptionsFromConfig({ timezone: "Asia/Seoul", ompExecutable: join(home, "no-such-omp") });
		const report = readStatusFromDb(
			join(home, "jabbu.db"),
			"omp-test 0",
			"Asia/Seoul",
			options,
			IDLE_HOST_LOAD,
			ROOMY_STATFS,
		);
		expect(report.openGates.map((gate) => gate.name)).toContain("omp_runtime");
	});

	test("qa-l #11: an inbound row with state __proto__ stays in the status counts", () => {
		seedDb((db) => {
			db.run("CREATE TABLE origins (origin_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL)");
			db.run(
				"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES ('m1', 'o', 1, 't', '__proto__', 1)",
			);
		});
		const report = readStatusFromDb(
			join(home, "jabbu.db"),
			"omp-test 0",
			"Asia/Seoul",
			{},
			IDLE_HOST_LOAD,
			ROOMY_STATFS,
		);
		expect(Object.getOwnPropertyDescriptor(report.inbound, "__proto__")?.value).toBe(1);
	});
});

describe("gateText", () => {
	test("every gate `jabbu-pocket gates` can emit has a real Korean label, not the machine name", () => {
		for (const name of GATE_NAMES) {
			const { label } = gateText(name);
			expect(label, name).not.toBe(name);
		}
	});
});
