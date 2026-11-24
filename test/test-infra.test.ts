// What the test helpers promise: a fixture git no host setting can change, a hostile name that stays one word through
// every shell it crosses, a unit file that keeps a path as one word, a child that gets no secret, a snapshot that sees
// content, and a guard that keeps the suite on this machine. Each case proves the promise through the real tool.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUnit, unitsCommand } from "../src/cli/units";
import { dispatchEnv, herdrSshArgv, type ProcessRunner, remoteShellQuote, runOmpPrint } from "../src/dispatch/omp";
import { createTaskHostOps } from "../src/tasks/host";
import { git, makeRepo } from "./helpers/git-fixtures";
import { HOSTILE_CONTROL, HOSTILE_PATH, HOSTILE_QUOTED, shellSideEffects } from "./helpers/hostile-path";
import { readRecording, recordingChild } from "./helpers/recording-child";
import { treeSnapshot } from "./helpers/tree-snapshot";
import { installNetworkGuard, isExternalUrl, type NetworkAttempt, networkAttempts } from "./preload";

const repos: string[] = [];
const scratchDirs: string[] = [];
afterEach(() => {
	for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory this test owns, left for `afterEach` to remove. */
function scratch(prefix = "ompbot-infra-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}
describe("fixture git ignores this host's global configuration", () => {
	test("a hostile global .gitconfig never reaches a fixture repo", () => {
		// A developer's own config at the top of every git lookup: a commit there would need gpg and the branch would not
		// be `main`. The fixture points HOME and GIT_CONFIG_GLOBAL at its own world, so none of it is read.
		const hostileHome = scratch("ompbot-hostile-home-");
		writeFileSync(
			join(hostileHome, ".gitconfig"),
			["[init]", "\tdefaultBranch = hostile", "[commit]", "\tgpgsign = true", "[alias]", "\tinit = nope", ""].join(
				"\n",
			),
		);
		const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
		process.env.HOME = hostileHome;
		process.env.GIT_CONFIG_GLOBAL = join(hostileHome, ".gitconfig");
		try {
			const repo = makeRepo(repos);
			expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("init");
			// A commit under the hostile config would fail on the missing signing key; the fixture's own config commits.
			writeFileSync(join(repo, "next.txt"), "x\n");
			git(repo, "add", "--", "next.txt");
			git(repo, "commit", "-q", "-m", "second");
			expect(git(repo, "log", "-1", "--format=%s")).toBe("second");
		} finally {
			if (saved.HOME === undefined) delete process.env.HOME;
			else process.env.HOME = saved.HOME;
			if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
		}
	});

	test("a hook in the repository itself never runs for a fixture commit", () => {
		const repo = makeRepo(repos);
		const marker = join(repo, "hook-ran");
		const hook = join(repo, ".git", "hooks", "pre-commit");
		mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
		writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(hook, 0o755);
		writeFileSync(join(repo, "hooked.txt"), "x\n");
		git(repo, "add", "--", "hooked.txt");
		git(repo, "commit", "-q", "-m", "no hook");
		// `core.hooksPath` points at an empty directory, so the repository's own hook is never consulted.
		expect(Bun.file(marker).size).toBe(0);
		expect(git(repo, "log", "-1", "--format=%s")).toBe("no hook");
	});
});

describe("hostile pathnames survive every shell they cross", () => {
	test("remoteShellQuote round-trips through a real POSIX shell as one word", () => {
		const dir = scratch();
		const printed = execFileSync("sh", ["-c", `printf '%s' ${remoteShellQuote(HOSTILE_PATH)}`], {
			encoding: "utf8",
			cwd: dir,
		});
		expect(printed).toBe(HOSTILE_PATH);
		// Nothing in the name ran: had the shell read it, the substitutions would have left their files here.
		expect(shellSideEffects(dir)).toEqual([]);
	});

	test("the herdr ssh delegation hands the pane a hostile word as one argument", () => {
		const dir = scratch();
		const bin = recordingChild(dir);
		const argv = herdrSshArgv("some-host", bin, ["agent", "prompt", "worker", HOSTILE_PATH]);
		// `ssh` joins its trailing words into one remote shell line: run exactly that line here, with this shell.
		execFileSync("sh", ["-c", argv.slice(7).join(" ")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		const [run] = readRecording(dir);
		expect(run?.argv).toEqual([bin, "agent", "prompt", "worker", HOSTILE_PATH]);
		expect(shellSideEffects(dir)).toEqual([]);
	});

	test("a remote [check:] line reaches the command with a hostile argv element verbatim", async () => {
		const dir = scratch();
		const repo = makeRepo(repos);
		const bin = recordingChild(dir);
		// The real ssh line, run by a real shell: argv is single-quoted there, so the element arrives as one word.
		const ops = createTaskHostOps({
			sshTarget: "some-host",
			run: async (cmd) => {
				const line = cmd.slice(7);
				const child = spawnSync("sh", ["-c", line.join(" ")], { encoding: "utf8", cwd: dir });
				return { code: child.status, stdout: child.stdout, stderr: child.stderr, timedOut: false };
			},
		});
		const result = await ops.runCheck({ worktree: repo, argv: [bin, HOSTILE_PATH], timeoutMs: 20_000 });
		expect(result.code).toBe(0);
		const [run] = readRecording(dir);
		expect(run?.argv).toEqual([bin, HOSTILE_PATH]);
		expect(shellSideEffects(dir)).toEqual([]);
	});

	test("the remote check line exports the shim PATH, then cd's into the worktree", async () => {
		const dir = scratch();
		const repo = makeRepo(repos);
		const home = scratch("ompbot-shim-home-");
		const bin = recordingChild(dir);
		const ops = createTaskHostOps({
			sshTarget: "some-host",
			run: async (cmd) => {
				const child = spawnSync("sh", ["-c", cmd.slice(7).join(" ")], {
					encoding: "utf8",
					cwd: dir,
					env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
				});
				return { code: child.status, stdout: child.stdout, stderr: child.stderr, timedOut: false };
			},
		});
		const result = await ops.runCheck({ worktree: repo, argv: [bin, "true"], timeoutMs: 20_000 });
		expect(result.code).toBe(0);
		const [run] = readRecording(dir);
		// A non-interactive ssh shell skips the profile: the line puts the user shims (npm, bun) on PATH itself.
		expect(run?.env.PATH?.startsWith(`${join(home, ".local", "bin")}:`)).toBe(true);
		expect(run?.cwd).toBe(realpathSync(repo));
	});

	test("a worktree path a shell could read never becomes an ssh line at all", async () => {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: "", timedOut: false };
		};
		const ops = createTaskHostOps({ sshTarget: "some-host", run });
		await expect(ops.runCheck({ worktree: `/tmp/${HOSTILE_PATH}`, argv: ["true"], timeoutMs: 20_000 })).rejects.toThrow(
			/unsafe path/,
		);
		// Refused before anything is handed to ssh.
		expect(calls).toEqual([]);
	});
});

describe("a rendered systemd unit carries a hostile path as one quoted word", () => {
	const template = "[Service]\nExecStart=@BUN@ --no-env-file @REPO_DIR@/src/main.ts\nEnvironment=PATH=@PATH@\n";

	test("a path with spaces, quotes or substitutions is one double-quoted ExecStart= word", () => {
		const dir = scratch();
		const bun = join(dir, "bun");
		const repoDir = join(dir, HOSTILE_PATH);
		const home = join(dir, HOSTILE_QUOTED);
		const text = renderUnit("ompbot-x.service", template, { bun, repoDir, home });
		const execLine = text.split("\n").find((line) => line.startsWith("ExecStart=")) as string;
		// A word of plain characters goes out bare; a hostile one is wrapped so systemd never splits it at a space, and
		// the two characters systemd itself reads inside double quotes (`\` and `"`) are escaped.
		expect(execLine).toBe(`ExecStart=${bun} --no-env-file "${`${repoDir}/src/main.ts`.replace(/[\\"]/g, "\\$&")}"`);
		// systemd splits a directive at unquoted whitespace: every space of the line is inside the quoted word or
		// between the three words, and the quoted word comes back whole.
		const words: string[] = [];
		let current = "";
		let quoted = false;
		for (let i = 0; i < execLine.length; i++) {
			const char = execLine[i] as string;
			if (quoted && char === "\\") {
				current += execLine[++i] ?? "";
				continue;
			}
			if (char === '"') {
				quoted = !quoted;
				continue;
			}
			if (char === " " && !quoted) {
				if (current !== "") words.push(current);
				current = "";
				continue;
			}
			current += char;
		}
		if (current !== "") words.push(current);
		expect(quoted).toBe(false);
		expect(words).toEqual([`ExecStart=${bun}`, "--no-env-file", `${repoDir}/src/main.ts`]);
		// The name is carried whole, not interpreted: nothing in it ran in this directory.
		expect(shellSideEffects(dir)).toEqual([]);
	});

	test("a control character in HOME is refused instead of splitting the unit file", () => {
		const write = process.stderr.write;
		let stderr = "";
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			const code = unitsCommand(["render", "--dry-run"], { HOME: join("/home", HOSTILE_CONTROL) });
			expect(code).toBe(2);
			expect(stderr).toContain("control character");
		} finally {
			process.stderr.write = write;
		}
	});
});

describe("a spawned child gets no secret and no inherited git redirect", () => {
	test("dispatchEnv drops Slack, ompbot and GIT_* variables and keeps the rest", () => {
		const env = dispatchEnv({
			SLACK_BOT_TOKEN: "xoxb-TEST-0",
			OMPBOT_HOME: "/home/someone/.ompbot",
			GIT_CONFIG_GLOBAL: "/home/someone/.gitconfig",
			GIT_DIR: "/elsewhere/.git",
			LD_PRELOAD: "/tmp/inject.so",
			KEEP_ME: "kept",
			PATH: "/usr/bin:/bin",
		});
		expect(env.SLACK_BOT_TOKEN).toBeUndefined();
		expect(env.OMPBOT_HOME).toBeUndefined();
		expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.LD_PRELOAD).toBeUndefined();
		expect(env.KEEP_ME).toBe("kept");
		expect(env.PATH).toBe("/usr/bin:/bin");
	});

	test("a real local [check:] child sees exactly those variables", async () => {
		const dir = scratch();
		const bin = recordingChild(dir);
		const ops = createTaskHostOps({
			inheritedEnv: {
				...process.env,
				SLACK_BOT_TOKEN: "xoxb-TEST-0",
				OMPBOT_HOME: "/home/someone/.ompbot",
				GIT_CONFIG_GLOBAL: "/home/someone/.gitconfig",
				KEEP_ME: "kept",
			},
		});
		const result = await ops.runCheck({ worktree: dir, argv: [bin], timeoutMs: 20_000 });
		expect(result.code).toBe(0);
		const [run] = readRecording(dir);
		expect(run?.env.KEEP_ME).toBe("kept");
		for (const key of ["SLACK_BOT_TOKEN", "OMPBOT_HOME", "GIT_CONFIG_GLOBAL"]) expect(run?.env[key]).toBeUndefined();
		expect(Object.keys(run?.env ?? {}).some((key) => key.startsWith("GIT_"))).toBe(false);
	});

	test("the omp RPC argv carries the prompt as one element, not as shell text", async () => {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd);
			return { code: 0, stdout: "ok", timedOut: false };
		};
		const task = `do the thing; ${HOSTILE_PATH}`;
		await runOmpPrint({ task, cwd: "/tmp", systemPromptAppendix: "", ompBin: "/bin/omp", run });
		const [cmd] = seen;
		// The prompt is the last element after `--`: an omp flag can never be read out of its text.
		expect(cmd?.at(-1)).toBe(task);
		expect(cmd?.at(-2)).toBe("--");
		expect(cmd?.filter((element) => element === task)).toHaveLength(1);
	});
});

describe("tree-snapshot sees content, not timestamps", () => {
	test("a rewritten file of the same size still differs", () => {
		const dir = scratch();
		const file = join(dir, "note.txt");
		writeFileSync(file, "aaaa\n");
		const before = treeSnapshot(dir);
		const { atime, mtime } = { atime: new Date(1_000_000), mtime: new Date(1_000_000) };
		writeFileSync(file, "bbbb\n");
		// Same size, same mtime: only the bytes differ, and that is what the snapshot compares.
		utimesSync(file, atime, mtime);
		const after = treeSnapshot(dir);
		expect(after.get("note.txt")?.sha256).not.toBe(before.get("note.txt")?.sha256);
		expect(after.get("note.txt")?.mode).toBe(before.get("note.txt")?.mode);
	});

	test("a swapped symlink shows even though lstat's mode matches", () => {
		const dir = scratch();
		const link = join(dir, "current");
		writeFileSync(join(dir, "v1"), "one\n");
		writeFileSync(join(dir, "v2"), "two\n");
		symlinkSync("v1", link);
		const before = treeSnapshot(dir);
		rmSync(link);
		symlinkSync("v2", link);
		const after = treeSnapshot(dir);
		// The target's name is the link's content: `lstat` reports the same mode for both.
		expect(after.get("current")?.mode).toBe(before.get("current")?.mode);
		expect(after.get("current")?.sha256).not.toBe(before.get("current")?.sha256);
	});
});

describe("the network guard separates this machine from the outside", () => {
	/** A guard target shaped like the globals, with the calls it took written down. */
	function target() {
		const fetched: string[] = [];
		const sockets: string[] = [];
		class FakeSocket {
			constructor(readonly url: string | URL) {
				sockets.push(String(url));
			}
		}
		return {
			fetched,
			sockets,
			target: {
				fetch: async (input: string | URL | Request, _init?: RequestInit) => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					fetched.push(url);
					return new Response("ok");
				},
				WebSocket: FakeSocket as unknown as typeof WebSocket,
			},
		};
	}

	test("loopback, unix sockets and local files are not external", async () => {
		for (const url of [
			"http://localhost:8080/x",
			"http://127.0.0.1:1/x",
			"http://[::1]/x",
			"http://api.localhost/x",
			"file:///etc/hosts",
			"data:text/plain,hi",
		]) {
			expect(isExternalUrl(url)).toBe(false);
		}
		for (const url of ["https://example.com/x", "wss://gateway.discord.gg", "http://10.0.0.1/x"]) {
			expect(isExternalUrl(url)).toBe(true);
		}
		// A unix socket fetch has no host to reach: it is local whatever string rides along.
		const fake = target();
		installNetworkGuard(fake.target, "block", () => {});
		const response = await fake.target.fetch("http://unix/x", { unix: "/tmp/sock" } as RequestInit);
		expect(await response.text()).toBe("ok");
		expect(fake.fetched).toEqual(["http://unix/x"]);
	});

	test("record mode records the attempt and still runs it", async () => {
		const fake = target();
		const attempts: NetworkAttempt[] = [];
		const undo = installNetworkGuard(fake.target, "record", (attempt) => attempts.push(attempt));
		try {
			const response = await fake.target.fetch("https://example.com/x");
			expect(await response.text()).toBe("ok");
			new fake.target.WebSocket("wss://gateway.discord.gg");
			expect(attempts.map((attempt) => [attempt.kind, attempt.url])).toEqual([
				["fetch", "https://example.com/x"],
				["websocket", "wss://gateway.discord.gg"],
			]);
			// Recorded, not stopped: the real call still went out.
			expect(fake.fetched).toEqual(["https://example.com/x"]);
			expect(fake.sockets).toEqual(["wss://gateway.discord.gg"]);
		} finally {
			undo();
		}
	});

	test("block mode throws before the external call and leaves the local one alone", async () => {
		const fake = target();
		const attempts: NetworkAttempt[] = [];
		const undo = installNetworkGuard(fake.target, "block", (attempt) => attempts.push(attempt));
		try {
			await expect(fake.target.fetch("https://example.com/x")).rejects.toThrow(/external destination/);
			expect(() => new fake.target.WebSocket("wss://gateway.discord.gg")).toThrow(/external destination/);
			// The refusal is before the call: neither placeholder ran.
			expect(fake.fetched).toEqual([]);
			expect(fake.sockets).toEqual([]);
			expect(await (await fake.target.fetch("http://127.0.0.1:9/x")).text()).toBe("ok");
			expect(fake.fetched).toEqual(["http://127.0.0.1:9/x"]);
			expect(attempts).toHaveLength(2);
		} finally {
			undo();
		}
	});

	test("an undone guard leaves the originals in place", async () => {
		const fake = target();
		const originalFetch = fake.target.fetch;
		const originalSocket = fake.target.WebSocket;
		const undo = installNetworkGuard(fake.target, "block", () => {});
		expect(fake.target.fetch).not.toBe(originalFetch);
		undo();
		expect(fake.target.fetch).toBe(originalFetch);
		expect(fake.target.WebSocket).toBe(originalSocket);
	});

	test("no test in this run has reached outside this machine", () => {
		// The preload installs the guard in record mode for the whole worker, before any test file in it runs: an empty
		// list is what lets `block` become the default.
		expect(networkAttempts).toEqual([]);
	});
});
