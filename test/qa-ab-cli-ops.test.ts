import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/cli/index";
import { initCommand } from "../src/cli/init";
import { unitsCommand } from "../src/cli/units";
import { defaultHomeDir, workspaceOverlapsHome } from "../src/config";
import { SweepHeartbeatWriter } from "../src/daemon/heartbeat";
import { RestartLauncher } from "../src/daemon/restart";
import type { ProcessRunner } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { APPLY_LOCK_FILE, releaseApplyLock } from "../src/ops/apply-lock";
import { acquireApplyLock } from "../src/ops/apply-lock-wait";
import { freezePath, frozenMessage, readFreeze } from "../src/ops/freeze";
import { collectGates, gateOptionsFromConfig } from "../src/ops/gates";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import { redact } from "../src/redact";
import { makeHome } from "./helpers/bot-home";
import { ROOMY_STATFS } from "./helpers/disk";

const OWNER = "100000000000000001";
const APP = "200000000000000002";

let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "jabbu-qa-ab-cli-"));
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

function fakeOmp(): string {
	const path = join(tempRoot, "fake-omp");
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

describe("qa-ab CLI·홈·ops 수정", () => {
	test("#3: defaultHomeDir expands ~ and ~/ and refuses a relative JABBU_HOME", () => {
		expect(defaultHomeDir({ JABBU_HOME: "~" })).toBe(homedir());
		expect(defaultHomeDir({ JABBU_HOME: "~/my-jabbu" })).toBe(join(homedir(), "my-jabbu"));
		// "~other" is never expanded to another user's home: it is refused like any relative value.
		expect(() => defaultHomeDir({ JABBU_HOME: "~other/.jabbu" })).toThrow("JABBU_HOME must be absolute");
		expect(() => defaultHomeDir({ JABBU_HOME: "myhome" })).toThrow("JABBU_HOME must be absolute");
	});

	test("#1: init refuses a dangling config.json symlink with exit 2 and leaves no trace", () => {
		const home = join(tempRoot, "home-cfg-link");
		mkdirSync(home, { recursive: true });
		symlinkSync("nowhere", join(home, "config.json"));
		const code = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", fakeOmp()], { JABBU_HOME: home });
		expect(code).toBe(2);
		expect(existsSync(join(home, "secrets"))).toBe(false);
		expect(existsSync(join(home, "workspace"))).toBe(false);
	});

	test("#2: init refuses a symlink JABBU_HOME without changing the target directory's mode", () => {
		const target = join(tempRoot, "real-dir");
		mkdirSync(target, { mode: 0o755 });
		chmodSync(target, 0o755);
		const homeLink = join(tempRoot, "home-link");
		symlinkSync(target, homeLink);
		const code = initCommand(["--owner", OWNER, "--app-id", APP, "--omp", fakeOmp()], { JABBU_HOME: homeLink });
		expect(code).toBe(2);
		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(existsSync(join(target, "config.json"))).toBe(false);
		expect(existsSync(join(target, "secrets"))).toBe(false);
	});

	test("#19/#20: init refuses dangling --workspace symlinks (pointing to secrets/ or anywhere) with exit 2", () => {
		const home19 = join(tempRoot, "home19");
		const ws19 = join(tempRoot, "ws-to-secrets");
		symlinkSync(join(home19, "secrets"), ws19);
		expect(workspaceOverlapsHome(home19, ws19)).toBe(true);
		expect(
			initCommand(["--owner", OWNER, "--app-id", APP, "--omp", fakeOmp(), "--workspace", ws19], { JABBU_HOME: home19 }),
		).toBe(2);
		expect(existsSync(home19)).toBe(false);

		const home20 = join(tempRoot, "home20");
		const ws20 = join(tempRoot, "ws-dangling");
		symlinkSync("does-not-exist", ws20);
		expect(
			initCommand(["--owner", OWNER, "--app-id", APP, "--omp", fakeOmp(), "--workspace", ws20], { JABBU_HOME: home20 }),
		).toBe(2);
		expect(existsSync(home20)).toBe(false);
	});

	test("#4: doctor escapes control characters and OSC sequences from remote ssh/herdr output", async () => {
		const botHome = makeHome("jabbu-qa-ab-doc-");
		try {
			const cfgPath = join(botHome.dir, "config.json");
			const cfg = JSON.parse(await Bun.file(cfgPath).text()) as Record<string, unknown>;
			cfg.herdr = { bin: "/usr/local/bin/herdr" };
			cfg.dispatchHosts = {
				box1: { ssh: "host1" },
				box2: { ssh: "host2" },
			};
			writeFileSync(cfgPath, JSON.stringify(cfg));
			const run: ProcessRunner = async (argv) => {
				if (argv.includes("--version")) {
					return { code: 0, stdout: "herdr 1.0\r\u001b[2Kfake", stderr: "", timedOut: false };
				}
				if (argv.includes("integration")) {
					if (argv.includes("host1")) {
						return { code: 0, stdout: "omp: outdated\u001b]52;c;Yg==\u0007\n", stderr: "", timedOut: false };
					}
					return { code: 1, stdout: "", stderr: "\u001b[2K\rfake line", timedOut: false };
				}
				return { code: 1, stdout: "", stderr: "ssh err\r\u001b]52;c;Yw==\u0007", timedOut: false };
			};
			const lines: string[] = [];
			await doctorCommand(botHome.dir, (line) => lines.push(line), {
				doctor: async () => 0,
				run,
			});
			expect(lines.length).toBeGreaterThan(2);
			for (const line of lines) {
				expect(
					[...line].some((ch) => {
						const code = ch.charCodeAt(0);
						return code < 0x20 || (code >= 0x7f && code <= 0x9f);
					}),
				).toBe(false);
			}
		} finally {
			botHome.remove();
		}
	});

	test("#6: FIFO at apply.lock never blocks gates, acquireApplyLock, releaseApplyLock or RestartLauncher", async () => {
		const home = join(tempRoot, "fifo-home");
		mkdirSync(home, { recursive: true });
		const lockPath = join(home, APPLY_LOCK_FILE);
		expect(Bun.spawnSync(["mkfifo", lockPath]).exitCode).toBe(0);

		const writer = new SweepHeartbeatWriter(home);
		writer.beat(Date.now(), { draining: true });
		writer.stop();
		const gates = collectGates({
			homeDir: home,
			now: Date.now(),
			...gateOptionsFromConfig({
				timezone: "Asia/Seoul",
				offsite: undefined,
				costCap: undefined,
			}),
			statfs: ROOMY_STATFS,
			hostLoad: IDLE_HOST_LOAD,
		});
		const drainGate = gates.find((g) => g.name === "drain_orphaned");
		expect(drainGate).toEqual({ name: "drain_orphaned", state: "closed", detail: "apply_lock=unreadable" });

		const info = { pid: process.pid, stamp: "20261125-000000", startedAt: new Date().toISOString() };
		expect(() => releaseApplyLock(lockPath, info)).toThrow(/not a regular file/);
		await expect(
			acquireApplyLock(
				{ lockPath, lock: { info, held: false }, stamp: info.stamp, limitMs: 1_000 },
				{ now: () => 0, sleep: async () => {}, pid: process.pid, isAlive: () => true, log: () => {} },
			),
		).rejects.toThrow(/not a regular file/);

		const ctrl = new RestartLauncher({
			homeDir: home,
			repoDir: tempRoot,
			pathEnv: "/usr/bin",
			run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
			isExecutable: () => true,
			isAlive: () => true,
			turnsRunning: () => false,
			now: () => Date.now(),
			log: createLogger({ sink: () => {}, clock: { now: () => Date.now() }, redact }),
		});
		await expect(ctrl.request("discord/dm/1", "1:1")).rejects.toThrow(/not a regular file/);
	});

	test("#23: readFreeze clips an oversized hand-edited reason to 200 chars", () => {
		const home = join(tempRoot, "freeze-home");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			freezePath(home),
			JSON.stringify({ since: "2026-11-25T00:00:00Z", reason: "가".repeat(5000), by: "hand" }),
		);
		const state = readFreeze(home);
		expect(state).toBeDefined();
		if (state === undefined) return;
		expect(state.reason.length).toBe(200);
		expect(frozenMessage(state)).toContain("가".repeat(200));
		expect(frozenMessage(state).length).toBeLessThan(350);
	});

	test("#3: units render expands ~/ JABBU_HOME instead of resolving it under cwd", () => {
		const out = join(tempRoot, "units-out");
		const code = unitsCommand(["render", "--out", out], { JABBU_HOME: "~/bot-units-test", HOME: homedir() });
		expect(code).toBe(0);
		const service = readFileSync(join(out, "jabbu.service"), "utf8");
		expect(service).toContain(`Environment=JABBU_HOME=${join(homedir(), "bot-units-test")}`);
		expect(service).not.toContain("/~/");
	});
});
