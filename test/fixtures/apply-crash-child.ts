// Runs one real `runApply` against a small world on disk and dies at a named step when the test asks for it (the path a
// mid-apply OOM or reboot takes). The world is built once and re-derived from disk on every run, so the re-run picks up
// exactly where the dead process stopped: the checkout, the lock it left, the receipt it did not write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SweepHeartbeat } from "../../src/daemon/heartbeat";
import { type ApplyDeps, type ApplyOptions, type ApplyReceipt, runApply } from "../../src/ops/apply";
import type { BackupResult } from "../../src/ops/backup";
import { DEPS_MARKER, depsHash } from "../../src/ops/deps";
import type { Gate } from "../../src/ops/gates";
import type { RunResult } from "../../src/ops/run-types";

/** The world of one crash test: absolute paths, and the receipt name that stays the same across runs. */
interface WorldSpec {
	root: string;
	home: string;
	repo: string;
	stamp: string;
}

const DAEMON_STARTED = "daemon-started";
const RESTARTS = "restarts";

const bunPath = process.execPath;
const gitEnv = (): Record<string, string | undefined> => ({ ...process.env, LC_ALL: "C" });

/** Runs git in the world's own config (an isolated HOME, no system config), failing loudly. */
function git(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { env: gitEnv() });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

/**
 * The world, created when it is not there yet: an isolated git config, a home with a config, and a checkout on main
 * holding `src/main.ts` with its dependencies already marked installed.
 */
function buildWorld(spec: WorldSpec): void {
	const hostHome = join(spec.root, "hosthome");
	mkdirSync(hostHome, { recursive: true });
	mkdirSync(join(spec.home, "logs"), { recursive: true, mode: 0o700 });
	writeFileSync(join(hostHome, "gitconfig"), "[user]\n\tname = fixture\n\temail = fixture@example.invalid\n", {
		mode: 0o600,
	});
	process.env.HOME = hostHome;
	process.env.GIT_CONFIG_GLOBAL = join(hostHome, "gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	const configPath = join(spec.home, "config.json");
	if (!existsSync(configPath)) writeFileSync(configPath, '{"schemaVersion":1}\n', { mode: 0o600 });
	mkdirSync(join(spec.repo, "src"), { recursive: true });
	const main = join(spec.repo, "src", "main.ts");
	if (!existsSync(main)) writeFileSync(main, "// the daemon entry point\n");
	const pkg = join(spec.repo, "package.json");
	if (!existsSync(pkg)) writeFileSync(pkg, '{"name":"crash-world"}\n');
	const lock = join(spec.repo, "bun.lock");
	if (!existsSync(lock)) writeFileSync(lock, "lock\n");
	if (!existsSync(join(spec.repo, ".git"))) {
		git(["init", "-q", "-b", "main", spec.repo]);
		git(["-C", spec.repo, "add", "src/main.ts", "package.json", "bun.lock"]);
		git(["-C", spec.repo, "commit", "-q", "-m", "world"]);
	}
	// The dependencies of this checkout as the apply's ensureDeps wants to find them: a marker holding the deps hash.
	mkdirSync(join(spec.repo, "node_modules"), { recursive: true });
	writeFileSync(join(spec.repo, DEPS_MARKER), `${depsHash(spec.repo)}\n`);
}

/** The fake host the apply talks to: a systemctl that only records restarts, a daemon that always answers. */
function makeDeps(spec: WorldSpec): ApplyDeps {
	const daemonStarted = (): number | undefined => {
		try {
			return Number(readFileSync(join(spec.root, DAEMON_STARTED), "utf8").trim());
		} catch {
			return undefined;
		}
	};
	const recordRestart = (): void => {
		const next = Math.max(Date.now() + 1_000, (daemonStarted() ?? 0) + 1_000);
		writeFileSync(join(spec.root, DAEMON_STARTED), String(next));
		let count = 0;
		try {
			count = Number(readFileSync(join(spec.root, RESTARTS), "utf8").trim());
		} catch {
			count = 0;
		}
		writeFileSync(join(spec.root, RESTARTS), String(count + 1));
	};
	const run = async (cmd: string[], options?: { env?: Record<string, string> }): Promise<RunResult> => {
		const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
		if (cmd[0] === "systemctl") {
			const verb = cmd[2];
			if (verb === "is-active") return ok();
			if (verb === "restart") {
				recordRestart();
				return ok();
			}
			if (verb === "list-units") return ok();
			if (verb === "show") return ok();
			throw new Error(`unexpected systemctl ${cmd.join(" ")}`);
		}
		if (cmd[0] !== "git") throw new Error(`unexpected command ${cmd.join(" ")}`);
		const proc = Bun.spawnSync(cmd, { env: { ...gitEnv(), ...options?.env } });
		return {
			code: proc.exitCode ?? 1,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	};
	const backup = (): BackupResult => {
		const dir = join(spec.home, "backups");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = join(dir, `ompbot-${spec.stamp}-${process.pid}.db`);
		writeFileSync(file, "backup\n", { mode: 0o600 });
		return {
			file,
			bytes: 7,
			sha256: "0".repeat(64),
			bundle: undefined,
			bundleBytes: undefined,
			bundleSha256: undefined,
			stamp: undefined,
			kept: [],
			removed: [],
		};
	};
	const gates: Gate[] = [];
	return {
		homeDir: spec.home,
		unit: "ompbot",
		repoDir: spec.repo,
		pathEnv: `${dirname(bunPath)}:${process.env.PATH ?? ""}`,
		now: () => Date.now(),
		sleep: (ms) => Bun.sleep(ms),
		run,
		callDaemon: async (request) => {
			const op = typeof request === "object" && request !== null && "op" in request ? String(request.op) : "";
			return op === "drain_cancel" ? { ok: true } : { ok: true, status: {} };
		},
		drain: async () => ({ ok: true, counts: { turns: 0, hostTools: 0, approvals: 0 } }),
		backup,
		gates: () => gates,
		doctor: async () => ({ code: 0, lines: [] }),
		lockStartedAt: daemonStarted,
		heartbeat: (): SweepHeartbeat | undefined => {
			const started = daemonStarted();
			if (started === undefined) return undefined;
			return {
				ts: new Date(started + 500),
				loopMs: 1,
				discord: { state: "up", since: new Date(started) },
				draining: false,
			};
		},
		pid: process.pid,
		isAlive: (pid) => {
			if (pid === process.pid) return true;
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		isExecutable: (path) => path === bunPath,
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

const spec = JSON.parse(process.argv[2] ?? "") as WorldSpec;
if (typeof spec.root !== "string" || typeof spec.home !== "string" || typeof spec.repo !== "string") {
	throw new Error("usage: bun test/fixtures/apply-crash-child.ts '<WorldSpec JSON>'");
}
buildWorld(spec);
const options: ApplyOptions = { timeoutMin: 5, stamp: spec.stamp };
const outcome = await runApply(options, makeDeps(spec));
const receipt: ApplyReceipt = outcome.receipt;
process.stdout.write(`${JSON.stringify({ status: receipt.status, exitCode: outcome.exitCode })}\n`);
