import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDispatchTool, type DispatchToolDeps } from "../src/dispatch/tool";
import { redact } from "../src/redact";
import { scanHandoffBrief } from "../src/safety/handoff-risk";
import { floorsSystemPrompt } from "../src/safety/prompt";
import { parseProgress } from "../src/tasks/docs";

// QA qa-z safety fixes. Numbers are the plan's triage numbers.

const roots: string[] = [];
function tempDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}
afterAll(() => {
	for (const root of roots) {
		// An unlistable fixture directory must be openable again before it can be removed.
		try {
			chmodSync(join(root, "secrets"), 0o755);
		} catch {
			// not every root has one
		}
		rmSync(root, { recursive: true, force: true });
	}
});

const rulesOf = (brief: string) => scanHandoffBrief(brief).findings.map((finding) => finding.rule);
const SIXTY_FOUR_KB = 65536;
/** The ceiling the plan sets for a fixed worst-case 64 KB input. */
const WORST_CASE_MS = 50;

function timed(run: () => unknown): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

describe("#40 handoff scan stays linear on blanks", () => {
	test("64 KB of one blank run, tabs, or `- ` marks scans in under 50 ms", () => {
		for (const brief of [
			`${" ".repeat(SIXTY_FOUR_KB)}x`,
			`${"\t".repeat(SIXTY_FOUR_KB)}x`,
			`${"- ".repeat(SIXTY_FOUR_KB / 2)}x`,
			`${" ".repeat(SIXTY_FOUR_KB)}\`rule\`: x`,
		]) {
			expect(timed(() => scanHandoffBrief(brief))).toBeLessThan(WORST_CASE_MS);
		}
	});

	test("a rule definition line is still recognised: its label is blanked, not read as a command", () => {
		expect(rulesOf("- `cd`: cd /tmp 으로 옮겨서 git reset --hard")).toContain("git_reset_hard");
	});
});

describe("#41 a `#` glued to a word is a shell comment", () => {
	test("`git reset --hard #never` and `#금지` stay high_risk like `# never`", () => {
		for (const brief of ["git reset --hard #never", "git reset --hard #금지", "git reset --hard # never"]) {
			expect(scanHandoffBrief(brief).verdict).toBe("high_risk");
		}
	});

	test("an issue number `#97` does not end the clause, so a marker after it still forbids", () => {
		expect(scanHandoffBrief("git reset --hard 는 #97 에서 never 하라").verdict).not.toBe("high_risk");
	});
});

describe("#42 commands behind `{`, `!`, `time`, `nice`, `command`, `xargs`, `if`", () => {
	test("each wrapper still reports a service_control", () => {
		for (const brief of [
			"{ sudo reboot; }",
			"! sudo reboot",
			"command sudo reboot",
			"time sudo reboot",
			"nice -n 5 sudo reboot",
			"xargs -r sudo reboot",
			"if true; then sudo reboot; fi",
			"while true; do sudo reboot; done",
			"sudo reboot",
		]) {
			expect(rulesOf(brief)).toContain("service_control");
		}
	});

	test("prose that only mentions the word stays clear", () => {
		expect(rulesOf("the time to reboot the plan comes later")).toEqual([]);
	});
});

describe("persona injection (#43/#94 NUL, #44/#95 unlistable secrets, #96 symlink in secrets)", () => {
	const DM = "discord/dm/200000000000000001";

	test("#43 a NUL byte in soul.md is dropped from the prompt and the file is reported", () => {
		const dir = tempDir("ompbot-qaz-nul-");
		const soul = join(dir, "soul.md");
		writeFileSync(soul, "S\0O\0U\0L-BODY");
		const errors: { code: string | undefined; path: string }[] = [];
		const prompt = floorsSystemPrompt(join(dir, "secrets"), DM, { soul }, (error, path) =>
			errors.push({ code: (error as NodeJS.ErrnoException).code, path }),
		);
		expect(prompt).toContain("SOUL-BODY");
		expect(prompt.includes("\0")).toBe(false);
		expect(errors).toEqual([{ code: "ENUL", path: soul }]);
	});

	function guarded(dir: string, soul: string) {
		const secretsDir = join(dir, "secrets");
		const errors: (string | undefined)[] = [];
		const prompt = floorsSystemPrompt(
			secretsDir,
			DM,
			{ soul, secrets: { secretsDir, configFile: join(dir, "config.json") } },
			(error) => errors.push((error as NodeJS.ErrnoException).code),
		);
		return { prompt, errors };
	}

	test("#44 a secrets directory that cannot be listed refuses the injected file instead of passing it", () => {
		const dir = tempDir("ompbot-qaz-unlist-");
		const secretsDir = join(dir, "secrets");
		mkdirSync(secretsDir);
		const token = join(secretsDir, "bot-token");
		writeFileSync(token, "TEST-TOKEN-UNLISTABLE");
		const soul = join(dir, "soul.md");
		linkSync(token, soul);
		chmodSync(secretsDir, 0o111);
		const { prompt, errors } = guarded(dir, soul);
		chmodSync(secretsDir, 0o755);
		expect(prompt).not.toContain("UNLISTABLE");
		expect(errors).toHaveLength(1);
	});

	test("#44 a missing secrets directory is not an error: a plain soul.md is injected", () => {
		const dir = tempDir("ompbot-qaz-nosecrets-");
		const soul = join(dir, "soul.md");
		writeFileSync(soul, "PLAIN-SOUL");
		const { prompt, errors } = guarded(dir, soul);
		expect(prompt).toContain("PLAIN-SOUL");
		expect(errors).toEqual([]);
	});

	test("#96 a secrets/ symlink to a token kept outside secrets protects that token's inode", () => {
		const dir = tempDir("ompbot-qaz-symlink-");
		const secretsDir = join(dir, "secrets");
		mkdirSync(secretsDir);
		const real = join(dir, "real-token");
		writeFileSync(real, "TEST-TOKEN-VIALINK");
		symlinkSync(real, join(secretsDir, "bot-token"));
		const soul = join(dir, "soul.md");
		linkSync(real, soul);
		const { prompt, errors } = guarded(dir, soul);
		expect(prompt).not.toContain("VIALINK");
		expect(errors).toEqual(["ESECRET"]);
	});

	test("#96 a dangling symlink in secrets/ neither throws nor blocks a plain soul.md", () => {
		const dir = tempDir("ompbot-qaz-dangling-");
		const secretsDir = join(dir, "secrets");
		mkdirSync(secretsDir);
		symlinkSync(join(dir, "gone"), join(secretsDir, "dangling"));
		const soul = join(dir, "soul.md");
		writeFileSync(soul, "PLAIN-SOUL");
		const { prompt, errors } = guarded(dir, soul);
		expect(prompt).toContain("PLAIN-SOUL");
		expect(errors).toEqual([]);
	});
});

describe("dispatch tool (#45 repo, #46 name, #97 symlink tail, #98 remote TASKID)", () => {
	const signal = new AbortController().signal;
	const home = tempDir("ompbot-qaz-home-");
	mkdirSync(join(home, "secrets"), { recursive: true });
	mkdirSync(join(home, "work"), { recursive: true });
	symlinkSync(join(home, "secrets"), join(home, "work", "link"));

	function tool(agents: string[] = []) {
		const calls: string[] = [];
		const built = buildDispatchTool({
			originKey: "discord/dm/200000000000000001",
			ompExecutable: "omp",
			homeDir: home,
			workspaceDir: join(home, "workspace"),
			herdr: {},
			dispatchHosts: () => ({ wsl: { ssh: "wsl" } }),
			tasks: {} as NonNullable<DispatchToolDeps["tasks"]>,
			log: { info() {}, warn() {} },
			run: async (cmd) => {
				const line = cmd.join(" ");
				calls.push(line);
				const stdout = /\blist\b/.test(line)
					? JSON.stringify({ result: { agents: agents.map((name) => ({ name })) } })
					: "{}";
				return { code: 0, stdout, timedOut: false };
			},
		});
		return { built, calls };
	}

	test("#97 a cwd below a symlink to secrets that does not exist yet is refused before any process", async () => {
		for (const cwd of [join(home, "work", "link", "newsub"), join(home, "work", "link", "a", "b")]) {
			const { built, calls } = tool();
			await expect(built.execute({ mode: "herdr", name: "x", task: "t", cwd }, { signal })).rejects.toThrow(
				"비밀 디렉터리",
			);
			expect(calls).toEqual([]);
		}
	});

	test("#97 a not-yet-existing cwd beside the links still starts", async () => {
		const { built, calls } = tool();
		await built.execute({ mode: "herdr", name: "x", task: "t", cwd: join(home, "work", "new") }, { signal });
		expect(calls.length).toBeGreaterThan(0);
	});

	test("#45 a taskSpec.repo inside secrets (directly, below it, or through a symlink) is refused before any process", async () => {
		for (const repo of [join(home, "secrets"), join(home, "secrets", "repo"), join(home, "work", "link", "repo")]) {
			const { built, calls } = tool();
			const taskSpec = {
				title: "t",
				risk: "L1",
				goal: "g",
				scope: ["a"],
				exclusions: ["b"],
				acceptance: ["c"],
				repo,
			};
			await expect(built.execute({ taskSpec, task: "구현" }, { signal })).rejects.toThrow("비밀 디렉터리");
			expect(calls).toEqual([]);
		}
	});

	test("#46 a malformed name is refused for a local read and a local follow-up, not only a new start", async () => {
		for (const task of [undefined, "다음 단계"]) {
			const { built, calls } = tool(["Bad Name"]);
			await expect(built.execute({ mode: "herdr", name: "Bad Name", task }, { signal })).rejects.toThrow(
				"name은 소문자",
			);
			expect(calls).toEqual([]);
		}
	});

	test("#98 a remote new start with a TASKID-shaped name is refused before herdr starts anything", async () => {
		const { built, calls } = tool([]);
		await expect(built.execute({ host: "wsl", name: "t-20261112-01", task: "시작" }, { signal })).rejects.toThrow(
			"TASKID",
		);
		expect(calls.some((line) => /\bstart\b/.test(line))).toBe(false);
	});

	test("#98 a follow-up to a running remote agent with a TASKID-shaped name stays allowed", async () => {
		const { built } = tool(["t-20261112-01"]);
		const text = String(await built.execute({ host: "wsl", name: "t-20261112-01", task: "다음 단계" }, { signal }));
		expect(text).toContain("후속 지시를 wsl/t-20261112-01에 전달했습니다");
	});
});

describe("#107 PROGRESS step tokens are masked at parse", () => {
	test("a token in a step's text, condition and evidence never reaches `steps`", () => {
		const token = `xoxb-${"Zq9W".repeat(6)}`;
		const progress = parseProgress(
			[
				"---",
				"task: T-1",
				"status: working",
				"---",
				"# 단계",
				`- [x] S1: 토큰 ${token} 적용 | 완료 조건: ${token} 확인 | 증거: test ${token} → pass`,
			].join("\n"),
		);
		expect(progress.steps).toHaveLength(1);
		expect(JSON.stringify(progress.steps)).not.toContain("Zq9W");
	});
});

describe("#110 PEM masking stays linear", () => {
	const BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
	const END = ["-----END", "PRIVATE", "KEY-----"].join(" ");

	test("repeated BEGIN lines with no END redact 64 KB in under 50 ms through `redact`", () => {
		const text = `${BEGIN}\n`.repeat(Math.floor(SIXTY_FOUR_KB / (BEGIN.length + 1)));
		expect(timed(() => redact(text))).toBeLessThan(WORST_CASE_MS);
	});

	test("a closed key after unclosed BEGIN lines is still masked whole", () => {
		const masked = redact(`${BEGIN}\n${BEGIN}\nAAAA\nBBBB\n${END}\nafter`);
		expect(masked).not.toContain("AAAA");
		expect(masked).not.toContain("BBBB");
		expect(masked).toContain("after");
	});
});
