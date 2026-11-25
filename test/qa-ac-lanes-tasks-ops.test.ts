import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordChannel } from "../src/discord/channel";
import { buildDispatchTool, type DispatchToolDeps } from "../src/dispatch/tool";
import { parseLaneTrigger } from "../src/lanes/trigger";
import { laneTriggerRefusal } from "../src/lanes/trigger-format";
import { openMonitorLedger } from "../src/monitors/ledger";
import { applyMonitors, exportMonitors } from "../src/monitors/portable";
import { PortableUsageError } from "../src/monitors/portable-files";
import { parseMonitorSpec } from "../src/monitors/spec";
import { installSkill, rollbackSkill, type SkillProposal } from "../src/review/skills";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { TaskLedger } from "../src/tasks/ledger";
import { STALE_NOTICE_MS, TaskSweeper, WORKING_SILENT_NOTICE_MS } from "../src/tasks/sweeper";
import { localIso } from "../src/time";
import { OWNER } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { LOCAL_TASK_NOW } from "./helpers/local-task";

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

const proposal = (action: "create" | "patch", name = "demo"): SkillProposal => ({
	action,
	name,
	description: "demo skill",
	content: `# ${action} body\n`,
	evidence: "verified in thread",
	checks: [
		{ situation: "fires", expect: "does X" },
		{ situation: "unrelated", expect: "skips" },
	],
});

describe("qa-ac dispatch·lanes·tasks·review·monitors 수정", () => {
	test("#19: 원격 호스트의 done·cancelled TASK에는 후속 지시를 거부하고 조회만 허용한다", async () => {
		const signal = new AbortController().signal;
		for (const status of ["cancelled", "done"] as const) {
			const db = new Database(":memory:", { strict: true });
			const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => LOCAL_TASK_NOW } });
			const row = ledger.register({
				title: "원격 작업",
				risk: "L0",
				originKey: "discord/dm/200000000000000001",
				threadRef: "c:1",
				host: "wsl",
				repo: "/remote/repo",
				acceptance: [],
				runtime: "herdr",
			});
			ledger.transition(row.taskId, status, "human", "close");

			const runs: string[][] = [];
			const tasks = {
				ledger,
				now: () => LOCAL_TASK_NOW,
				timezone: "Asia/Seoul",
				hostOps: () => ({ readFile: async () => ({ ok: false, error: "no docs" }) }),
			} as unknown as NonNullable<DispatchToolDeps["tasks"]>;
			const tool = buildDispatchTool({
				originKey: "discord/dm/200000000000000001",
				ompExecutable: "omp",
				homeDir: "/h",
				workspaceDir: "/h/workspace",
				herdr: {},
				dispatchHosts: () => ({ wsl: { ssh: "wsl-host", workDir: "/remote" } }),
				tasks,
				run: async (cmd) => {
					runs.push(cmd);
					return { code: 0, stdout: "last screen output", timedOut: false };
				},
				log: { info() {}, warn() {} },
			});

			await expect(tool.execute({ host: "wsl", name: row.agent, task: "계속 진행해" }, { signal })).rejects.toThrow(
				`${row.taskId}는 이미 ${status}로 닫힌 작업입니다`,
			);
			expect(runs).toEqual([]);

			const readOut = await tool.execute({ host: "wsl", name: row.agent }, { signal });
			expect(readOut).toContain("last screen output");
			expect(runs.length).toBeGreaterThan(0);
			db.close();
		}
	});

	test("#20: parseLaneTrigger와 laneTriggerRefusal은 긴 공백·@ 반복 입력에서도 선형 시간(<50ms)이다", () => {
		const nastySpaces = `작업: t${" ".repeat(40_000)}y`;
		const nastyAts = `작업: t${" @".repeat(20_000)}y`;
		const t0 = performance.now();
		expect(parseLaneTrigger(nastySpaces)).toBeUndefined();
		expect(laneTriggerRefusal(nastySpaces)).toBeUndefined();
		expect(parseLaneTrigger(nastyAts)).toBeUndefined();
		expect(laneTriggerRefusal(nastyAts)).toBeUndefined();
		expect(performance.now() - t0).toBeLessThan(50);

		expect(parseLaneTrigger("작업: 제목 @/tmp/repo 브리프\n둘째 줄")).toEqual({
			title: "제목",
			cwd: "/tmp/repo",
			brief: "브리프\n둘째 줄",
		});
		expect(parseLaneTrigger("작업:   @/tmp/repo")).toBeUndefined();
		expect(laneTriggerRefusal("작업: 제목 @~/repo")).toContain("@<절대경로>");
		expect(laneTriggerRefusal("작업: 제목 @./rel")).toContain("@<절대경로>");
		expect(laneTriggerRefusal("작업: 제목 @../rel")).toContain("@<절대경로>");
		expect(laneTriggerRefusal("작업: <@123> user@x.test @types/bun\n@~/later")).toBeUndefined();
	});

	test("#21: 스윕 도중 일시정지가 들어오면 silent45·stale2h 알림을 게시하거나 기록하지 않는다", async () => {
		const T0 = Date.parse("2026-10-26T06:00:00Z");
		const baseJudgement: TaskJudgement = {
			reached: false,
			acChecked: 0,
			acTotal: 1,
			stepsDone: 0,
			stepsTotal: 1,
			status: "working",
			updatedAt: localIso(T0, "Asia/Seoul"),
			updatedAtMs: T0,
			specChanged: false,
			specKey: "k1",
			blocked: false,
			needsOwner: false,
			blockedReason: "",
			decision: { question: "", recommend: "", impact: "", fallbackOk: false },
			current: "S1",
			restated: "",
			evidence: {},
			summary: [],
			checks: [],
			integrityWarnings: [],
			reachKey: "r1",
			acceptance: [],
			steps: [],
			problems: [],
		};

		for (const scenario of ["silent45", "stale2h"] as const) {
			const db = new Database(":memory:", { strict: true });
			let now = T0;
			const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => now } });
			const row = ledger.register({
				title: "잠시 멈춤 테스트",
				risk: "L2",
				originKey: "discord/ch/300000000000000001/t/400000000000000001",
				threadRef: "300000000000000001:400000000000000001",
				host: null,
				repo: "/r/repo",
				acceptance: acceptanceItems(["하나"]),
			});
			const transport = new FakeDiscordTransport();
			let pauseInjected = false;
			const sweeper = new TaskSweeper({
				ledger,
				evaluate: async () => ({ ok: true, judgement: baseJudgement }),
				remind: async () => ({ ok: true }),
				agentStatus: async () => ({ ok: true, status: "working" }),
				readAgent: async () => {
					if (scenario === "silent45" && !pauseInjected) {
						pauseInjected = true;
						ledger.pauseTask(row.taskId);
					}
					return { ok: true, output: "running" };
				},
				boardLink: async () => {
					if (scenario === "stale2h" && !pauseInjected) {
						pauseInjected = true;
						ledger.pauseTask(row.taskId);
					}
					return "https://board.test/x";
				},
				lastAnswer: async () => undefined,
				channels: registryOf(new DiscordChannel(transport, { ownerUserId: OWNER })),
				ownerUserId: OWNER,
				now: () => now,
				log: { info() {}, warn() {} },
			});

			now = T0 + (scenario === "silent45" ? WORKING_SILENT_NOTICE_MS : STALE_NOTICE_MS);
			await sweeper.sweep();
			expect(transport.calls.filter((c) => c.method === "createMessage")).toHaveLength(0);
			expect(Object.keys(ledger.require(row.taskId).notices).some((k) => k.startsWith(`${scenario}:`))).toBe(false);

			now += 1000;
			ledger.unpauseTask(row.taskId);
			await sweeper.sweep();
			expect(transport.calls.filter((c) => c.method === "createMessage")).toHaveLength(1);
			expect(Object.keys(ledger.require(row.taskId).notices).some((k) => k.startsWith(`${scenario}:`))).toBe(true);
			db.close();
		}
	});

	test("#22/#23: rollbackSkill·installSkill은 임시·대상 경로의 심링크·다중 하드링크를 거부하고 밖을 건드리지 않는다", () => {
		const root = tempDir("jabbu-qa-ac-skill-");
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "TOP_SECRET");

		// #23: installSkill refuses symlink/hardlink targets (including dangling SKILL.md symlink) for create & patch.
		const danglingSkill = join(root, "dangling");
		mkdirSync(danglingSkill, { recursive: true });
		symlinkSync(join(root, "not-there.md"), join(danglingSkill, "SKILL.md"));
		expect(() => installSkill(danglingSkill, proposal("create", "dangling"), 1000)).toThrow("install refused");

		const liveSkill = join(root, "live");
		mkdirSync(liveSkill, { recursive: true });
		symlinkSync(outside, join(liveSkill, "SKILL.md"));
		expect(() => installSkill(liveSkill, proposal("patch", "live"), 1000)).toThrow("install refused");
		expect(readFileSync(outside, "utf8")).toBe("TOP_SECRET");

		const hardSkill = join(root, "hard");
		mkdirSync(hardSkill, { recursive: true });
		linkSync(outside, join(hardSkill, "SKILL.md"));
		expect(() => installSkill(hardSkill, proposal("patch", "hard"), 1000)).toThrow("install refused");
		expect(readFileSync(outside, "utf8")).toBe("TOP_SECRET");

		// Normal create -> patch -> rollback ignoring pre-planted *.rollback-tmp symlinks (#22).
		const okSkill = join(root, "demo");
		expect(installSkill(okSkill, proposal("create"), 1000)).toBeUndefined();
		const rev = installSkill(okSkill, proposal("patch"), 2000) as string;
		expect(statSync(join(okSkill, "SKILL.md")).mode & 0o777).toBe(0o600);
		symlinkSync(outside, `${rev}.rollback-tmp`);
		symlinkSync(outside, `${join(okSkill, "SKILL.md")}.rollback-tmp`);
		expect(rollbackSkill(okSkill)).toBe(rev);
		expect(readFileSync(outside, "utf8")).toBe("TOP_SECRET");
		expect(readFileSync(join(okSkill, "SKILL.md"), "utf8")).toContain("# create body");
	});

	test("#24/#46/#48: export --with-files는 files 심링크·파일을 사전 거부하고, 심링크 scriptsRoot의 실경로를 @SCRIPTS@로 쓴다", () => {
		const base = tempDir("jabbu-qa-ac-mon-");
		const realScripts = join(base, "real-scripts");
		const linkedScripts = join(base, "home-a", "scripts");
		const workspaceA = join(base, "home-a", "workspace");
		mkdirSync(realScripts, { recursive: true });
		mkdirSync(join(base, "home-a"), { recursive: true });
		mkdirSync(workspaceA, { recursive: true });
		symlinkSync(realScripts, linkedScripts);

		const scriptReal = join(realScripts, "check.sh");
		writeFileSync(scriptReal, "#!/bin/sh\nexit 0\n");
		chmodSync(scriptReal, 0o755);

		const dbPath = join(base, "jabbu.db");
		const ledger = openMonitorLedger(dbPath);
		const ctxA = { scriptsRoot: linkedScripts, workspaceDir: workspaceA, defaultTimezone: "Asia/Seoul" };
		ledger.addMonitor(
			parseMonitorSpec(
				{ name: "symroot", trigger: { kind: "script", command: [scriptReal], intervalMs: 60_000 }, instruction: "x" },
				ctxA,
			),
		);

		// #24: symlinked <dir>/files or <dir>/files/scripts refuses before deleting victim or writing JSON.
		const victim = join(base, "victim");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "keep.txt"), "safe\n");
		const dirSymlink = join(base, "out-sym");
		mkdirSync(dirSymlink, { recursive: true });
		symlinkSync(victim, join(dirSymlink, "files"));
		expect(() => exportMonitors(ledger, dirSymlink, ctxA, { withFiles: true })).toThrow(PortableUsageError);
		expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("safe\n");
		expect(readdirSync(dirSymlink)).toEqual(["files"]);

		const dirSubSymlink = join(base, "out-sub-sym");
		mkdirSync(join(dirSubSymlink, "files"), { recursive: true });
		symlinkSync(victim, join(dirSubSymlink, "files", "scripts"));
		expect(() => exportMonitors(ledger, dirSubSymlink, ctxA, { withFiles: true })).toThrow(PortableUsageError);
		expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("safe\n");
		expect(readdirSync(dirSubSymlink)).toEqual(["files"]);

		// #48: regular file at <dir>/files throws PortableUsageError cleanly with no partial JSON.
		const dirFile = join(base, "out-file");
		mkdirSync(dirFile, { recursive: true });
		writeFileSync(join(dirFile, "files"), "not-a-dir\n");
		expect(() => exportMonitors(ledger, dirFile, ctxA, { withFiles: true })).toThrow(PortableUsageError);
		expect(readdirSync(dirFile)).toEqual(["files"]);

		// #46: symlinked scriptsRoot maps realpath script to @SCRIPTS@/check.sh and copies into files/scripts/.
		const outOk = join(base, "out-ok");
		const exported = exportMonitors(ledger, outOk, ctxA, { withFiles: true });
		expect(exported.written).toBe(1);
		expect(exported.warnings).toEqual([]);
		const specJson = JSON.parse(readFileSync(join(outOk, "symroot.json"), "utf8")) as {
			trigger: { command: string[] };
		};
		expect(specJson.trigger.command).toEqual(["@SCRIPTS@/check.sh"]);
		expect(readFileSync(join(outOk, "files", "scripts", "check.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(lstatSync(join(outOk, "files", "scripts", "check.sh")).isFile()).toBe(true);

		// Applying back onto home-b with its own symlinked scriptsRoot works and re-apply stays unchanged.
		const workspaceB = join(base, "home-b", "workspace");
		const realScriptsB = join(base, "real-b");
		const linkedScriptsB = join(base, "home-b", "scripts");
		mkdirSync(workspaceB, { recursive: true });
		mkdirSync(realScriptsB, { recursive: true });
		writeFileSync(join(realScriptsB, "check.sh"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(realScriptsB, "check.sh"), 0o755);
		symlinkSync(realScriptsB, linkedScriptsB);
		const ledgerB = openMonitorLedger(join(base, "jabbu-b.db"));
		const ctxB = { scriptsRoot: linkedScriptsB, workspaceDir: workspaceB, defaultTimezone: "Asia/Seoul" };
		expect(applyMonitors(ledgerB, outOk, ctxB).added).toBe(1);
		expect(applyMonitors(ledgerB, outOk, ctxB).unchanged).toBe(1);

		ledgerB.close();
		ledger.close();
	});
});
