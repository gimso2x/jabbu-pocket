import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, type JabbuConfig, loadConfig } from "../src/config";
import { RESTART_FIELDS } from "../src/daemon/reload";
import { botRpcEnv } from "../src/daemon/run";
import { dispatchEnv, type RunProcessOptions, runOmpPrint } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { buildChildEnv } from "../src/omp/env";
import { RpcOmpDriver, type RpcOmpDriverOptions } from "../src/omp/rpc-driver";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const SESSIONS = mkdtempSync(join(tmpdir(), "jabbu-profile-sessions-"));
const SESSION_DIR = join(SESSIONS, "s");
afterAll(() => rmSync(SESSIONS, { recursive: true, force: true }));

/** A parent env with every key the profile wiring touches: an inherited agent dir and bot secrets (fake values). */
const BASE = {
	PATH: "/usr/bin:/bin",
	HOME: "/home/u",
	PI_CODING_AGENT_DIR: "/custom/agent",
	SLACK_BOT_TOKEN: "xoxb-TEST-0",
	JABBU_HOME: "/home/u/.jabbu",
	FOO: "1",
};

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The argv and env of the child a real `RpcOmpDriver` starts with `options` (on an in-memory omp peer). */
async function rpcChild(
	options: Omit<RpcOmpDriverOptions, "ompExecutable" | "cwd" | "sessionDir">,
): Promise<{ cmd: string[]; env: Record<string, string> }> {
	const work = tempDir("jabbu-profile-cwd-");
	const peer = new FakeOmpPeer();
	const driver = new RpcOmpDriver({
		ompExecutable: fakeOmpExecutable(work),
		cwd: join(work, "ws"),
		// Same for every call, so argv comparisons see only what the options change.
		sessionDir: SESSION_DIR,
		spawn: peer.spawn,
		...options,
	});
	await driver.start();
	try {
		const child = peer.spawned.at(-1);
		if (child === undefined) throw new Error("the driver did not spawn a child");
		// The executable path differs per call; the argv after it is what the comparison is about.
		return { cmd: child.argv.slice(1), env: child.options.env };
	} finally {
		await driver.stop();
	}
}

/** Every `omp -p` call of a fake runner. */
function recordingRunner(): {
	calls: Array<{ cmd: string[]; opts: RunProcessOptions }>;
	run: (cmd: string[], opts: RunProcessOptions) => Promise<{ code: number; stdout: string; timedOut: boolean }>;
} {
	const calls: Array<{ cmd: string[]; opts: RunProcessOptions }> = [];
	return {
		calls,
		run: async (cmd, opts) => {
			calls.push({ cmd, opts });
			return { code: 0, stdout: "OK\n", timedOut: false };
		},
	};
}

const PRINT = { task: "요약", cwd: "/ws", systemPromptAppendix: "FLOORS", ompBin: "/bin/omp" };

describe("AC-1: without ompProfile the children are what they were", () => {
	test("the daemon's rpc options are the old literal and the spawned child env/argv match the old options", async () => {
		expect(botRpcEnv(undefined, BASE)).toEqual({
			env: { OMP_WIKI_NOTE_DISABLE: "1", PI_INTENT_TRACING: "1", OMP_HOST_DRIVER: "jabbu-pocket" },
		});
		const before = await rpcChild({
			model: "m",
			env: { OMP_WIKI_NOTE_DISABLE: "1", PI_INTENT_TRACING: "1", OMP_HOST_DRIVER: "jabbu-pocket" },
			extraArgs: ["--x"],
		});
		const after = await rpcChild({ model: "m", ...botRpcEnv(undefined, BASE), extraArgs: ["--x"] });
		expect(after).toEqual(before);
		// No baseEnv: the child env is the daemon's own process env minus bot secrets, as before.
		expect(after.env).toEqual(
			buildChildEnv({ OMP_WIKI_NOTE_DISABLE: "1", PI_INTENT_TRACING: "1", OMP_HOST_DRIVER: "jabbu-pocket" }),
		);
	});

	test("runOmpPrint keeps the inherited agent dir, adds no OMP_PROFILE and keeps its argv", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run });
		expect(calls[0]?.opts.env).toEqual(dispatchEnv(BASE));
		expect(calls[0]?.opts.env?.PI_CODING_AGENT_DIR).toBe("/custom/agent");
		expect(calls[0]?.opts.env).not.toHaveProperty("OMP_PROFILE");
		expect(calls[0]?.cmd).toEqual(["/bin/omp", "-p", "--no-session", "--append-system-prompt", "FLOORS", "--", "요약"]);
	});
});

describe("AC-2: ompProfile reaches every bot omp child", () => {
	test("rpc driver (chat, lane and monitor turns): OMP_PROFILE set, PI_CODING_AGENT_DIR and bot secrets gone", async () => {
		const plain = await rpcChild({ ...botRpcEnv(undefined), baseEnv: BASE });
		const child = await rpcChild(botRpcEnv("jabbu", BASE));
		expect(child.env.OMP_PROFILE).toBe("jabbu");
		expect(child.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
		expect(child.env).not.toHaveProperty("SLACK_BOT_TOKEN");
		expect(child.env).not.toHaveProperty("JABBU_HOME");
		expect(child.env).toMatchObject({ OMP_WIKI_NOTE_DISABLE: "1", PI_INTENT_TRACING: "1", FOO: "1", PATH: BASE.PATH });
		expect(child.cmd).toEqual(plain.cmd);
	});

	test("runOmpPrint with ompProfile: OMP_PROFILE set, PI_CODING_AGENT_DIR dropped, argv unchanged", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run, ompProfile: "jabbu" });
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run });
		expect(calls[0]?.opts.env?.OMP_PROFILE).toBe("jabbu");
		expect(calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
		expect(calls[0]?.cmd).toEqual(calls[1]?.cmd as string[]);
	});

	test("an explicit env (a caller's own agent dir) still wins over the profile", async () => {
		const { calls, run } = recordingRunner();
		await runOmpPrint({ ...PRINT, inheritedEnv: BASE, run, ompProfile: "jabbu", env: { PI_CODING_AGENT_DIR: "/qa" } });
		expect(calls[0]?.opts.env?.PI_CODING_AGENT_DIR).toBe("/qa");
	});

	test("simple dispatch (jabbu_dispatch omp -p) runs with the configured profile", async () => {
		const { calls, run } = recordingRunner();
		const built = buildDispatchTool({
			originKey: "discord/dm/200000000000000001",
			ompExecutable: "omp",
			ompProfile: "jabbu",
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run,
		});
		const saved = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "/custom/agent";
		try {
			await built.execute({ task: "빌드 상태 요약" }, { signal: new AbortController().signal });
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts.env?.OMP_PROFILE).toBe("jabbu");
		expect(calls[0]?.opts.env).not.toHaveProperty("PI_CODING_AGENT_DIR");
	});
});

describe("AC-3: ompProfile follows omp's profile name rule", () => {
	function homeWith(extra: Record<string, unknown>): string {
		const home = tempDir("jabbu-profile-cfg-");
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
				...extra,
			}),
		);
		return home;
	}
	const load = (home: string) => loadConfig(home, { checkTokens: false });

	test.each([["Jabbu"], [".jabbu"], ["-x"], ["omp bot"], ["a/b"], [""], ["x".repeat(65)], [7]])(
		"%p is refused naming ompProfile",
		(value) => {
			let error: unknown;
			try {
				load(homeWith({ ompProfile: value }));
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).message).toContain("ompProfile");
		},
	);

	test("a valid name loads, absent stays undefined, and changing it needs a restart", () => {
		expect(load(homeWith({ ompProfile: "jabbu" })).ompProfile).toBe("jabbu");
		expect(load(homeWith({ ompProfile: "a1._-z" })).ompProfile).toBe("a1._-z");
		expect(load(homeWith({ ompProfile: "x".repeat(64) })).ompProfile).toBe("x".repeat(64));
		expect(load(homeWith({})).ompProfile).toBeUndefined();
		expect(load(homeWith({})).warnings).toBeUndefined();
		expect(RESTART_FIELDS).toContain("ompProfile");
	});
});

describe("ompConfigOverlay: one --config for every omp child of the install", () => {
	const OLD_PRINT_ARGV = ["omp", "-p", "--no-session", "--append-system-prompt"];

	/** A loaded config (tokens unchecked) whose home has `overlay` as `glm.omp.yml`, set as `ompConfigOverlay` unless `null`. */
	function loaded(overlay: string | null, extra: Record<string, unknown> = {}): JabbuConfig {
		const home = tempDir("jabbu-overlay-cfg-");
		if (overlay !== null) writeFileSync(join(home, "glm.omp.yml"), overlay);
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
				...(overlay === null ? {} : { ompConfigOverlay: "glm.omp.yml" }),
				...extra,
			}),
		);
		return loadConfig(home, { checkTokens: false });
	}

	async function simpleDispatchArgv(ompConfigOverlay: string | undefined): Promise<string[]> {
		const { calls, run } = recordingRunner();
		const built = buildDispatchTool({
			originKey: "discord/dm/200000000000000001",
			ompExecutable: "omp",
			...(ompConfigOverlay === undefined ? {} : { ompConfigOverlay }),
			homeDir: "/h",
			workspaceDir: "/h/workspace",
			log: { info() {}, warn() {} },
			run,
		});
		await built.execute({ task: "빌드 상태 요약" }, { signal: new AbortController().signal });
		expect(calls).toHaveLength(1);
		return calls[0]?.cmd ?? [];
	}

	test("AC-1: chat, monitor and lane RPC children and the simple dispatch run get --config <overlay>", async () => {
		const config = loaded("modelRoles:\n  default: zai/glm-5.3-flash\n");
		const overlay = join(config.homeDir, "glm.omp.yml");
		expect(config.ompConfigOverlay).toBe(overlay);
		const child = await rpcChild({
			model: "m",
			...botRpcEnv(undefined, BASE),
			overlayConfig: overlay,
			extraArgs: ["--x"],
		});
		expect(child.cmd).toEqual([
			"--mode",
			"rpc",
			"--no-title",
			"--model",
			"m",
			"--session-dir",
			SESSION_DIR,
			"--config",
			overlay,
			"--x",
		]);
		const argv = await simpleDispatchArgv(overlay);
		expect(argv.slice(0, 6)).toEqual(["omp", "-p", "--no-session", "--config", overlay, "--append-system-prompt"]);
		expect(argv.slice(-2)).toEqual(["--", "빌드 상태 요약"]);
	});

	test("AC-2: without the key the RPC child argv and the simple dispatch argv are byte for byte the old ones", async () => {
		const config = loaded(null);
		expect("ompConfigOverlay" in config).toBe(false);
		const before = await rpcChild({ model: "m", env: { OMP_WIKI_NOTE_DISABLE: "1" }, extraArgs: ["--x"] });
		expect(before.cmd).toEqual(["--mode", "rpc", "--no-title", "--model", "m", "--session-dir", SESSION_DIR, "--x"]);
		const argv = await simpleDispatchArgv(undefined);
		expect(argv.slice(0, 4)).toEqual(OLD_PRINT_ARGV);
		expect(argv).toHaveLength(7);
		expect(argv).not.toContain("--config");
	});
});

test("a child whose dialogs reach the owner runs as rpc-ui (omp's ask tool needs a UI session); others stay rpc", async () => {
	const headless = await rpcChild({ model: "m", extraArgs: ["--x"] });
	const rest = ["--no-title", "--model", "m", "--session-dir", SESSION_DIR, "--x"];
	expect(headless.cmd).toEqual(["--mode", "rpc", ...rest]);
	const answered = await rpcChild({ model: "m", extraArgs: ["--x"], answerDialog: async () => ({ value: "x" }) });
	expect(answered.cmd).toEqual(["--mode", "rpc-ui", ...rest]);
});
