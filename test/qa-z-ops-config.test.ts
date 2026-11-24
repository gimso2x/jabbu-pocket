import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index";
import { joinLines, stripExtensionPath } from "../src/cli/linear-text";
import { ConfigError, loadConfig } from "../src/config";
import { acquireLock, LockHeldError } from "../src/daemon/lock";
import { takeRestartMarker, writeRestartMarker } from "../src/daemon/restart-notice";
import { turnCapWarnText, usd } from "../src/ops/cost-cap";
import { freezePath, readFreeze, writeFreeze } from "../src/ops/freeze";
import { collectGates, GATE_NAMES } from "../src/ops/gates";
import { makeRepo } from "./helpers/git-fixtures";

// qa-z ops/config fixes: config validation items.

let home: string;
const repoDirs: string[] = [];

function writeConfig(extra: Record<string, unknown>): void {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			channels: {
				discord: {
					ownerUserId: "100000000000000001",
					botTokenFile: "secrets/bot.token",
					applicationId: "600000000000000000",
				},
			},
			ompExecutable: "/usr/local/bin/omp",
			workspaceDir: "workspace",
			...extra,
		}),
	);
}

function invalidField(): string {
	try {
		loadConfig(home);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	throw new Error("expected ConfigError");
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-qa-z-cfg-"));
	chmodSync(home, 0o700);
	mkdirSync(join(home, "secrets"), { mode: 0o700 });
	writeFileSync(join(home, "secrets", "bot.token"), "TEST-discord-0\n");
	chmodSync(join(home, "secrets", "bot.token"), 0o600);
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	for (const dir of repoDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("qa-z #1: control characters in string settings", () => {
	test("NUL in model, thinking, workspaceDir or a lane model is config_invalid", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ model: "a\0b" }, "field=model"],
			[{ thinking: "high\0" }, "field=thinking"],
			[{ workspaceDir: "work\0space" }, "field=workspaceDir"],
			[{ lanes: { models: { fast: "p/m\0" } } }, "field=lanes.models.fast"],
		];
		for (const [extra, field] of cases) {
			writeConfig(extra);
			expect(invalidField()).toContain(field);
		}
	});
});

describe("qa-z #2/#17: wikiNotes paths", () => {
	test("relative, blank and non-repository paths are config_invalid", () => {
		const repo = makeRepo(repoDirs);
		const cases: [Record<string, unknown>, string][] = [
			[{ client: "rel/dir" }, "field=wikiNotes.client"],
			[{ client: "   " }, "field=wikiNotes.client"],
			[{ client: "/c", agentDir: "rel" }, "field=wikiNotes.agentDir"],
			[{ client: "/c", repos: ["rel/repo"] }, "field=wikiNotes.repos"],
			[{ client: "/c", repos: [repo, join(tmpdir(), "no-such-repo-qa-z")] }, "field=wikiNotes.repos"],
		];
		for (const [wikiNotes, field] of cases) {
			writeConfig({ wikiNotes });
			expect(invalidField()).toContain(field);
		}
		writeConfig({ wikiNotes: { client: "/c", repos: [repo] } });
		expect(loadConfig(home).wikiNotes?.repos).toEqual([repo]);
	});
});

describe("qa-z #3: workerAgy unknown keys", () => {
	test("an unknown workerAgy key is config_invalid", () => {
		writeConfig({ workerAgy: { model: "gemini-3", modle: "x" } });
		expect(invalidField()).toContain("field=workerAgy.modle");
		writeConfig({ workerAgy: { model: "gemini-3" } });
		expect(loadConfig(home).workerAgy).toEqual({ model: "gemini-3" });
	});
});

describe("qa-z #22: sub-cent cost amounts", () => {
	test("a cap under one cent is not shown as the cent it rounds to", () => {
		expect(usd(0.005)).toBe("$0.005");
		expect(usd(0)).toBe("$0.00");
		expect(usd(12.345)).toBe("$12.35");
		const text = turnCapWarnText(0.005, 0.006);
		expect(text).toContain("$0.006");
		expect(text).toContain("$0.005");
		expect(text).not.toContain("$0.01이 턴 상한");
	});
});

describe("qa-z #13: FROZEN since is one line", () => {
	test("a hand-edited since with newlines never reaches the gate detail", () => {
		writeFileSync(freezePath(home), JSON.stringify({ since: "2027-01-01\ngates_done open=0", reason: "r", by: "cli" }));
		expect(readFreeze(home)?.since).not.toMatch(/[\n\r]/);
		const frozen = collectGates({ homeDir: home, now: Date.now() }).find((g) => g.name === "frozen");
		expect(frozen?.state).toBe("open");
		expect(frozen?.detail).not.toMatch(/[\n\r]/);
	});
});

describe("qa-z #14: gate lists name every gate", () => {
	test("--help and the guide table list each GATE_NAMES entry; the README count matches", async () => {
		let help = "";
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			help += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			await runCli(["--help"], {});
		} finally {
			process.stderr.write = realWrite;
		}
		const guide = readFileSync(join(import.meta.dir, "..", "docs", "guide.md"), "utf8");
		const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
		for (const name of GATE_NAMES) {
			expect(help).toContain(name);
			expect(guide).toContain(`| \`${name}\` |`);
		}
		expect(readme).toContain(`${GATE_NAMES.length}개 건강 게이트`);
	});
});

describe("qa-z #52/#54: lock staging and link handling", () => {
	test("a symlink planted at the staging name is replaced, not written through", () => {
		const target = join(home, "victim.txt");
		writeFileSync(target, "keep me");
		const lockPath = join(home, "jabbu.lock");
		symlinkSync(target, `${lockPath}.${process.pid}.tmp`);
		const lock = acquireLock(lockPath);
		expect(readFileSync(target, "utf8")).toBe("keep me");
		expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
		lock.release();
	});

	test("a dangling symlink at the lock path is a LockHeldError naming the fix", () => {
		const lockPath = join(home, "jabbu.lock");
		symlinkSync(join(home, "nowhere"), lockPath);
		expect(() => acquireLock(lockPath)).toThrow(LockHeldError);
		expect(() => acquireLock(lockPath)).toThrow(/not a regular file/);
		expect(readlinkSync(lockPath)).toBe(join(home, "nowhere"));
	});
});

describe("qa-z #53: restart marker and symlinks", () => {
	test("write replaces a symlink instead of overwriting its target; take leaves a link alone", () => {
		const target = join(home, "owner-file.txt");
		writeFileSync(target, "owner data");
		const marker = join(home, "restart-notice.json");
		symlinkSync(target, marker);
		const dropped: string[] = [];
		expect(takeRestartMarker(home, (reason) => dropped.push(reason))).toBeUndefined();
		expect(dropped).toEqual(["symlink"]);
		expect(lstatSync(marker).isSymbolicLink()).toBe(true);
		writeRestartMarker(home, { at: 1, threads: ["t"] });
		expect(readFileSync(target, "utf8")).toBe("owner data");
		expect(lstatSync(marker).isFile()).toBe(true);
		expect(takeRestartMarker(home)).toEqual({ at: 1, threads: ["t"] });
	});
});

describe("qa-z #57/#66: freeze command and its tmp file", () => {
	test("a home that is a regular file gets a one-line message, not a raw ENOTDIR", async () => {
		const file = join(home, "not-a-home");
		writeFileSync(file, "x");
		let err = "";
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			err += chunk;
			return true;
		}) as typeof process.stderr.write;
		let code: number;
		try {
			code = await runCli(["freeze"], { JABBU_HOME: file });
		} finally {
			process.stderr.write = realWrite;
		}
		expect(code).toBe(1);
		expect(err).toContain("(not a directory)");
		expect(err).not.toContain("ENOTDIR");
	});

	test("a hard link at FROZEN.tmp keeps its other name's content", () => {
		const victim = join(home, "victim.txt");
		writeFileSync(victim, "keep me");
		linkSync(victim, `${freezePath(home)}.tmp`);
		writeFreeze(home, { reason: "r", by: "cli", now: 1 });
		expect(readFileSync(victim, "utf8")).toBe("keep me");
		expect(readFreeze(home)?.reason).toBe("r");
	});
});

describe("qa-z #63: line helpers are linear", () => {
	test("joinLines collapses newlines and handles 64KB of spaces within 50ms", () => {
		expect(joinLines("a\n  b  \nc")).toBe("a b c");
		const started = performance.now();
		joinLines(`a${" ".repeat(64_000)}b`);
		expect(performance.now() - started).toBeLessThan(50);
	});

	test("64KB of spaces before a non-space tail strips within 50ms; the path group still goes", () => {
		const hostile = `omp: current${" ".repeat(64_000)}x`;
		const started = performance.now();
		expect(stripExtensionPath(hostile)).toBe(hostile);
		expect(performance.now() - started).toBeLessThan(50);
		expect(stripExtensionPath("omp: current (/home/x/ext.ts)")).toBe("omp: current");
		expect(stripExtensionPath("omp: current (~/ext)  ")).toBe("omp: current");
		expect(stripExtensionPath("omp: stale (note)")).toBe("omp: stale (note)");
		expect(stripExtensionPath("a (/x) y)")).toBe("a (/x) y)");
	});
});
