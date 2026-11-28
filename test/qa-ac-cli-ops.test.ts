import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli/index";
import { loadConfig } from "../src/config";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import { herdrOptionsOf, taskRuntimeOf } from "../src/daemon/daemon-task-resume";
import { checkOmpRuntimeSync } from "../src/omp/runtime-check";
import { freezePath, writeFreeze } from "../src/ops/freeze";
import { gcSessions } from "../src/ops/gc";
import { runRestore } from "../src/ops/restore";
import { jabbuCli, PINNED_OWNER_DOCS_FILE, pinPrefix } from "../src/safety/prompt";
import { makeHome } from "./helpers/bot-home";

const isRoot = process.getuid?.() === 0;
let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "jabbu-qa-ac-cli-"));
});

afterEach(() => {
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

describe("qa-ac config·cli·ops·prompt 수정", () => {
	test("#1/#27: dispatchHosts는 빈 이름과 프로토타입 키를 거부하고 소비자는 own key만 읽는다", () => {
		const home = makeHome("jabbu-qa-ac-cfg-");
		try {
			const cfgPath = join(home.dir, "config.json");
			const base = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			for (const badName of ["", "   ", "__proto__", "constructor", "prototype"]) {
				const next = { ...base, dispatchHosts: JSON.parse(`{"${badName}":{"ssh":"box1"}}`) };
				writeFileSync(cfgPath, JSON.stringify(next));
				expect(() => loadConfig(home.dir)).toThrow(/config_invalid/);
			}
			writeFileSync(cfgPath, JSON.stringify(base));
			const opt = herdrOptionsOf(
				{ options: { config: { ...loadConfig(home.dir), dispatchHosts: {} } } } as unknown as Parameters<
					typeof herdrOptionsOf
				>[0],
				{
					taskId: "T-1",
					host: "constructor",
					agent: "t-1",
					runtime: "herdr",
				} as unknown as Parameters<typeof herdrOptionsOf>[1],
			);
			expect(opt.sshTarget).toBeUndefined();
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test("taskRuntimeOf: a removed dispatch host is an error, not a local-herdr fallback", () => {
		const row = (host: string | null) =>
			({ taskId: "T-1", host, agent: "t-1", runtime: "herdr" }) as unknown as Parameters<typeof taskRuntimeOf>[1];
		const ctx = (hosts: Record<string, { ssh: string }>) =>
			({ options: { config: { dispatchHosts: hosts } } }) as unknown as Parameters<typeof taskRuntimeOf>[0];
		expect(() => taskRuntimeOf(ctx({}), row("gone-host"))).toThrow("알 수 없는 호스트: gone-host");
		expect(() => taskRuntimeOf(ctx({}), row(null))).not.toThrow();
		expect(() => taskRuntimeOf(ctx({ box1: { ssh: "box1" } }), row("box1"))).not.toThrow();
	});

	test("#2: sessionRetentionDays와 candidates 정수 옵션에 상한(100_000)을 적용한다", () => {
		const home = makeHome("jabbu-qa-ac-int-");
		try {
			const cfgPath = join(home.dir, "config.json");
			const base = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			writeFileSync(cfgPath, JSON.stringify({ ...base, sessionRetentionDays: 100_000 }));
			expect(loadConfig(home.dir).sessionRetentionDays).toBe(100_000);
			for (const bad of [1e308, 2 ** 53, 100_001]) {
				writeFileSync(cfgPath, JSON.stringify({ ...base, sessionRetentionDays: bad }));
				expect(() => loadConfig(home.dir)).toThrow(/config_invalid/);
				writeFileSync(cfgPath, JSON.stringify({ ...base, candidates: { minDays: bad } }));
				expect(() => loadConfig(home.dir)).toThrow(/config_invalid/);
			}
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test("#3: jabbuCli가 JABBU_HOME의 ~와 ~/ 접두사를 homedir로 확장한다", () => {
		const tilde = jabbuCli({ JABBU_HOME: "~" });
		const sub = jabbuCli({ JABBU_HOME: "~/my-jabbu" });
		expect(tilde).toContain(`JABBU_HOME=${homedir()} `);
		expect(sub).toContain(`JABBU_HOME=${join(homedir(), "my-jabbu")} `);
	});

	test("#4: TMPDIR이 없어도 checkOmpRuntimeSync가 예외 대신 OmpRuntimeProblem을 돌려준다", () => {
		const exe = join(tempRoot, "fake-omp");
		writeFileSync(exe, "#!/bin/sh\necho 'omp/1.0.0'\n");
		chmodSync(exe, 0o755);
		const prev = process.env.TMPDIR;
		process.env.TMPDIR = join(tempRoot, "missing-tmp-dir");
		try {
			const prob = checkOmpRuntimeSync(exe, {}, 1000);
			expect(prob).toBeDefined();
			expect(prob?.code).toBe("omp_executable_missing");
			expect(prob?.detail).toContain("ENOENT");
		} finally {
			if (prev === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = prev;
		}
	});

	test("#5: unfreeze는 알 수 없는 옵션과 위치 인자를 exit 2로 거부하고 동결을 유지한다", async () => {
		const home = makeHome("jabbu-qa-ac-unfreeze-");
		try {
			writeFreeze(home.dir, { by: "cli", now: Date.now(), reason: "test" });
			const r1 = await runCliCaptured(["unfreeze", "--dry-run"], { JABBU_HOME: home.dir });
			expect(r1.code).toBe(2);
			expect(existsSync(freezePath(home.dir))).toBe(true);

			const r2 = await runCliCaptured(["unfreeze", "extra"], { JABBU_HOME: home.dir });
			expect(r2.code).toBe(2);
			expect(existsSync(freezePath(home.dir))).toBe(true);

			const r3 = await runCliCaptured(["unfreeze"], { JABBU_HOME: home.dir });
			expect(r3.code).toBe(0);
			expect(existsSync(freezePath(home.dir))).toBe(false);
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test("#6: restore가 대상 DB 옆 핫 -journal 파일을 pre-restore로 함께 옮긴다", async () => {
		const home = makeHome("jabbu-qa-ac-restore-");
		try {
			const dbPath = join(home.dir, "jabbu.db");
			const backupPath = join(home.dir, "backup.db");
			const live = openBotStore(dbPath, { now: () => 1_000 }, "Asia/Seoul");
			live.ensureOrigin("A-BACKUP", join(home.dir, "sessions", "A", "e1"));
			live.close();

			const bDb = new Database(dbPath, { strict: true });
			bDb.run("PRAGMA journal_mode = DELETE");
			bDb.close();
			copyFileSync(dbPath, backupPath);

			// Create a genuine hot rollback journal on target by capturing mid-transaction db + -journal.
			const staging = join(tempRoot, "staging.db");
			copyFileSync(backupPath, staging);
			const txDb = new Database(staging, { strict: true });
			txDb.run("PRAGMA journal_mode = DELETE");
			txDb.run("PRAGMA cache_size = 1");
			txDb.run("BEGIN IMMEDIATE");
			txDb.run("UPDATE origins SET origin_key = 'B-UNCOMMITTED' WHERE origin_key = 'A-BACKUP'");
			copyFileSync(staging, dbPath);
			copyFileSync(`${staging}-journal`, `${dbPath}-journal`);
			txDb.run("ROLLBACK");
			txDb.close();

			const result = await runRestore({
				homeDir: home.dir,
				source: backupPath,
				yes: true,
				probeDaemon: async () => {
					throw new Error("no daemon");
				},
			});
			expect(result.applied).toBe(true);
			expect(existsSync(`${dbPath}-journal`)).toBe(false);
			expect(existsSync(join(result.plan.preRestoreDir, "jabbu.db-journal"))).toBe(true);

			const reopened = new Database(dbPath, { readonly: true, strict: true });
			const row = reopened.query("SELECT origin_key FROM origins WHERE origin_key = 'A-BACKUP'").get();
			reopened.close();
			expect(row).not.toBeNull();
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test("#7: gc 명령의 gc_done 출력이 삭제·예정 web_messages 수를 포함한다", async () => {
		const home = makeHome("jabbu-qa-ac-gc-web-");
		try {
			const dbPath = join(home.dir, "jabbu.db");
			const store = openBotStore(dbPath, { now: () => 1_000 }, "Asia/Seoul");
			store.web.insert({ conversation: "c1", role: "owner", text: "old msg" });
			store.close();

			const res = await runCliCaptured(["gc", "--dry-run"], { JABBU_HOME: home.dir });
			expect(res.code, res.stderr).toBe(0);
			expect(res.stdout).toMatch(/gc_done would_remove=\d+ .* web_messages=1\n/);
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test.skipIf(isRoot)(
		"#8: gc에서 세션 디렉터리 삭제가 EACCES로 실패하면 origins 행을 롤백하고 gcLedger는 계속 돈다",
		() => {
			const home = makeHome("jabbu-qa-ac-gc-eacces-");
			const NOW = 200 * 24 * 60 * 60 * 1000;
			const OLD = 1000;
			const oldDate = new Date(OLD);
			const originKey = "discord/ch/100000000000000001/t/200000000000000002";
			const sessionsDir = join(home.dir, "sessions");
			const epochDir = sessionDirFor(sessionsDir, originKey, 1);
			const originDir = dirname(epochDir);
			try {
				mkdirSync(epochDir, { recursive: true });
				const sessFile = join(epochDir, "s.jsonl");
				writeFileSync(sessFile, "{}\n");
				utimesSync(sessFile, oldDate, oldDate);
				utimesSync(epochDir, oldDate, oldDate);
				utimesSync(originDir, oldDate, oldDate);

				const dbPath = join(home.dir, "jabbu.db");
				const store = openBotStore(dbPath, { now: () => OLD }, "Asia/Seoul");
				store.ensureOrigin(originKey, epochDir);
				store.close();

				const dbSeed = new Database(dbPath, { strict: true });
				dbSeed
					.query(
						"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES ('m-old', ?, 1, 'hi', 'answered', ?)",
					)
					.run(originKey, OLD);
				dbSeed.close();

				chmodSync(originDir, 0o500);
				chmodSync(sessionsDir, 0o500);
				const result = gcSessions({ homeDir: home.dir, retentionDays: 30, now: NOW });
				chmodSync(sessionsDir, 0o700);
				chmodSync(originDir, 0o700);

				expect(result.threadOriginsRemoved).toEqual([]);
				expect(result.retained).toContain(originDir);
				expect(result.ledgerRemoved.inbound).toBe(1);

				const dbCheck = new Database(dbPath, { readonly: true, strict: true });
				const row = dbCheck.query("SELECT origin_key FROM origins WHERE origin_key = ?").get(originKey);
				dbCheck.close();
				expect(row).not.toBeNull();
			} finally {
				chmodSync(sessionsDir, 0o700);
				if (existsSync(originDir)) chmodSync(originDir, 0o700);
				rmSync(home.dir, { recursive: true, force: true });
			}
		},
	);

	test("#18: 다른 세션 디렉터리로 복사한 pinned sidecar는 MAC 검증에서 거부된다", () => {
		const dirA = join(tempRoot, "sess-a");
		const dirB = join(tempRoot, "sess-b");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		const key = Buffer.alloc(32, 11);
		const freshA = { floors: "FLOORS-A\n", owner: "OWNER-A\n" };
		const freshB = { floors: "FLOORS-B\n", owner: "OWNER-B\n" };
		const reports: unknown[] = [];

		expect(pinPrefix(dirA, freshA, true, (e) => reports.push(e), key).pin).toBe("none");
		copyFileSync(join(dirA, PINNED_OWNER_DOCS_FILE), join(dirB, PINNED_OWNER_DOCS_FILE));
		const res = pinPrefix(dirB, freshB, true, (e) => reports.push(e), key);
		expect(res).toEqual({ ...freshB, pin: "none" });
		expect(reports.length).toBe(1);
	});
});
