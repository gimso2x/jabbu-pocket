import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { LaneInputError } from "../src/lanes/manager-constants";
import { buildWorkStartTool } from "../src/lanes/tools";
import { buildLanePrompt } from "../src/lanes/trigger";
import {
	advertisedWorkflow,
	leadingWorkflow,
	triggerWorkflow,
	WORKFLOW_NAMES,
	type WorkflowName,
	workflowChoice,
} from "../src/lanes/workflow";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-lane-workflow-home-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

const promptOf = (workflow: WorkflowName | undefined, brief = "do it"): string =>
	buildLanePrompt({
		name: "demo",
		title: "Demo",
		cwd: "/tmp/p",
		brief,
		branch: "lane/L-1",
		baseBranch: "main",
		acceptance: [],
		workflow: workflow === undefined ? undefined : { name: workflow },
	});

describe("lane prompt completion rules", () => {
	test("the three completion rules come before the evidence line", () => {
		const prompt = promptOf(undefined);
		const evidence = prompt.indexOf("- 증거 없이 '완료'라고");
		for (const rule of ["이름은 실제 이름과 그대로 대조", "진입점(CLI·테스트·화면)", "timeout을 명시"]) {
			const at = prompt.indexOf(rule);
			expect(at).toBeGreaterThan(-1);
			expect(at).toBeLessThan(evidence);
		}
	});
});

describe("lane prompt first line", () => {
	test("no workflow chosen: no keyword line, the prompt starts with the task", () => {
		const prompt = promptOf(undefined);
		expect(prompt.startsWith("작업: Demo\n")).toBe(true);
		expect(prompt).not.toMatch(/\bulw\b|ultrathink|orchestrate|workflowz|jevify/i);
	});

	test("each of the seven workflows opens the prompt with its name and omp's default keyword", () => {
		const expected: Record<WorkflowName, string> = {
			jevify: "jevify",
			ulw: "ulw",
			"ulw-plan": "ulw-plan ultrathink",
			"ulw-execute": "ulw-execute orchestrate",
			"ulw-loop": "ulw-loop orchestrate",
			"mass-ulw": "mass-ulw workflowz",
			"ulw-research": "ulw-research workflowz",
		};
		expect(Object.keys(expected).sort()).toEqual([...WORKFLOW_NAMES].sort());
		for (const name of WORKFLOW_NAMES) {
			expect(promptOf(name).split("\n").slice(0, 3)).toEqual([expected[name], "", "작업: Demo"]);
		}
	});

	test("a native keyword already in the brief keeps the default keyword off the first line", () => {
		expect(promptOf("ulw-plan", "think with ultrathink please").split("\n")[0]).toBe("ulw-plan");
	});
});

describe("workflow choice", () => {
	test("needs a known name and a non-empty reason, nothing else", () => {
		expect(workflowChoice(undefined)).toBeUndefined();
		expect(workflowChoice({ name: "ulw", reason: "wide change" })).toEqual({ name: "ulw", reason: "wide change" });
		for (const bad of [
			null,
			"ulw",
			{ name: "ulw" },
			{ name: "ulw", reason: "  " },
			{ name: "debugging", reason: "x" },
			{ name: "ulw", reason: "x", extra: 1 },
		]) {
			expect(() => workflowChoice(bad)).toThrow(LaneInputError);
		}
	});

	test("advertised only as an extension command of that exact name, old or SUPER-alias description", () => {
		const command = { name: "ulw-plan", source: "extension", description: "Run the OMP-adapted ulw-plan workflow" };
		expect(advertisedWorkflow([command], "ulw-plan")).toBe(true);
		expect(advertisedWorkflow([{ ...command, description: "Legacy alias for /super-plan" }], "ulw-plan")).toBe(true);
		expect(advertisedWorkflow([{ ...command, source: "skill" }], "ulw-plan")).toBe(false);
		expect(advertisedWorkflow([{ ...command, name: "super-plan" }], "ulw-plan")).toBe(false);
		expect(advertisedWorkflow([command], "ulw")).toBe(false);
	});

	test("the tool schema offers the seven names", () => {
		const tool = buildWorkStartTool({} as never, CHANNEL, "o");
		const schema = (tool.parameters as { properties: { workflow: { properties: { name: { enum: string[] } } } } })
			.properties.workflow;
		expect(schema.properties.name.enum).toEqual([...WORKFLOW_NAMES]);
	});
});

describe("`작업:` trigger brief", () => {
	test("only a call at the very start of the brief is a choice, and it is cut from the brief", () => {
		expect(triggerWorkflow("ulw fix the bug")).toEqual({
			choice: { name: "ulw", reason: "오너 직접 호출" },
			brief: "fix the bug",
		});
		expect(triggerWorkflow("/ulw-execute  run spec")?.choice.name).toBe("ulw-execute");
		expect(triggerWorkflow("jevify\nthe plan")).toEqual({
			choice: { name: "jevify", reason: "오너 직접 호출" },
			brief: "the plan",
		});
		expect(triggerWorkflow("ulw")?.brief).toBe("");
	});

	test("the call's own default keyword is cut too; another keyword stays in the brief", () => {
		expect(triggerWorkflow("ulw-plan ultrathink write it")?.brief).toBe("write it");
		expect(triggerWorkflow("ulw-plan orchestrate write it")?.brief).toBe("orchestrate write it");
	});

	test("a mention in the middle, a quote, a path or an identifier is no call", () => {
		for (const brief of [
			"fix it with ulw",
			'"ulw" is the keyword',
			"ulw/path/to/file.ts is the file",
			"ulwx is a name",
			"please run ulw-plan later",
			"",
		]) {
			expect(triggerWorkflow(brief)).toBeUndefined();
		}
		expect(leadingWorkflow("ulw-loop go")?.name).toBe("ulw-loop");
	});
});

describe("lane start with a workflow", () => {
	test("a chosen workflow opens the first prompt; none chosen sends no keyword", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		const chosen = await h.manager.start({
			title: "chosen",
			cwd: repo,
			channel: CHANNEL,
			workflow: { name: "ulw-execute", reason: "spec lane" },
		});
		const plain = await h.manager.start({ title: "plain", cwd: repo, channel: CHANNEL });
		await h.settle();
		expect(chosen.meta.workflow).toEqual({ name: "ulw-execute", reason: "spec lane" });
		expect(plain.meta.workflow).toBeUndefined();
		expect(h.prompts(chosen.originKey)[0]?.startsWith("prompt:ulw-execute orchestrate\n\n작업: chosen\n")).toBe(true);
		expect(h.prompts(plain.originKey)[0]?.startsWith("prompt:작업: plain\n")).toBe(true);
		h.close();
	});

	test("a bad workflow refuses the start before anything is created", async () => {
		const repo = makeRepo(repos);
		const h = laneHarness(home.dir);
		await expect(
			h.manager.start({ title: "bad", cwd: repo, channel: CHANNEL, workflow: { name: "ulw", reason: "" } }),
		).rejects.toBeInstanceOf(LaneInputError);
		expect(h.store.listLanes()).toEqual([]);
		h.close();
	});

	test("a ULW workflow its omp has not loaded sends no prompt and closes the lane without worktree or branch", async () => {
		const repo = makeRepo(repos);
		const sessions = new FakeSessionStore();
		const drivers: FakeOmpDriver[] = [];
		const h = laneHarness(home.dir, {
			driver: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, commands: [] });
				drivers.push(driver);
				return driver;
			},
		});
		const lane = await h.manager.start({
			title: "no command",
			cwd: repo,
			channel: CHANNEL,
			workflow: { name: "ulw-plan", reason: "plan only" },
		});
		await h.settle();
		const row = h.store.getLane(lane.name);
		expect(row?.status).toBe("closed");
		expect(row?.meta.launchFailed).toContain("ulw-plan");
		expect(drivers.flatMap((driver) => driver.calls.filter((call) => call.startsWith("prompt:")))).toEqual([]);
		expect(existsSync(lane.meta.worktree ?? "")).toBe(false);
		expect(git(repo, "branch", "--list", lane.meta.branch ?? "")).toBe("");
		const edits = h.transport.calls.flatMap((call) => (call.method === "editMessage" ? [call.content ?? ""] : []));
		expect(edits.some((text) => text.startsWith("❌ no command"))).toBe(true);
		h.close();
	});

	test("a lane model omp does not list sends no prompt and closes the lane; a listed one starts", async () => {
		const repo = makeRepo(repos);
		const sessions = new FakeSessionStore();
		const drivers: FakeOmpDriver[] = [];
		const h = laneHarness(home.dir, {
			laneModels: () => ({ high: "fake/gone", low: "fake/alpha" }),
			driver: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, models: ["fake/alpha"] });
				drivers.push(driver);
				return driver;
			},
		});
		const missing = await h.manager.start({ title: "gone model", cwd: repo, channel: CHANNEL, model: "high" });
		const listed = await h.manager.start({
			title: "listed model",
			cwd: repo,
			channel: CHANNEL,
			risk: "L1",
			model: "low",
		});
		await h.settle();
		const row = h.store.getLane(missing.name);
		expect(row?.status).toBe("closed");
		expect(row?.meta.launchFailed).toContain("fake/gone");
		expect(existsSync(missing.meta.worktree ?? "")).toBe(false);
		expect(git(repo, "branch", "--list", missing.meta.branch ?? "")).toBe("");
		// Only the listed model's lane got a prompt.
		expect(drivers.flatMap((driver) => driver.calls.filter((call) => call.startsWith("prompt:")))).toHaveLength(1);
		expect(h.store.getLane(listed.name)?.status).toBe("working");
		h.close();
	});

	test("jevify is omp's own notice: it is not checked against the command list", async () => {
		const repo = makeRepo(repos);
		const sessions = new FakeSessionStore();
		const drivers: FakeOmpDriver[] = [];
		const h = laneHarness(home.dir, {
			driver: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true, commands: [] });
				drivers.push(driver);
				return driver;
			},
		});
		const lane = await h.manager.start({
			title: "jev",
			cwd: repo,
			channel: CHANNEL,
			workflow: { name: "jevify", reason: "review" },
		});
		await h.settle();
		expect(h.store.getLane(lane.name)?.status).toBe("working");
		expect(drivers.flatMap((driver) => driver.calls).some((call) => call.startsWith("prompt:jevify\n"))).toBe(true);
		h.close();
	});
});
