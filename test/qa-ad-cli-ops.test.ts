import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli/index";
import { initCommand } from "../src/cli/init";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { checkDiscord, runDoctor } from "../src/daemon/doctor";
import { checkOmpVersion } from "../src/daemon/omp-boot";
import { createLogger } from "../src/log";
import { chain } from "../src/ops/cgroup-fs";
import { sampleCgroupMemory } from "../src/ops/cgroup-memory";
import { clearFreeze, freezePath, unfrozenAtPath, writeFreeze } from "../src/ops/freeze";
import { gcSessions } from "../src/ops/gc";
import { MEDIA_MAX_AGE_MS, pruneTree, sweepMedia } from "../src/ops/media-prune";
import { redact } from "../src/redact";
import { makeHome } from "./helpers/bot-home";
import { runBounded } from "./helpers/bounded-child";
import { OFFLINE_DOCTOR } from "./helpers/doctor-network";
import { isRoot } from "./helpers/privileges";

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = "100000000000000001";
const APP = "600000000000000000";

let tempRoot: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "jabbu-qa-ad-cli-"));
});

afterEach(() => {
	for (const fn of cleanups.splice(0).reverse()) fn();
	rmSync(tempRoot, { recursive: true, force: true });
});

async function runCliCaptured(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runCli(args, env);
		return { code, stdout: out.join(""), stderr: err.join("") };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

function fakeOmpExecutable(dir: string, body: string): string {
	const path = join(dir, "fake-omp");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("qa-ad CLI & ops fixes", () => {
	test("#2: clearFreeze refuses symlinks (including dangling) at unfrozen-at without touching target or lifting FROZEN", () => {
		const homeA = join(tempRoot, "home-target");
		mkdirSync(homeA, { recursive: true });
		const outside = join(tempRoot, "outside.txt");
		writeFileSync(outside, "ORIGINAL-OUTSIDE-CONTENT\n");
		writeFreeze(homeA, { by: "cli", now: 1_000, reason: "test" });
		symlinkSync(outside, unfrozenAtPath(homeA));

		expect(() => clearFreeze(homeA, 2_000)).toThrow(/not a regular file/);
		expect(readFileSync(outside, "utf8")).toBe("ORIGINAL-OUTSIDE-CONTENT\n");
		expect(lstatSync(unfrozenAtPath(homeA)).isSymbolicLink()).toBe(true);
		expect(existsSync(freezePath(homeA))).toBe(true);

		const homeB = join(tempRoot, "home-dangling");
		mkdirSync(homeB, { recursive: true });
		const absent = join(tempRoot, "never-created.txt");
		writeFreeze(homeB, { by: "cli", now: 1_000, reason: "test" });
		symlinkSync(absent, unfrozenAtPath(homeB));

		expect(() => clearFreeze(homeB, 2_000)).toThrow(/not a regular file/);
		expect(existsSync(absent)).toBe(false);
		expect(existsSync(freezePath(homeB))).toBe(true);
	});

	test("#3: checkOmpVersion replaces symlinks, dangling symlinks and FIFOs atomically and tolerates directories", async () => {
		const home = makeHome("jabbu-qa-ad-ompver-");
		cleanups.push(home.remove);
		const events: string[] = [];
		const log = createLogger({ clock: { now: () => 1_000 }, redact, sink: (line) => void events.push(line) });
		const recorded = join(home.dir, "omp-version");

		// Existing target symlink: outside content stays intact and recorded becomes a 0600 regular file.
		const outside = join(tempRoot, "outside-secret.txt");
		writeFileSync(outside, "OUTSIDE-SECRET-CONTENT\n");
		symlinkSync(outside, recorded);
		const v1 = await checkOmpVersion(home.config, log);
		expect(v1).toBe("omp/0.0.0-stub");
		expect(readFileSync(outside, "utf8")).toBe("OUTSIDE-SECRET-CONTENT\n");
		expect(lstatSync(recorded).isSymbolicLink()).toBe(false);
		expect(lstatSync(recorded).isFile()).toBe(true);
		expect(statSync(recorded).mode & 0o777).toBe(0o600);
		expect(events.some((e) => e.includes("omp_version_changed"))).toBe(false);

		// Dangling symlink: outside target is never created.
		rmSync(recorded);
		const missingTarget = join(tempRoot, "missing-outside.txt");
		symlinkSync(missingTarget, recorded);
		await checkOmpVersion(home.config, log);
		expect(existsSync(missingTarget)).toBe(false);
		expect(lstatSync(recorded).isFile()).toBe(true);

		// Directory at omp-version: warns instead of throwing.
		rmSync(recorded);
		mkdirSync(recorded);
		expect(await checkOmpVersion(home.config, log)).toBe("omp/0.0.0-stub");
		expect(events.some((e) => e.includes("omp_version_write_failed"))).toBe(true);
		rmSync(recorded, { recursive: true });

		// FIFO at omp-version: never hangs (bounded child test).
		expect(Bun.spawnSync(["mkfifo", recorded]).exitCode).toBe(0);
		const runMod = JSON.stringify(join(import.meta.dir, "..", "src", "daemon", "omp-boot.ts"));
		const logMod = JSON.stringify(join(import.meta.dir, "..", "src", "log.ts"));
		const redactMod = JSON.stringify(join(import.meta.dir, "..", "src", "redact.ts"));
		const bounded = await runBounded(
			`const { checkOmpVersion } = await import(${runMod});
			 const { createLogger } = await import(${logMod});
			 const { redact } = await import(${redactMod});
			 const log = createLogger({ clock: { now: () => 0 }, redact, sink: () => {} });
			 console.log(await checkOmpVersion(${JSON.stringify(home.config)}, log));`,
			15_000,
		);
		expect(bounded.timedOut).toBe(false);
		expect(bounded.stdout.trim()).toBe("omp/0.0.0-stub");
		expect(lstatSync(recorded).isFile()).toBe(true);
	}, 30_000);

	test("#4: empty or multiline Discord token file still runs omp and discord checks in runDoctor", async () => {
		const home = makeHome("jabbu-qa-ad-doc-empty-");
		cleanups.push(home.remove);
		const tokenFile = home.config.channels.discord?.botTokenFile ?? "";
		for (const content of ["", "abc\ndef\n"]) {
			writeFileSync(tokenFile, content, { mode: 0o600 });
			const out: string[] = [];
			const code = await runDoctor(home.dir, (line) => void out.push(line), undefined, OFFLINE_DOCTOR);
			expect(code).toBe(1);
			expect(out.some((l) => l.startsWith("ok config: "))).toBe(true);
			expect(out.some((l) => l.startsWith("ok omp: "))).toBe(true);
			expect(out.some((l) => l === "ok discord token: mode=0600 expected=0600")).toBe(true);
			expect(out.some((l) => l === "fail discord token: config_invalid")).toBe(true);
		}
	});

	test("#36: checkDiscord and runDoctor escape control characters in omp judge and Discord outputs", async () => {
		const home = makeHome("jabbu-qa-ad-doc-esc-");
		cleanups.push(home.remove);
		const lines: string[] = [];
		const forgedFetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith("/users/@me")) {
					return Response.json({ id: "500", username: "bot\nok omp: fake\u001b[2J" });
				}
				return Response.json({ url: "wss://gw\nfail forged: 1" });
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;

		await checkDiscord(
			home.config,
			(ok, name, detail) => lines.push(`${ok ? "ok" : "fail"} ${name}: ${detail}`),
			forgedFetch,
		);
		expect(lines).toEqual([
			"ok discord token: mode=0600 expected=0600",
			"ok discord users/@me: bot_user_id=500 username=bot\\u000aok omp: fake\\u001b[2J",
			"ok discord gateway/bot: url=wss://gw\\u000afail forged: 1",
		]);

		const errLines: string[] = [];
		const failingFetch = Object.assign(
			async (): Promise<Response> => {
				throw new Error("boom\nok forged: yes\u001b");
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		await checkDiscord(
			home.config,
			(ok, name, detail) => errLines.push(`${ok ? "ok" : "fail"} ${name}: ${detail}`),
			failingFetch,
		);
		for (const l of errLines) {
			expect(l).not.toContain("\n");
			expect(l).not.toContain("\u001b");
		}
		expect(errLines[1]).toContain("\\u000aok forged: yes\\u001b");

		// runDoctor escapes omp judge model values and overlay/unreadable details
		const overlayPath = join(home.dir, "overlay.yml");
		writeFileSync(overlayPath, "memory:\n  backend: off\n");
		const cfgPath = join(home.dir, "config.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
		writeFileSync(cfgPath, JSON.stringify({ ...cfg, ompConfigOverlay: overlayPath }), { mode: 0o600 });
		writeFileSync(
			home.config.ompExecutable,
			`#!/bin/sh
case "$1" in
--version) echo 'omp/1.0.0' ;;
models) echo '{"models":[{"id":"a"}]}' ;;
*) printf '{"modelRoles":{"value":{"judge":"bad\\\\nok discord: forged"}}}\\n' ;;
esac
`,
		);
		chmodSync(home.config.ompExecutable, 0o755);
		const docOut: string[] = [];
		await runDoctor(home.dir, (line) => void docOut.push(line), undefined, OFFLINE_DOCTOR);
		const judgeLine = docOut.find((l) => l.includes("omp judge:"));
		expect(judgeLine).toBe("ok omp judge: bad\\u000aok discord: forged");
		for (const line of docOut) {
			expect(line).not.toContain("\n");
			expect(line).not.toContain("\u001b");
		}
	});

	test("#11: gc --dry-run counts inbound_orphans matching real gc, including >500 chunked origins", async () => {
		const home = makeHome("jabbu-qa-ad-gc-orphans-");
		cleanups.push(home.remove);
		const NOW = Date.now();
		const OLD = NOW - 45 * DAY_MS;
		const YOUNG = NOW - 5 * DAY_MS;
		const dbPath = join(home.dir, "jabbu.db");
		const store = openBotStore(dbPath, { now: () => OLD }, "Asia/Seoul");
		store.close();

		const totalExpired = 550;
		const expiredOrigins: string[] = [];
		const keptOrigin = "discord/ch/300000000000000001/t/9999";
		const sessionsRoot = join(home.dir, "sessions");
		const db = new Database(dbPath, { strict: true });
		const insOrigin = db.query("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)");
		const ins = db.query(
			"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, thread_ref, state, created_at) VALUES (?, ?, 1, 'hi', ?, 'answered', ?)",
		);
		db.run("BEGIN");
		try {
			for (let i = 0; i < totalExpired; i++) {
				const key = `discord/ch/300000000000000001/t/${1000 + i}`;
				expiredOrigins.push(key);
				insOrigin.run(key, sessionDirFor(sessionsRoot, key, 1), OLD);
				ins.run(`m-${i}`, key, `300000000000000001:${1000 + i}`, YOUNG);
			}
			insOrigin.run(keptOrigin, sessionDirFor(sessionsRoot, keptOrigin, 1), YOUNG);
			// One young inbound row on an expired origin whose thread has a pending approval card must NOT be counted/deleted.
			ins.run("m-approval", expiredOrigins[0] ?? "", "300000000000000001:pending-card", YOUNG);
			db.query(
				"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_thread_ref) VALUES ('a1', '300000000000000001', '1', 's', 'pending', ?, ?, '300000000000000001:pending-card')",
			).run(YOUNG, NOW + DAY_MS);
			// Young finished inbound on keptOrigin must NOT be counted.
			ins.run("m-kept", keptOrigin, "300000000000000001:9999", YOUNG);
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		} finally {
			db.close();
		}

		const dry = gcSessions({ homeDir: home.dir, retentionDays: 30, now: NOW, dryRun: true });
		expect(dry.threadOriginsRemoved).toHaveLength(totalExpired);
		expect(dry.ledgerRemoved.inboundOrphans).toBe(totalExpired);

		const cliDry = await runCliCaptured(["gc", "--dry-run"], { JABBU_HOME: home.dir });
		expect(cliDry.code, cliDry.stderr).toBe(0);
		expect(cliDry.stdout).toContain(`inbound_orphans=${totalExpired}`);

		const real = gcSessions({ homeDir: home.dir, retentionDays: 30, now: NOW });
		expect(real.threadOriginsRemoved).toHaveLength(totalExpired);
		expect(real.ledgerRemoved.inboundOrphans).toBe(totalExpired);
		// WSL2 in CI took 15.4 s here (>500 chunked origins, real gc twice); locally the same test finishes in ~2 s.
	}, 60_000);

	test.skipIf(isRoot /* root ignores permission bits, so the 0o000 dir gives no EACCES (qa-ad #12) */)(
		"#12: 0o000 EACCES session directories are skipped (never deleted in pass 2) while the rest of gc succeeds",
		async () => {
			const home = makeHome("jabbu-qa-ad-gc-skip-");
			cleanups.push(home.remove);
			const NOW = 200 * DAY_MS;
			const OLD = 1_000;
			const oldDate = new Date(OLD);
			const sessionsRoot = join(home.dir, "sessions");

			const badThread = "discord/ch/100000000000000001/t/200000000000000001";
			const goodThread = "discord/ch/100000000000000001/t/200000000000000002";
			const dmOrigin = "discord/dm/100000000000000001";

			const badEpoch = sessionDirFor(sessionsRoot, badThread, 1);
			const badDir = dirname(badEpoch);
			const goodEpoch = sessionDirFor(sessionsRoot, goodThread, 1);
			const goodDir = dirname(goodEpoch);
			const dmEpoch1 = sessionDirFor(sessionsRoot, dmOrigin, 1);
			const dmEpoch2 = sessionDirFor(sessionsRoot, dmOrigin, 2);

			for (const dir of [badEpoch, goodEpoch, dmEpoch1, dmEpoch2]) {
				mkdirSync(dir, { recursive: true });
				const f = join(dir, "s.jsonl");
				writeFileSync(f, "{}\n");
				utimesSync(f, oldDate, oldDate);
				utimesSync(dir, oldDate, oldDate);
				utimesSync(dirname(dir), oldDate, oldDate);
			}

			const dbPath = join(home.dir, "jabbu.db");
			const store = openBotStore(dbPath, { now: () => OLD }, "Asia/Seoul");
			store.ensureOrigin(badThread, badEpoch);
			store.ensureOrigin(goodThread, goodEpoch);
			store.ensureOrigin(dmOrigin, dmEpoch1);
			store.newEpoch(dmOrigin, dmEpoch2);
			store.close();

			chmodSync(badDir, 0o000);
			cleanups.push(() => {
				if (existsSync(badDir)) chmodSync(badDir, 0o700);
			});

			const dry = gcSessions({ homeDir: home.dir, retentionDays: 30, now: NOW, dryRun: true });
			expect(dry.sessionsSkipped).toEqual([badDir]);
			expect(dry.threadOriginsRemoved).toEqual([goodThread]);
			expect(dry.removed).toEqual([dmEpoch1]);

			const cli = await runCliCaptured(["gc"], { JABBU_HOME: home.dir });
			expect(cli.code, cli.stderr).toBe(0);
			expect(cli.stdout).toContain("sessions_skipped=1");
			expect(existsSync(badDir)).toBe(true);
			expect(existsSync(goodDir)).toBe(false);
			expect(existsSync(dmEpoch1)).toBe(false);
			expect(existsSync(dmEpoch2)).toBe(true);

			const db = new Database(dbPath, { readonly: true, strict: true });
			expect(db.query("SELECT origin_key FROM origins WHERE origin_key = ?").get(badThread)).not.toBeNull();
			expect(db.query("SELECT origin_key FROM origins WHERE origin_key = ?").get(goodThread)).toBeNull();
			db.close();
		},
	);

	test("#14: 24h media pruning preserves symlinked inbound/web while still pruning other expired symlinks/files", () => {
		const mediaRoot = join(tempRoot, "media");
		const inboundDir = join(mediaRoot, "inbound");
		const realWeb = join(tempRoot, "real-web-uploads");
		mkdirSync(inboundDir, { recursive: true });
		mkdirSync(realWeb, { recursive: true });

		const webFile = join(realWeb, "keep.png");
		writeFileSync(webFile, "png");
		const webLink = join(inboundDir, "web");
		symlinkSync(realWeb, webLink);

		const oldFile = join(inboundDir, "old.jpg");
		const oldLink = join(inboundDir, "old-link");
		writeFileSync(oldFile, "old");
		symlinkSync(join(tempRoot, "absent"), oldLink);

		const now = 10 * DAY_MS;
		const oldDate = new Date(now - 3 * DAY_MS);
		utimesSync(webFile, oldDate, oldDate);
		utimesSync(oldFile, oldDate, oldDate);
		lutimesSync(webLink, oldDate, oldDate);
		lutimesSync(oldLink, oldDate, oldDate);

		const removed = sweepMedia(mediaRoot, now, undefined);
		expect(removed).toBe(2);
		expect(lstatSync(webLink).isSymbolicLink()).toBe(true);
		expect(existsSync(webFile)).toBe(true);
		expect(existsSync(oldFile)).toBe(false);
		expect(lstatSync(oldLink, { throwIfNoEntry: false })).toBeUndefined();

		// Direct pruneTree check as well.
		expect(pruneTree(mediaRoot, now - MEDIA_MAX_AGE_MS, join(mediaRoot, "inbound", "web"))).toBe(0);
		expect(lstatSync(webLink).isSymbolicLink()).toBe(true);
	});

	test("#33: gc and backup succeed immediately after init without a Discord token file", async () => {
		const home = join(tempRoot, "fresh-home");
		const omp = fakeOmpExecutable(tempRoot, 'echo "omp/1.0.0"');
		const rcInit = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", omp], { JABBU_HOME: home });
		expect(rcInit).toBe(0);

		const store = openBotStore(join(home, "jabbu.db"), { now: () => 1_000 }, "Asia/Seoul");
		store.close();

		const gcRes = await runCliCaptured(["gc", "--dry-run"], { JABBU_HOME: home });
		expect(gcRes.code, gcRes.stderr).toBe(0);
		expect(gcRes.stdout).toContain("gc_done");

		const backupRes = await runCliCaptured(["backup"], { JABBU_HOME: home });
		expect(backupRes.code, backupRes.stderr).toBe(0);
		expect(backupRes.stdout).toContain("backup_done");

		// Invalid config still fails gc instead of being silently ignored.
		const cfgPath = join(home, "config.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
		writeFileSync(cfgPath, JSON.stringify({ ...cfg, sessionRetentionDays: "bad" }), { mode: 0o600 });
		const badRes = await runCliCaptured(["gc", "--dry-run"], { JABBU_HOME: home });
		expect(badRes.code).toBe(1);
		expect(badRes.stderr).toContain("config_invalid");
	});

	test("#34: gc exits 1 when home directory is missing, not a directory, or lacks jabbu.db", async () => {
		const absentHome = join(tempRoot, "no-such-home");
		const r1 = await runCliCaptured(["gc"], { JABBU_HOME: absentHome });
		expect(r1.code).toBe(1);
		expect(r1.stderr).toBe(`gc: no database at ${join(absentHome, "jabbu.db")}\n`);

		const fileHome = join(tempRoot, "file-home");
		writeFileSync(fileHome, "not-a-dir");
		const r2 = await runCliCaptured(["gc"], { JABBU_HOME: fileHome });
		expect(r2.code).toBe(1);
		expect(r2.stderr).toBe(`gc: no database at ${join(fileHome, "jabbu.db")}\n`);

		const emptyDirHome = join(tempRoot, "empty-dir-home");
		mkdirSync(emptyDirHome, { mode: 0o700 });
		const r3 = await runCliCaptured(["gc"], { JABBU_HOME: emptyDirHome });
		expect(r3.code).toBe(1);
		expect(r3.stderr).toBe(`gc: no database at ${join(emptyDirHome, "jabbu.db")}\n`);
	});

	test("#35: init rejects control characters in --workspace, JABBU_HOME and --omp with exit 2", () => {
		const omp = fakeOmpExecutable(tempRoot, 'echo "omp/1.0.0"');
		const home1 = join(tempRoot, "init-ws-ctl");
		const badWs = join(tempRoot, "ws\nx");
		const err: string[] = [];
		const origErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			err.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const rcWs = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", omp, "--workspace", badWs], {
				JABBU_HOME: home1,
			});
			expect(rcWs).toBe(2);
			expect(existsSync(home1)).toBe(false);

			const badHome = join(tempRoot, "home\nx");
			const rcHome = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", omp], { JABBU_HOME: badHome });
			expect(rcHome).toBe(2);
			expect(existsSync(badHome)).toBe(false);

			const home2 = join(tempRoot, "init-omp-ctl");
			const rcOmp = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", `${omp}\n`], { JABBU_HOME: home2 });
			expect(rcOmp).toBe(2);
			expect(existsSync(home2)).toBe(false);
		} finally {
			process.stderr.write = origErr;
		}
		expect(err.join("")).toContain("init:");
	});

	test("#38: cgroup chain checks mount root segment boundary so sibling cgroups are never read", () => {
		const mount = { root: "/app.slice", point: "/sys/fs/cgroup" };
		expect(chain(mount, "/app.sliceZZ")).toEqual([]);
		expect(chain(mount, "/other/sub")).toEqual([]);
		expect(chain(mount, "/app.slice")).toEqual([{ dir: "/sys/fs/cgroup", label: "/app.slice" }]);
		expect(chain(mount, "/app.slice/sub")).toEqual([
			{ dir: "/sys/fs/cgroup/sub", label: "/app.slice/sub" },
			{ dir: "/sys/fs/cgroup", label: "/app.slice" },
		]);

		const seen: string[] = [];
		const mem = sampleCgroupMemory((path) => {
			seen.push(path);
			if (path === "/proc/self/cgroup") return "0::/app.sliceZZ";
			if (path === "/proc/self/mountinfo") return "30 23 0:26 /app.slice /sys/fs/cgroup rw - cgroup2 cgroup2 rw";
			if (path === "/sys/fs/cgroup/ZZ/memory.max") return "1000";
			if (path === "/sys/fs/cgroup/ZZ/memory.current") return "950";
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		});
		expect(seen.filter((p) => p.startsWith("/sys/"))).toEqual([]);
		expect(mem).toEqual({ version: 2, hard: null, high: null, incomplete: false });
	});
});
