import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchAudit } from "../src/dispatch/audit";
import { herdrSshArgv, type ProcessRunner, type RunProcessResult } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import { classifyLaneCompletion } from "../src/lanes/integrity";
import type { GitRunner } from "../src/lanes/verify";
import { openMonitorLedger } from "../src/monitors/ledger";
import { exportMonitors } from "../src/monitors/portable";
import { parseMonitorSpec } from "../src/monitors/spec";
import { questionOf } from "../src/omp/session-tail";
import { type CommitCheck, checkTask, type TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems, parseOutcome, renderSpec } from "../src/tasks/docs";
import { createTaskHostOps } from "../src/tasks/host";
import { gitPatchIds, landTask, type TaskLandDeps } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import { buildAgentQuestionCard, buildReachedCard, formatReadFailureNotice, unmetLines } from "../src/tasks/notify";
import { assertCheckPlacement, parseChecks, parseSignal } from "../src/tasks/signals";
import { oneLine } from "../src/wiki/notes";

// QA qa-t·u·v secret leaks: masking must see the whole text before any cut or
// line split. Every token's body is made of BODY, so a result holding any part of a token holds BODY.

const BODY = "Zq9W";
const SK = `sk-${BODY.repeat(20)}`;
const JWT = `eyJ${BODY.repeat(4)}.eyJ${BODY.repeat(4)}.${BODY.repeat(8)}`;
/** A 13-line PEM private key (fake body); the marker words are joined at run time so the source holds no key shape. */
const PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
const PEM = [
	`-----BEGIN ${PEM_LABEL}-----`,
	...Array.from({ length: 11 }, (_, i) => `${BODY.repeat(16)}${i}`),
	`-----END ${PEM_LABEL}-----`,
].join("\n");

/** Filler: not hex, so it never reads as a commit hash. */
const FILL = "z";
/** `lead`, filler, then `token`: `slice(0, cut)` of it ends `keep` characters into the token. */
const straddle = (cut: number, token: string, lead = "", keep = 20): string =>
	`${lead}${FILL.repeat(cut - keep - 1 - lead.length)} ${token} 끝`;

const expectMasked = (text: string): void => {
	expect(text).not.toContain(BODY);
	expect(text).not.toContain("PRIVATE KEY");
};

const OWNER = "200000000000000001";
const row = (over: Partial<TaskRow> = {}): TaskRow => ({
	taskId: "T-20261120-01",
	title: "비밀 노출",
	risk: "L2",
	originKey: "discord/dm/200000000000000001",
	threadRef: "t",
	host: null,
	repo: "/w/repo",
	worktree: "/w/repo-T-20261120-01",
	baseSha: "a".repeat(40),
	docsDir: "/w/repo-T-20261120-01/docs/tasks/T-20261120-01",
	branch: "task/T-20261120-01",
	agent: "t-20261120-01",
	status: "review",
	acceptance: [],
	createdAt: 0,
	updatedAt: 0,
	progressAt: null,
	remindedAt: null,
	notices: {},
	closedAt: null,
	workerModel: null,
	tier: null,
	tierReason: null,
	tierConfidence: null,
	gate: null,
	checks: null,
	land: null,
	...over,
});

const roots: string[] = [];
const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("결함 1: outcome 요약의 여러 줄 비밀", () => {
	const outcome = `# outcome\n\n## 요약\n- 작업을 끝냈습니다\n${PEM}\n- ${straddle(200, JWT)}\n\n## AC-1\n- test: bun test\n`;

	test("parseOutcome masks a multi-line PEM key and a token across the 200-char clip", () => {
		const { summary } = parseOutcome(outcome);
		expect(summary[0]).toBe("작업을 끝냈습니다");
		for (const line of summary) expectMasked(line);
	});

	test("the reached card's summary bullets carry no key line", () => {
		const judgement = { summary: parseOutcome(outcome).summary, problems: [], integrityWarnings: [], checks: [] };
		const card = buildReachedCard(row(), judgement as Partial<TaskJudgement> as TaskJudgement, OWNER);
		expectMasked(card.text);
		expectMasked(card.body ?? "");
	});
});

describe("결함 2: 카드 끝부분·질문의 여러 줄 비밀", () => {
	const answer = `작업 중 이 키를 찾았습니다:\n${PEM}\n이 키를 지워도 될까요?`;

	test("questionOf masks the whole answer", () => {
		const question = questionOf({ text: answer, errored: false, pendingTool: false, userAfter: false });
		expect(question).toBeDefined();
		expectMasked(question ?? "");
		expect(question).toEndWith("이 키를 지워도 될까요?");
	});

	test("the agent question card's tail lines carry no key line", () => {
		const card = buildAgentQuestionCard(row(), answer, OWNER);
		expectMasked(card.text);
		expect(card.text).toContain("이 키를 지워도 될까요?");
	});
});

describe("결함 3: 감사 기록의 작은따옴표 토큰", () => {
	const recorded = (cmd: string[]): string[] => {
		const lines: string[] = [];
		createDispatchAudit({ homeDir: "/nonexistent", log: { warn() {} }, sink: (line) => lines.push(line) }).record(
			cmd,
			{ code: 0, timedOut: false },
			1,
		);
		return lines;
	};

	test("an ssh remote argument holding access_token='…' is written masked", () => {
		const [line] = recorded(
			herdrSshArgv("wsl", "herdr", ["agent", "prompt", "x", `curl -d access_token='${BODY.repeat(6)}' https://a`]),
		);
		expect(line).toBeDefined();
		expect(line).not.toContain(BODY);
		expect(line).toContain("[REDACTED]");
	});

	test("a remote argument without a secret keeps its quoting", () => {
		const [line] = recorded(herdrSshArgv("wsl", "herdr", ["agent", "prompt", "x", "it's fine"]));
		expect(JSON.parse(line as string).cmd).toBe(`'herdr' 'agent' 'prompt' 'x' 'it'\\''s fine'`);
	});
});

describe("결함 4: 워커 cwd가 비밀 디렉터리", () => {
	const signal = new AbortController().signal;
	const home = tempDir("jabbu-qa-tuv-home-");
	mkdirSync(join(home, "secrets", "sub"), { recursive: true });
	mkdirSync(join(home, "work"), { recursive: true });
	symlinkSync(join(home, "secrets"), join(home, "work", "link"));

	const tool = () => {
		const calls: string[][] = [];
		const built = buildDispatchTool({
			originKey: "discord/dm/200000000000000001",
			ompExecutable: "omp",
			homeDir: home,
			workspaceDir: join(home, "workspace"),
			herdr: {},
			dispatchHosts: () => ({ wsl: { ssh: "wsl" } }),
			log: { info() {}, warn() {} },
			run: async (cmd) => {
				calls.push(cmd);
				return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
			},
		});
		return { built, calls };
	};

	test("a local cwd inside the bot's secrets (directly, below it, or through a symlink) is refused before any process", async () => {
		for (const cwd of [
			join(home, "secrets"),
			join(home, "secrets", "sub"),
			join(home, "work", "link"),
			"/home/someone/.jabbu-songbak/secrets",
		]) {
			const { built, calls } = tool();
			await expect(built.execute({ mode: "herdr", name: "x", task: "t", cwd }, { signal })).rejects.toThrow(
				"비밀 디렉터리",
			);
			expect(calls).toEqual([]);
		}
	});

	test("a remote cwd with a `secrets` path component is refused before any process", async () => {
		for (const cwd of ["~/.jabbu/secrets", "/home/u/.jabbu-x/secrets/a"]) {
			const { built, calls } = tool();
			await expect(built.execute({ host: "wsl", name: "x", task: "t", cwd }, { signal })).rejects.toThrow(
				"비밀 디렉터리",
			);
			expect(calls).toEqual([]);
		}
	});

	test("an ordinary cwd still starts the worker", async () => {
		const { built, calls } = tool();
		await built.execute({ mode: "herdr", name: "x", task: "t", cwd: join(home, "work") }, { signal });
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("결함 5: 자른 뒤 가리던 오류·증거 문구", () => {
	test("signals: trailing text, an unclosed block, a bad JSON value and an unreadable signal mask before their 40/60-char cut", () => {
		const message = (run: () => unknown): string => {
			try {
				run();
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error("no error");
		};
		const messages = [
			message(() => assertCheckPlacement(`기준 [check: command ["true"]] ${straddle(40, SK)}`)),
			message(() => assertCheckPlacement(`기준 [check: command ["true"]] ${straddle(40, JWT)}`)),
			message(() => parseChecks(`기준 ${straddle(60, SK, '[check: command ["true"] ')}`)),
			message(() => parseChecks(`기준 [check: command ${straddle(40, JWT, "[")}]]`)),
			message(() => parseSignal(straddle(40, SK, "bogus "))),
			message(() => parseSignal(straddle(40, JWT, "bogus "))),
		];
		expect(messages.map((text) => /맨 끝|닫히지 않았|JSON 값이 아닙니다|읽을 수 없는 신호/.exec(text)?.[0])).toEqual([
			"맨 끝",
			"맨 끝",
			"닫히지 않았",
			"JSON 값이 아닙니다",
			"읽을 수 없는 신호",
			"읽을 수 없는 신호",
		]);
		for (const text of messages) expectMasked(text);
	});

	const failing = (stdout: string, code: number | null = 1, timedOut = false): RunProcessResult => ({
		code,
		stdout,
		stderr: "",
		timedOut,
	});
	const HASH = "a".repeat(40);
	/** A runner answering by the git subcommand in the argv; `fail` is the one that fails. */
	const gitRunner =
		(fail: string, out: RunProcessResult): ProcessRunner =>
		async (cmd) => {
			if (cmd.includes(fail)) return out;
			// The base sha and the commit asked about (`rev-parse`) differ, so a commit check reaches merge-base.
			if (cmd.includes("log")) return { code: 0, stdout: `${HASH}\n`, timedOut: false };
			if (cmd.includes("rev-parse")) return { code: 0, stdout: `${"b".repeat(40)}\n`, timedOut: false };
			return { code: 0, stdout: "", timedOut: false };
		};
	const task = { worktree: "/w/t", branch: "task/T-20261120-01", taskId: "T-20261120-01", baseSha: HASH };

	for (const token of [SK, JWT]) {
		const kind = token === SK ? "sk-" : "JWT";
		test(`host: each git/ssh failure masks a ${kind} token across its cut`, async () => {
			const ssh = (run: ProcessRunner) => createTaskHostOps({ sshTarget: "h", run });
			const local = (run: ProcessRunner) => createTaskHostOps({ run });
			const errorOf = async (call: () => Promise<unknown>): Promise<string> => {
				try {
					const result = (await call()) as { ok?: boolean; error?: string };
					if (result.ok === false) return result.error as string;
					throw new Error(`no failure: ${JSON.stringify(result)}`);
				} catch (error) {
					return (error as Error).message;
				}
			};
			const errors = [
				// 187: unreachable reason (120)
				await errorOf(() => ssh(async () => failing(straddle(120, token), null, true)).pathExists("/w/x")),
				// 209: commit check, `rev-parse` of the commit (160)
				await errorOf(() =>
					local(gitRunner("rev-parse", failing(straddle(160, token)))).commitOnTaskBranch({
						worktree: task.worktree,
						branch: task.branch,
						baseSha: task.baseSha,
						hash: "b".repeat(40),
					}),
				),
				// 233: worktree add (200)
				await errorOf(() =>
					local(async () => failing(straddle(200, token))).createWorktree({
						repo: "/w/repo",
						worktree: task.worktree,
						branch: task.branch,
					}),
				),
				// 260: remote write (160)
				await errorOf(() => ssh(async () => failing(straddle(160, token))).writeFile("/w/t/a.md", "x")),
				// 307: commit check (160)
				await errorOf(() =>
					local(gitRunner("merge-base", failing(straddle(160, token), 2))).commitOnTaskBranch({
						worktree: task.worktree,
						branch: task.branch,
						baseSha: task.baseSha,
						hash: "b".repeat(40),
					}),
				),
				// 358: diff (160)
				await errorOf(() => local(gitRunner("diff", failing(straddle(160, token)))).branchDiff(task)),
				// 376: docs commit (200)
				await errorOf(() =>
					local(gitRunner("add", failing(straddle(200, token)))).commitDocs({
						worktree: task.worktree,
						taskId: task.taskId,
					}),
				),
				// 426: HEAD read (160)
				await errorOf(() => local(gitRunner("rev-parse", failing(straddle(160, token)))).headOf(task.worktree)),
				// 443: progress lag (160)
				await errorOf(() =>
					local(gitRunner("log", failing(straddle(160, token)))).progressLag({
						worktree: task.worktree,
						taskId: task.taskId,
						progressFile: `${task.worktree}/docs/tasks/${task.taskId}/PROGRESS.md`,
					}),
				),
			];
			// Each error carries the failing output (the filler), and no part of the token.
			expect(errors.filter((error) => !error.includes(FILL.repeat(40)))).toEqual([]);
			expect(errors.filter((error) => error.includes(BODY))).toEqual([]);
		});
	}

	test("land: a git failure line and the handoff reason are masked before their cuts", async () => {
		const worktree = tempDir("jabbu-qa-tuv-wt-");
		const git: GitRunner = async (args) => {
			if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/heads/task/T-20261120-01\n", stderr: "" };
			if (args.includes("status")) return { code: 128, stdout: "", stderr: straddle(200, JWT, "fatal: ") };
			return { code: 2, stdout: "", stderr: "" };
		};
		const result = await landTask(row({ worktree }), { git } as Partial<TaskLandDeps> as TaskLandDeps);
		expect(result.state).toBe("handoff");
		expectMasked((result as { reason: string }).reason);
	});

	test("land: git patch-id's stderr is masked before its 160-char cut", async () => {
		const repo = tempDir("jabbu-qa-tuv-repo-");
		execFileSync("git", ["init", "-q", repo]);
		// `fatal: ambiguous argument '` (27 chars) comes before the revision in git's message.
		const rev = straddle(160 - 27, SK);
		const error = await gitPatchIds(repo, [rev]).then(
			() => "",
			(e: Error) => e.message,
		);
		expect(error).toContain("git patch-id 실패");
		expectMasked(error);
	});

	test("notify: the read-failure notice masks before its 160-char cut", () => {
		expectMasked(formatReadFailureNotice(row(), 3, straddle(160, JWT)));
		expectMasked(formatReadFailureNotice(row(), 3, straddle(160, SK)));
	});

	test("wiki notes: outcome evidence and commit subjects mask before the clip", () => {
		for (const max of [100, 120, 200, 300]) {
			expectMasked(oneLine(straddle(max - 1, JWT), max));
			expectMasked(oneLine(straddle(max - 1, SK), max));
		}
	});

	test("checker: a malformed commit entry (40) and an unreadable diff (120) mask before their cuts", async () => {
		const meta = {
			taskId: "T-20261120-01",
			hostLabel: "local",
			repo: "/w/repo",
			worktree: "/w/repo-T-20261120-01",
			branch: "task/T-20261120-01",
			agent: "t-20261120-01",
			threadLink: "x",
			registeredAt: 0,
			timezone: "Asia/Seoul",
		};
		const snapshot = acceptanceItems(["기준"]);
		const spec = renderSpec(
			meta,
			{ title: "t", risk: "L2", goal: "g", scope: [], exclusions: [], acceptance: [], repo: meta.repo },
			snapshot,
		).replaceAll("- [ ] AC-", "- [x] AC-");
		const progress = `---\ntask: ${meta.taskId}\nstatus: working\nupdated: 2026-11-20T10:00:00+09:00\ncurrent: S1\nnext: x\nblocked_reason: \n---\n# 단계\n- [x] S1: a | 완료 조건: b | 증거: test\n`;
		const base = { snapshot, spec, progress, commitCheck: async (): Promise<CommitCheck> => "ok" };
		for (const token of [SK, JWT]) {
			const malformed = await checkTask({ ...base, outcome: `## AC-1\n- commit: ${straddle(40, token)}\n` });
			expect(malformed.problems.some((problem) => problem.includes("commit 해시 형식"))).toBe(true);
			for (const problem of malformed.problems) expectMasked(problem);
			const unread = await checkTask({
				...base,
				outcome: "## AC-1\n- test: bun test → 5 pass 0 fail\n",
				integrity: async () => ({ error: straddle(120, token) }),
			});
			expect(unread.problems.some((problem) => problem.includes("diff를 읽지 못해"))).toBe(true);
			for (const problem of unread.problems) expectMasked(problem);
		}
	});

	test("integrity: the excerpt masks before its 120-char cut", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -0,0 +1 @@",
			`+${straddle(120, JWT, "// TODO ")}`,
		].join("\n");
		const refusals = classifyLaneCompletion({ summary: "", diff });
		expect(refusals.map((refusal) => refusal.category)).toContain("unfinished_work_marker");
		for (const refusal of refusals) expectMasked(refusal.excerpt);
	});
});

describe("서팍 검토: 남은 절단·복사 경로", () => {
	test("unmetLines masks a token across its 200-char cut", () => {
		for (const token of [SK, JWT]) {
			const lines = unmetLines([straddle(200, token)]);
			expect(lines).toHaveLength(1);
			expectMasked(lines[0] ?? "");
		}
	});

	test("the reached card's integrity warnings mask before the 200-char cut", () => {
		const judgement = { summary: ["끝"], problems: [], integrityWarnings: [straddle(200, JWT)], checks: [] };
		const card = buildReachedCard(row(), judgement as Partial<TaskJudgement> as TaskJudgement, OWNER);
		expectMasked(card.text);
		expectMasked(card.body ?? "");
	});

	test("export --with-files never copies a file from the home's secrets directory", () => {
		const home = tempDir("jabbu-qatuv-export-");
		const scriptsRoot = join(home, "scripts");
		const secrets = join(home, "secrets");
		mkdirSync(scriptsRoot, { recursive: true });
		mkdirSync(secrets, { recursive: true });
		const script = join(scriptsRoot, "check.sh");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);
		const token = join(secrets, "discord-bot-token");
		writeFileSync(token, `${SK}\n`, { mode: 0o600 });
		// No usable config: the workspace falls back to the home itself (src/cli/monitors.ts).
		const ctx = { scriptsRoot, workspaceDir: home, defaultTimezone: "Asia/Seoul" };
		const ledger = openMonitorLedger(join(home, "jabbu.db"));
		try {
			ledger.addMonitor(
				parseMonitorSpec(
					{
						name: "token check",
						trigger: { kind: "script", command: [script, "--token-file", token], intervalMs: 300_000 },
						instruction: "x",
					},
					ctx,
				),
			);
			const dir = join(home, "export");
			const result = exportMonitors(ledger, dir, ctx, { withFiles: true });
			expect(existsSync(join(dir, "files", "workspace", "secrets", "discord-bot-token"))).toBe(false);
			expect(result.warnings.some((warning) => warning.includes("secrets directory"))).toBe(true);
			expect(existsSync(join(dir, "files", "scripts", "check.sh"))).toBe(true);
		} finally {
			ledger.close();
		}
	});
});
