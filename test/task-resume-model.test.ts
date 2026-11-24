import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DiscordChannel } from "../src/discord/channel";
import type { ProcessRunner } from "../src/dispatch/omp";
import { buildDispatchTool } from "../src/dispatch/tool";
import type { LaneModelTiers } from "../src/model-tiers";
import { IDLE_HOST_LOAD } from "../src/ops/host-resources";
import type { HostResult, TaskHostOps, TaskResumeOps } from "../src/tasks/host";
import { TaskLedger } from "../src/tasks/ledger";
import { OWNER } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const GLM = "zai/glm-5.3";
const MODELS: LaneModelTiers = { high: OPUS, middle: SONNET, low: GLM };
const SPEC = {
	title: "로그 회전",
	risk: "L2",
	goal: "로그 회전을 넣는다",
	scope: ["src/log.ts"],
	exclusions: ["배포"],
	acceptance: ["회전 테스트가 통과한다"],
	repo: "/r/repo",
};
const TASK_ID = "T-20261121-01";
const PROGRESS =
	"---\nstatus: working\ncurrent: S2\nnext: 테스트를 쓴다\n---\n# 단계\n- [x] S1: 조사 | 증거: commit abc1234\n";

function setup() {
	const db = new Database(":memory:", { strict: true });
	const ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => NOW } });
	const files = new Map<string, string>();
	const existing = new Set<string>();
	const herdr: string[][] = [];
	const agents = new Set<string>();
	const failStart = { value: false };
	const screen = Array.from({ length: 120 }, (_, i) => `screen-line-${i + 1}`).join("\n");
	const host = {
		async pathExists(path: string): Promise<HostResult<boolean>> {
			return { ok: true, value: existing.has(path) };
		},
		async createWorktree(input: { worktree: string }) {
			existing.add(input.worktree);
			return { ok: true as const, value: null };
		},
		async removeWorktree() {},
		async writeFile(path: string, content: string) {
			files.set(path, content);
			return { ok: true as const, value: null };
		},
		async readFile(path: string) {
			return { ok: true as const, value: files.get(path) };
		},
		async progressLag() {
			return {
				ok: true as const,
				value: { progressCommit: "abc1234", codeCommitsSince: 0, progressDirty: false, otherDirty: 0 },
			};
		},
		async commitDocs() {
			return { ok: true as const, value: "abc1234" };
		},
		async headOf() {
			return { sha: "e".repeat(40), clean: true };
		},
	} as unknown as TaskHostOps & TaskResumeOps;
	const run: ProcessRunner = async (cmd) => {
		herdr.push(cmd);
		const ok = (stdout = "{}") => ({ code: 0, stdout, timedOut: false });
		if (cmd[1] === "agent" && cmd[2] === "list") {
			return ok(
				JSON.stringify({
					result: { agents: [...agents].map((name) => ({ name, workspace_id: `W-${name}`, tab_id: `T-${name}` })) },
				}),
			);
		}
		if (cmd[1] === "workspace" && cmd[2] === "list") return ok(JSON.stringify({ result: { workspaces: [] } }));
		if ((cmd[1] === "workspace" || cmd[1] === "tab") && cmd[2] === "create") {
			return ok(
				JSON.stringify({
					result: { workspace: { workspace_id: "W1" }, tab: { tab_id: "T1" }, root_pane: { pane_id: "P1" } },
				}),
			);
		}
		if (cmd[1] === "workspace" && cmd[2] === "close") {
			agents.clear();
			return ok();
		}
		if (cmd[1] === "agent" && cmd[2] === "read") return ok(screen);
		if (cmd[1] === "agent" && cmd[2] === "start") {
			if (failStart.value) return { code: 1, stdout: "boom", timedOut: false };
			agents.add(cmd[3] as string);
		}
		return ok();
	};
	const tool = buildDispatchTool({
		originKey: "discord/ch/111111111111111111/t/222222222222222222",
		ompExecutable: "omp",
		homeDir: "/home",
		workspaceDir: "/ws",
		herdr: {},
		laneModels: () => MODELS,
		run,
		log: { info: () => {}, warn: () => {} },
		tasks: {
			ledger,
			timezone: "Asia/Seoul",
			threadRef: () => "111111111111111111:222222222222222222",
			rootText: () => "[TASK] 로그 회전",
			channels: registryOf(new DiscordChannel(new FakeDiscordTransport(), { ownerUserId: OWNER })),
			now: () => NOW,
			hostOps: () => host,
			hostLoad: IDLE_HOST_LOAD,
		},
	});
	const call = (params: Record<string, unknown>) => tool.execute(params, { signal: new AbortController().signal });
	return { ledger, files, existing, herdr, agents, failStart, call, screen };
}

const startsOf = (herdr: string[][]) => herdr.filter((c) => c[1] === "agent" && c[2] === "start");
const promptsOf = (herdr: string[][]) => herdr.filter((c) => c[1] === "agent" && c[2] === "prompt");

describe("TASK resume on another worker tier", () => {
	test("tier=high restarts on the high model; the handoff brief rides the first input", async () => {
		const h = setup();
		await h.call({ taskSpec: { ...SPEC, tier: "middle" }, task: "go" });
		const row = h.ledger.require(TASK_ID);
		h.files.set(`${row.worktree}/docs/tasks/${TASK_ID}/PROGRESS.md`, PROGRESS);
		h.herdr.length = 0;

		const out = await h.call({
			taskSpec: { id: TASK_ID, tier: "high", tierReason: "더 센 모델이 필요" },
			task: "이어서",
		});

		expect(out).toContain("middle(anthropic/claude-sonnet-5-5) → high(anthropic/claude-opus-5-5)");
		expect(h.ledger.require(TASK_ID)).toMatchObject({
			tier: "high",
			workerModel: OPUS,
			tierReason: "더 센 모델이 필요",
		});
		const start = startsOf(h.herdr);
		expect(start).toHaveLength(1);
		const args = start[0] as string[];
		expect(args.slice(args.indexOf("--") + 1)).toEqual(["--model", OPUS]);
		const prompt = (promptsOf(h.herdr)[0] as string[])[4] as string;
		expect(prompt).toContain("인계:");
		expect(prompt).toContain("current: S2");
		expect(prompt).toContain(`docs/tasks/${TASK_ID}/spec.md`);
		expect(prompt).toContain("screen-line-120");
		expect(prompt).toContain("screen-line-41");
		expect(prompt).not.toContain("screen-line-40\n");
		expect(prompt).toEndWith("이어서");
		expect(h.herdr.some((c) => c[1] === "workspace" && c[2] === "close")).toBe(true);
		expect(Object.keys(h.ledger.require(TASK_ID).notices).some((key) => key.startsWith("model-change:"))).toBe(true);
	});

	test("a resume without tier keeps the registered model and carries no handoff brief", async () => {
		const h = setup();
		await h.call({ taskSpec: { ...SPEC, tier: "middle" }, task: "go" });
		h.herdr.length = 0;
		await h.call({ taskSpec: { id: TASK_ID }, task: "이어서" });
		expect(h.ledger.require(TASK_ID).workerModel).toBe(SONNET);
		expect(h.herdr.some((c) => c[1] === "workspace" && c[2] === "close")).toBe(false);
		expect(((promptsOf(h.herdr)[0] as string[])[4] as string).includes("인계:")).toBe(false);
	});

	test("a failed start puts the registered worker back", async () => {
		const h = setup();
		await h.call({ taskSpec: { ...SPEC, tier: "middle" }, task: "go" });
		h.failStart.value = true;
		const out = await h.call({ taskSpec: { id: TASK_ID, tier: "high" } });
		expect(out).toContain("재개 실패");
		expect(h.ledger.require(TASK_ID)).toMatchObject({ tier: "middle", workerModel: SONNET });
	});

	test("tierConfidence and unknown keys on a resume are refused before anything runs", async () => {
		const h = setup();
		await h.call({ taskSpec: { ...SPEC, tier: "middle" }, task: "go" });
		h.herdr.length = 0;
		await expect(h.call({ taskSpec: { id: TASK_ID, tierConfidence: 0.5 } })).rejects.toThrow("tierConfidence");
		await expect(h.call({ taskSpec: { id: TASK_ID, tier: "ultra" } })).rejects.toThrow("high·middle·low");
		await expect(h.call({ taskSpec: { id: TASK_ID, title: "x" } })).rejects.toThrow("id");
		expect(h.herdr).toEqual([]);
	});
});
