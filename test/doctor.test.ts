// `jabbu-pocket doctor`'s Discord lines: token file mode, GET /users/@me and
// GET /gateway/bot, on a fake fetch; nothing when Discord is off.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { checkCoreDumpLimit } from "../src/daemon/core-dump";
import { checkDiscord, checkInjectedFiles, runDoctor } from "../src/daemon/doctor";
import { countOmpModels, listOmpModels, readJudgeRole } from "../src/daemon/doctor-omp";
import { checkConfigRepos } from "../src/daemon/doctor-repos";
import { readVersion } from "../src/daemon/tools";
import { makeHome, type TestHome } from "./helpers/bot-home";
import { runBounded } from "./helpers/bounded-child";
import { OFFLINE_DOCTOR } from "./helpers/doctor-network";
import { makeRepo } from "./helpers/git-fixtures";

let home: TestHome;
let lines: string[];
let seen: Array<{ url: string; auth: string | null }>;

const report = (ok: boolean, name: string, detail: string): void => {
	lines.push(`${ok ? "ok" : "fail"} ${name}: ${detail}`);
};

function fakeFetch(answers: Record<string, () => Response>): typeof fetch {
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		const route = Object.keys(answers).find((path) => url.endsWith(path));
		return route === undefined ? new Response("{}", { status: 404 }) : (answers[route]?.() ?? new Response());
	};
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

const healthy = {
	"/users/@me": () => Response.json({ id: "500000000000000000", username: "jabbu" }),
	"/gateway/bot": () => Response.json({ url: "wss://gateway.discord.gg", shards: 1 }),
};

function mkfifo(path: string): void {
	expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
}

/** Writes (or removes, with `undefined`) `ompConfigOverlay` in the test home's config.json and points it at a real file. */
function writeOverlay(content: string | undefined): void {
	const configPath = join(home.dir, "config.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	const overlayPath = join(home.dir, "overlay.yml");
	if (content === undefined) {
		delete config.ompConfigOverlay;
		rmSync(overlayPath, { force: true });
	} else {
		writeFileSync(overlayPath, content);
		config.ompConfigOverlay = overlayPath;
	}
	writeFileSync(configPath, JSON.stringify(config, null, 2));
}

beforeEach(() => {
	home = makeHome("jabbu-doctor-");
	lines = [];
	seen = [];
});

afterEach(() => home.remove());

describe("doctor: omp models", () => {
	/** A stand-in omp that answers `models --json` with the given script body. */
	function fakeOmp(body: string): string {
		const path = join(home.dir, "fake-omp");
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	test("counts the models a logged-in omp lists, and 0 when no provider is logged in", async () => {
		expect(await countOmpModels(fakeOmp(`echo '{"models":[{"id":"a"},{"id":"b"}]}'`))).toBe(2);
		expect(await countOmpModels(fakeOmp(`echo '{"models":[]}'`))).toBe(0);
	});

	test("lists the models as provider/id, or the bare id when no provider is named", async () => {
		expect(await listOmpModels(fakeOmp(`echo '{"models":[{"provider":"anthropic","id":"a"},{"id":"b"}]}'`))).toEqual([
			"anthropic/a",
			"b",
		]);
		expect(await listOmpModels(fakeOmp(`echo '{"models":[]}'`))).toEqual([]);
	});

	test("an entry without an id is unparsable, not counted", async () => {
		expect(await listOmpModels(fakeOmp(`echo '{"models":[{"id":"a"},{}]}'`))).toBe("unparsable output");
		expect(await listOmpModels(fakeOmp(`echo '{"models":"nope"}'`))).toBe("unparsable output");
	});

	test("a failing, garbled or hanging omp is a reason, not a count", async () => {
		expect(await countOmpModels(fakeOmp("exit 3"))).toBe("omp models exited 3");
		expect(await countOmpModels(fakeOmp("echo not-json"))).toBe("unparsable output");
		expect(await countOmpModels(fakeOmp("exec sleep 5"), 200)).toBe("timeout after 0.2s");
		expect(await countOmpModels(home.dir)).toBe(`cannot run ${home.dir} (EACCES)`);
	});
});

// the `omp --version` probe ran with the daemon's whole env, bot secrets included.
describe("doctor: omp --version probe env", () => {
	const FAKE_SECRETS = { SLACK_BOT_TOKEN: "xoxb-TEST-0", SLACK_APP_TOKEN: "xapp-TEST-0", JABBU_TEST_SECRET: "fake" };
	const SRC = join(import.meta.dir, "..", "src");

	/** A stand-in omp that writes the env its `--version` call got to `dump` and answers a version. */
	function envDumpingOmp(path: string, dump: string): void {
		writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then env > '${dump}'; echo 'omp 9.9.9'; fi\n`);
		chmodSync(path, 0o755);
	}

	/**
	 * Runs `code` in a fresh bun started with the fake secrets in its env, like a daemon whose unit or shell exports
	 * them (a child spawned without `env` inherits the startup env, not later `process.env` writes). Returns stdout.
	 */
	async function inBunWithSecrets(code: string): Promise<string> {
		const proc = Bun.spawn([process.execPath, "-e", code], {
			env: { ...process.env, ...FAKE_SECRETS },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect({ exitCode, err }).toEqual({ exitCode: 0, err: "" });
		return out.trim();
	}

	const namesIn = (dump: string): string[] =>
		readFileSync(dump, "utf8")
			.split("\n")
			.map((line) => line.split("=")[0] ?? "")
			.filter((name) => name !== "");

	const secretNamesIn = (dump: string): string[] =>
		namesIn(dump).filter((name) => name.startsWith("SLACK_") || name.startsWith("JABBU_"));

	test("readVersion gives the child no SLACK_/JABBU_ env by default", async () => {
		const omp = join(home.dir, "env-omp");
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(omp, dump);
		const version = await inBunWithSecrets(
			`import { readVersion } from ${JSON.stringify(join(SRC, "daemon", "tools"))};
			console.log(await readVersion([${JSON.stringify(omp)}, "--version"]));`,
		);
		expect(version).toBe("omp 9.9.9");
		expect(namesIn(dump)).toContain("PATH");
		expect(secretNamesIn(dump)).toEqual([]);
	});

	test("readVersion runs the child with a caller's env when one is given", async () => {
		const omp = join(home.dir, "env-omp");
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(omp, dump);
		const env = { PATH: process.env.PATH ?? "", PROBE_ONLY: "1" };
		expect(await readVersion([omp, "--version"], 2_000, env)).toBe("omp 9.9.9");
		expect(namesIn(dump)).toContain("PROBE_ONLY");
	});

	test("the doctor's omp line probes the configured omp without the bot's secret env", async () => {
		const dump = join(home.dir, "env.txt");
		envDumpingOmp(home.config.ompExecutable, dump);
		const line = await inBunWithSecrets(
			`import { runDoctor } from ${JSON.stringify(join(SRC, "daemon", "doctor"))};
			import { OFFLINE_DOCTOR } from ${JSON.stringify(join(import.meta.dir, "helpers", "doctor-network"))};
			const out = [];
			await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
			console.log(out.find((line) => line.includes(" omp: ")));`,
		);
		expect(line).toContain("omp 9.9.9");
		expect(secretNamesIn(dump)).toEqual([]);
		// Compare whole env values, not substrings: a secret value must never appear as an env value, but
		// an unrelated variable (e.g. GITHUB_HEAD_REF=...-fake-...) may legitimately contain it as a substring.
		const dumpedValues = readFileSync(dump, "utf8")
			.split("\n")
			.map((entry) => entry.slice(entry.indexOf("=") + 1));
		for (const value of Object.values(FAKE_SECRETS)) expect(dumpedValues).not.toContain(value);
	});
});

describe("qa50b I-18: the doctor's bun line", () => {
	test("shows the version of the bun found on PATH, not the running one's", async () => {
		const bin = join(home.dir, "fake-bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 0.0.1\n");
		chmodSync(join(bin, "bun"), 0o755);
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { runDoctor } from ${JSON.stringify(join(import.meta.dir, "..", "src", "daemon", "doctor"))};
				import { OFFLINE_DOCTOR } from ${JSON.stringify(join(import.meta.dir, "helpers", "doctor-network"))};
				const out = [];
				await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
				console.log(out.find((line) => / bun: /.test(line)));`,
			],
			{ env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" },
		);
		const line = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		expect(line).toContain(`${join(bin, "bun")} 0.0.1`);
		expect(line).toContain(`running ${Bun.version}`);
	}, 30_000); // spawns a bun child that runs every doctor probe: slow on a 2-core machine
});

describe("doctor: home", () => {
	test("a home that does not exist yet says to run init first", async () => {
		const out: string[] = [];
		const missing = join(home.dir, "no-such-home");
		await runDoctor(missing, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
		expect(out).toContain(`fail home: ${missing} missing (no home yet: run the \`init\` command first)`);
	});
});

describe("doctor: config warnings", () => {
	test("an unknown key is one warn line per warning and never changes the exit code", async () => {
		const clean: string[] = [];
		const before = await runDoctor(home.dir, (line) => clean.push(line), undefined, OFFLINE_DOCTOR);
		expect(clean.filter((line) => line.startsWith("warn config:"))).toEqual([]);
		const configPath = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		config.bogusKey = true;
		writeFileSync(configPath, JSON.stringify(config));
		const warned: string[] = [];
		const code = await runDoctor(home.dir, (line) => warned.push(line), undefined, OFFLINE_DOCTOR);
		expect(code).toBe(before);
		expect(warned).toContain("warn config: bogusKey (unknown_key)");
	});
});

describe("doctor: discord", () => {
	test("on: token mode, the bot user and the gateway each give one ok discord line; the token never shows", async () => {
		const config: JabbuConfig = home.config;
		const token = readFileSync(config.channels.discord?.botTokenFile ?? "", "utf8").trim();
		await checkDiscord(config, report, fakeFetch(healthy));
		expect(lines).toEqual([
			"ok discord token: mode=0600 expected=0600",
			"ok discord users/@me: bot_user_id=500000000000000000 username=jabbu",
			"ok discord gateway/bot: url=wss://gateway.discord.gg",
		]);
		expect(seen.map((s) => s.auth)).toEqual([`Bot ${token}`, `Bot ${token}`]);
		for (const line of lines) expect(line).not.toContain(token);
	});

	test("a refused token (401) is a fail discord line", async () => {
		const config = home.config;
		await checkDiscord(
			config,
			report,
			fakeFetch({
				"/users/@me": () => Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 }),
				"/gateway/bot": () => Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 }),
			}),
		);
		expect(lines[0]).toBe("ok discord token: mode=0600 expected=0600");
		expect(lines[1]?.startsWith("fail discord users/@me: ")).toBe(true);
		expect(lines[1]).toContain("401");
		expect(lines[2]?.startsWith("fail discord gateway/bot: ")).toBe(true);
	});

	test("a token file that is not 0600 fails and no request is made", async () => {
		const config = home.config;
		chmodSync(config.channels.discord?.botTokenFile ?? "", 0o644);
		await checkDiscord(config, report, fakeFetch(healthy));
		expect(lines).toEqual(["fail discord token: mode=0644 expected=0600"]);
		expect(seen).toHaveLength(0);
	});

	test("off: no discord line and no request", async () => {
		await checkDiscord({ ...home.config, channels: {} }, report, fakeFetch(healthy));
		expect(lines).toEqual([]);
		expect(seen).toHaveLength(0);
	});

	test("a missing token file names the path and what to put there", async () => {
		const discord = home.config.channels.discord;
		if (discord === undefined) throw new Error("fixture has no discord channel");
		const missing = join(home.dir, "secrets", "no-such-token");
		await checkDiscord(
			{ ...home.config, channels: { discord: { ...discord, botTokenFile: missing } } },
			report,
			fakeFetch(healthy),
		);
		expect(lines).toEqual([`fail discord token: missing: ${missing} (put the bot token there, mode 0600)`]);
		expect(seen).toHaveLength(0);
	});
});

describe("doctor: core dump limit", () => {
	const check = (): string[] => {
		lines = [];
		checkCoreDumpLimit(home.dir, (name, detail) => lines.push(`warn ${name}: ${detail}`));
		return lines;
	};

	test("a daemon unit without LimitCORE=0 warns, one with it and the other units say nothing", () => {
		expect(check()).toEqual([]);
		writeFileSync(join(home.dir, "jabbu-gc.service"), "[Service]\n");
		writeFileSync(join(home.dir, "jabbu-dashboard.service"), "[Service]\n");
		expect(check()).toEqual([]);
		writeFileSync(join(home.dir, "jabbu.service"), "[Service]\nTimeoutStopSec=90\n");
		expect(check()).toHaveLength(1);
		writeFileSync(join(home.dir, "jabbu.service"), "[Service]\nLimitCORE=0\n");
		expect(check()).toEqual([]);
	});

	test("qa-z #7 an instance name with a dash is checked like the plain unit", () => {
		writeFileSync(join(home.dir, "jabbu-my-bot.service"), "[Service]\nTimeoutStopSec=90\n");
		expect(check()).toEqual([
			"warn core dump limit: jabbu-my-bot.service has no LimitCORE=0 (run: jabbu-pocket units render, then reload and restart)",
		]);
		writeFileSync(join(home.dir, "jabbu-my-bot.service"), "[Service]\nLimitCORE=0\n");
		// the -backup/-gc/-dashboard suffix filter still applies to instance names
		writeFileSync(join(home.dir, "jabbu-x-gc.service"), "[Service]\n");
		expect(check()).toEqual([]);
	});

	test("qa-z #65 the last LimitCORE assignment across drop-ins decides, not the unit file's alone", () => {
		const dropinDir = join(home.dir, "jabbu.service.d");
		mkdirSync(dropinDir);
		writeFileSync(join(home.dir, "jabbu.service"), "[Service]\nLimitCORE=0\n");
		writeFileSync(join(dropinDir, "90-override.conf"), "[Service]\nLimitCORE=infinity\n");
		expect(check()).toHaveLength(1);
		writeFileSync(join(dropinDir, "90-override.conf"), "[Service]\nLimitCORE=0\n");
		expect(check()).toEqual([]);
		// systemd applies drop-ins after the unit file, in lexical order: the newest assignment wins
		rmSync(join(dropinDir, "90-override.conf"));
		writeFileSync(join(home.dir, "jabbu.service"), "[Service]\n");
		writeFileSync(join(dropinDir, "10-limit.conf"), "[Service]\nLimitCORE=infinity\n");
		expect(check()).toHaveLength(1);
		writeFileSync(join(dropinDir, "10-limit.conf"), "[Service]\nLimitCORE=0\n");
		writeFileSync(join(dropinDir, "20-limit.conf"), "[Service]\nLimitCORE=infinity\n");
		expect(check()).toHaveLength(1);
		writeFileSync(join(dropinDir, "20-limit.conf"), "[Service]\nLimitCORE=0\n");
		expect(check()).toEqual([]);
	});

	test("a drop-in without a LimitCORE line keeps the unit file's 0", () => {
		const dropinDir = join(home.dir, "jabbu.service.d");
		mkdirSync(dropinDir);
		writeFileSync(join(home.dir, "jabbu.service"), "[Service]\nLimitCORE=0\n");
		writeFileSync(join(dropinDir, "restart-always.conf"), "[Service]\nRestart=always\n");
		expect(check()).toEqual([]);
	});

	test("a jabbu-<x>.service whose ExecStart is not the daemon is not judged", () => {
		writeFileSync(join(home.dir, "jabbu-apply-batch.service"), "[Service]\nExecStart=/bin/bash /x/apply-batch.sh\n");
		expect(check()).toEqual([]);
		writeFileSync(
			join(home.dir, "jabbu-bot.service"),
			"[Service]\nExecStart=/usr/bin/bun --no-env-file /repo/src/main.ts daemon\n",
		);
		expect(check()).toEqual([
			"warn core dump limit: jabbu-bot.service has no LimitCORE=0 (run: jabbu-pocket units render, then reload and restart)",
		]);
	});

	test("qa-z #60 a FIFO in a daemon unit's place warns, never blocks", async () => {
		mkfifo(join(home.dir, "jabbu-f.service"));
		const child = [
			`const { checkCoreDumpLimit } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "daemon", "core-dump.ts"))});`,
			"const warns = [];",
			`checkCoreDumpLimit(${JSON.stringify(home.dir)}, (name, detail) => warns.push("warn " + name + ": " + detail));`,
			"console.log(JSON.stringify(warns));",
		].join("\n");
		const result = await runBounded(child);
		expect(result.timedOut).toBe(false);
		expect(JSON.parse(result.stdout.trim())).toEqual(["warn core dump limit: jabbu-f.service is not a regular file"]);
	}, 30_000);
});

describe("doctor: injected file caps", () => {
	const warn = (name: string, detail: string): void => {
		lines.push(`warn ${name}: ${detail}`);
	};
	const workspace = (): string => {
		const dir = join(home.dir, "workspace");
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	const check = (): string[] => {
		lines = [];
		checkInjectedFiles(home.dir, warn);
		return lines;
	};

	test("persona: 91% warns once, 73% and a missing file say nothing, over the cap warns of the cut", () => {
		expect(check()).toEqual([]);
		const persona = join(workspace(), "persona.md");
		writeFileSync(persona, "x".repeat(6000));
		expect(check()).toEqual([]);
		writeFileSync(persona, "x".repeat(7500));
		expect(check()).toEqual([
			"warn injected persona.md: 7500/8192 bytes (91%): near the cap, trim it before it is cut off",
		]);
		writeFileSync(persona, "x".repeat(9000));
		expect(check()).toEqual([
			"warn injected persona.md: 9000/8192 bytes (109%): over the cap, injected with its tail cut off",
		]);
	});

	test("qa-l #10: a persona.md that is a directory is reported as not a regular file, not as injected", () => {
		mkdirSync(join(workspace(), "persona.md"));
		expect(check()).toEqual(["warn injected persona.md: EISDIR: not a regular file"]);
	});

	test("owner.md and soul.md symlinks are judged by their target's size", () => {
		const target = join(home.dir, "notes");
		mkdirSync(target);
		writeFileSync(join(target, "owner.md"), "x".repeat(15_000));
		writeFileSync(join(target, "soul.md"), "x".repeat(7500));
		symlinkSync(join(target, "owner.md"), join(workspace(), "owner.md"));
		symlinkSync(join(target, "soul.md"), join(workspace(), "soul.md"));
		expect(check()).toEqual([
			"warn injected soul.md: 7500/8192 bytes (91%): near the cap, trim it before it is cut off",
			"warn injected owner.md: 15000/16384 bytes (91%): near the cap, trim it before it is cut off",
		]);
	});
});

describe("doctor: omp judge role", () => {
	/** A stand-in omp that answers `config list --json` with the given script body. */
	function fakeConfigOmp(body: string): string {
		const path = join(home.dir, "fake-omp-judge");
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	test("a set judge role reads back as the model omp resolves", async () => {
		const omp = fakeConfigOmp(`echo '{"modelRoles":{"value":{"judge":"judge-test/fake-decision-model"}}}'`);
		expect(await readJudgeRole(omp, "/h/overlay.yml")).toEqual({ model: "judge-test/fake-decision-model" });
	});

	test("an empty, blank or absent judge role is missing; a role list without modelRoles too", async () => {
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{"judge":""}}}'`), "/h/o.yml")).toEqual({
			missing: true,
		});
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{"judge":"   "}}}'`), "/h/o.yml")).toEqual({
			missing: true,
		});
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{}}}'`), "/h/o.yml")).toEqual({
			missing: true,
		});
		expect(await readJudgeRole(fakeConfigOmp(`echo '{}'`), "/h/o.yml")).toEqual({ missing: true });
	});

	test("a config list that does not come back is 확인 불가, never a missing role", async () => {
		expect(await readJudgeRole(fakeConfigOmp("exit 4"), "/h/o.yml")).toEqual({
			unreadable: "omp config list exited 4",
		});
		expect(await readJudgeRole(fakeConfigOmp("echo not-json"), "/h/o.yml")).toEqual({
			unreadable: "unparsable output",
		});
		expect(await readJudgeRole(fakeConfigOmp("exec sleep 5"), "/h/o.yml", 200)).toEqual({
			unreadable: "timeout after 0.2s",
		});
	});

	test("an install without an overlay cannot tell the bot's judge from omp's global one", async () => {
		const omp = fakeConfigOmp(`echo '{"modelRoles":{"value":{"judge":"x/y"}}}'`);
		expect(await readJudgeRole(omp, undefined)).toEqual({ unreadable: "no ompConfigOverlay for this install" });
	});

	test("qa-z #9 a missing probe answer is checked against the overlay file itself", async () => {
		writeOverlay(`modelRoles:\n  judge: judge-test/fake-decision-model\n`);
		const overlay = join(home.dir, "overlay.yml");
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{}}}'`), overlay)).toEqual({
			model: "judge-test/fake-decision-model",
		});
		// no judge in the overlay: the probe's missing stands
		writeOverlay(`memory:\n  backend: "off"\n`);
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{}}}'`), overlay)).toEqual({
			missing: true,
		});
		// an overlay that cannot be read adds nothing
		expect(await readJudgeRole(fakeConfigOmp(`echo '{"modelRoles":{"value":{}}}'`), home.dir)).toEqual({
			missing: true,
		});
	});
});

describe("doctor: omp judge line", () => {
	const SRC = join(import.meta.dir, "..", "src");
	/** A stand-in omp for both probes: `--version`, `models --json` and `config list --json`. */
	function probedOmp(judgeJson: string): void {
		const path = home.config.ompExecutable;
		writeFileSync(
			path,
			`#!/bin/sh
case "$1" in
--version) echo 'omp 9.9.9' ;;
models) echo '{"models":[{"id":"a"}]}' ;;
*) echo '${judgeJson}' ;;
esac
`,
		);
		chmodSync(path, 0o755);
	}

	async function judgeLine(): Promise<string | undefined> {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { runDoctor } from ${JSON.stringify(join(SRC, "daemon", "doctor"))};
				import { OFFLINE_DOCTOR } from ${JSON.stringify(join(import.meta.dir, "helpers", "doctor-network"))};
				const out = [];
				await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
				console.log(JSON.stringify(out.filter((line) => line.includes(" omp judge: "))));`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		const out = JSON.parse((await new Response(proc.stdout).text()).trim() || "[]") as string[];
		await proc.exited;
		return out[0];
	}

	test("a set role is an ok line, also when the probe does not merge the overlay (qa-z #9)", async () => {
		writeOverlay(`modelRoles:\n  judge: judge-test/fake-decision-model\n`);
		probedOmp('{"modelRoles":{"value":{"judge":"judge-test/fake-decision-model"}}}');
		expect(await judgeLine()).toBe("ok omp judge: judge-test/fake-decision-model");

		// omp 19.1.0 answers `config list --json` without merging the overlay (modelRoles.value {}): the file's role
		// is the effective one for the bot's children, so it reads back as ok, not as a warning naming that overlay.
		probedOmp('{"modelRoles":{"value":{}}}');
		expect(await judgeLine()).toBe("ok omp judge: judge-test/fake-decision-model");
	}, 60_000);

	test("an empty role with no judge in the overlay is a warn that names the omp menu", async () => {
		writeOverlay(`memory:\n  backend: "off"\n`);
		probedOmp('{"modelRoles":{"value":{}}}');
		const warned = await judgeLine();
		expect(warned).toStartWith("warn omp judge: modelRoles.judge is empty");
		expect(warned).toContain("/models → Roles → Judge");
	}, 60_000);

	test("an install without an overlay says 확인 불가, not a missing role", async () => {
		writeOverlay(undefined);
		probedOmp('{"modelRoles":{"value":{"judge":"x/y"}}}');
		expect(await judgeLine()).toBe("warn omp judge: 확인 불가 (no ompConfigOverlay for this install)");
	}, 60_000);
});

describe("doctor: omp model line", () => {
	const SRC = join(import.meta.dir, "..", "src");
	/** A stand-in omp for the probes: `--version`, `models --json` and `config list --json`. */
	function probedOmp(): void {
		const path = home.config.ompExecutable;
		writeFileSync(
			path,
			`#!/bin/sh
case "$1" in
--version) echo 'omp 9.9.9' ;;
models) echo '{"models":[{"provider":"anthropic","id":"claude-x"},{"id":"local-y"}]}' ;;
*) echo '{"modelRoles":{"value":{}}}' ;;
esac
`,
		);
		chmodSync(path, 0o755);
	}

	/** Writes (or removes, with `undefined`) `model` in the test home's config.json. */
	function writeModel(model: string | undefined): void {
		const configPath = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		if (model === undefined) delete config.model;
		else config.model = model;
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	}

	async function modelLine(): Promise<string | undefined> {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { runDoctor } from ${JSON.stringify(join(SRC, "daemon", "doctor"))};
				import { OFFLINE_DOCTOR } from ${JSON.stringify(join(import.meta.dir, "helpers", "doctor-network"))};
				const out = [];
				await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
				console.log(JSON.stringify(out.filter((line) => line.includes(" omp model: "))));`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		const out = JSON.parse((await new Response(proc.stdout).text()).trim() || "[]") as string[];
		await proc.exited;
		return out[0];
	}

	test("a configured model among the listed ones is an ok line", async () => {
		writeModel("anthropic/claude-x");
		probedOmp();
		expect(await modelLine()).toBe("ok omp model: anthropic/claude-x");
		writeModel("local-y");
		expect(await modelLine()).toBe("ok omp model: local-y");
	}, 60_000);

	test("a configured model omp does not list is a fail line naming the model", async () => {
		writeModel("anthropic/claude-typo");
		probedOmp();
		expect(await modelLine()).toBe(
			'fail omp model: anthropic/claude-typo is not among the 2 models omp lists (check "model" in ' +
				`${home.dir}/config.json)`,
		);
	}, 60_000);

	test("no configured model is no line", async () => {
		writeModel(undefined);
		probedOmp();
		expect(await modelLine()).toBeUndefined();
	}, 60_000);
});

describe("doctor: code rollback journal", () => {
	test("qa-z #62 a host without git skips the journal check instead of dying", () => {
		// The child gets a PATH that holds no git. Mutating process.env.PATH in this process would not reach the
		// child (bun spawns with the startup env), and an empty PATH makes bun fall back to its default search,
		// so the directory must exist and hold no git.
		const noGitBin = join(home.dir, "bin");
		mkdirSync(noGitBin);
		const run = Bun.spawnSync([
			"env",
			`PATH=${noGitBin}`,
			process.execPath,
			"-e",
			[
				`const { checkCodeRollbackJournal } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "daemon", "doctor.ts"))});`,
				`console.log("git=" + Bun.which("git"));`,
				`try {`,
				`	checkCodeRollbackJournal(${JSON.stringify(home.dir)}, (name, detail) => console.log("warn " + name + ": " + detail));`,
				`	console.log("quiet");`,
				`} catch (error) {`,
				`	console.log("threw " + (error.code ?? error.message));`,
				`}`,
			].join("\n"),
		]);
		const out = run.stdout.toString();
		expect(out).toContain("git=null");
		expect(out).toContain("quiet");
		expect(out).not.toContain("threw");
	});
});

describe("doctor: config repos", () => {
	const repos: string[] = [];
	afterEach(() => {
		for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("a readable git repo is ok, a missing path fails naming the key", () => {
		const repo = makeRepo(repos);
		const fake = join(home.dir, "no-such-repo");
		const config = {
			...home.config,
			taskAutoLand: { repos: [repo, fake] },
			lanes: { land: { [fake]: { mode: "pr" as const } } },
		};
		checkConfigRepos(config, report, (name, detail) => lines.push(`warn ${name}: ${detail}`));
		expect(lines).toContain(`ok config repo: ${repo}`);
		expect(lines).toContain(`fail config repo: ${fake} is not a readable git repository (check taskAutoLand.repos)`);
		// the fake path is named once: the lanes.land entry for it is the same repo
		expect(lines.filter((line) => line.includes(" config repo: "))).toHaveLength(2);
	});

	test("a lanes.land key on its own is checked, and no repos is no line", () => {
		const repo = makeRepo(repos);
		const config = { ...home.config, lanes: { land: { [repo]: { mode: "ff" as const } } } };
		checkConfigRepos(config, report, (name, detail) => lines.push(`warn ${name}: ${detail}`));
		expect(lines).toContain(`ok config repo: ${repo}`);
		checkConfigRepos(home.config, report, (name, detail) => lines.push(`warn ${name}: ${detail}`));
		expect(lines.filter((line) => line.includes(" config repo: "))).toHaveLength(1);
	});

	test("a repo without a commit is not readable", () => {
		const empty = join(home.dir, "empty-repo");
		mkdirSync(empty);
		Bun.spawnSync(["git", "init", "-q", "-b", "main", empty]);
		const config = { ...home.config, taskAutoLand: { repos: [empty] } };
		checkConfigRepos(config, report, (name, detail) => lines.push(`warn ${name}: ${detail}`));
		expect(lines).toContain(`fail config repo: ${empty} is not a readable git repository (check taskAutoLand.repos)`);
	});
});

describe("doctor: config repos in a full run", () => {
	const SRC = join(import.meta.dir, "..", "src");
	const repos: string[] = [];
	afterEach(() => {
		for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeTaskAutoLand(paths: string[]): void {
		const configPath = join(home.dir, "config.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		config.taskAutoLand = { repos: paths };
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	}

	async function repoLines(): Promise<string[]> {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { runDoctor } from ${JSON.stringify(join(SRC, "daemon", "doctor"))};
				import { OFFLINE_DOCTOR } from ${JSON.stringify(join(import.meta.dir, "helpers", "doctor-network"))};
				const out = [];
				await runDoctor(${JSON.stringify(home.dir)}, (line) => out.push(line), undefined, OFFLINE_DOCTOR);
				console.log(JSON.stringify(out.filter((line) => line.includes(" config repo: "))));`,
			],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		const out = JSON.parse((await new Response(proc.stdout).text()).trim() || "[]") as string[];
		await proc.exited;
		return out;
	}

	test("a real repo is ok and a typo'd one fails in the full report", async () => {
		const repo = makeRepo(repos);
		const fake = join(home.dir, "no-such-repo");
		writeTaskAutoLand([repo, fake]);
		expect(await repoLines()).toEqual([
			`ok config repo: ${repo}`,
			`fail config repo: ${fake} is not a readable git repository (check taskAutoLand.repos)`,
		]);
	}, 60_000);
});
