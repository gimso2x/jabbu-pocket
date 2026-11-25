import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardCardLink } from "../src/dispatch/board";
import { buildDispatchTool } from "../src/dispatch/tool";
import { guardCode } from "../src/lanes/guard-code";
import { captureTree, type GitRunner, planUndo, type TurnSnapshotRow, undoPlanNotes } from "../src/ops/turn-snapshot";
import { checkSignalsOf, parseChecks, SignalSyntaxError, withoutCheckTail } from "../src/tasks/signals";
import { makeRepo } from "./helpers/git-fixtures";
import { fakeMailbox, localTask } from "./helpers/local-task";

const repos: string[] = [];

afterAll(() => {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

describe("qa-ab dispatch·ops·lanes·tasks 수정", () => {
	test("#18: boardCardLink URL-encodes card parts while preserving colons", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				Response.json({
					machines: [
						{ id: "local", name: "dev", kind: "local" },
						{ id: "m#1&x=y", name: "remote", kind: "ssh" },
					],
				}),
		});
		try {
			const board = { url: "https://board.test/task/", api: `http://127.0.0.1:${server.port}/` };
			expect(await boardCardLink(board, null, "w2V:p?a=1#frag 2")).toBe(
				"https://board.test/task/?card=w2V:p%3Fa%3D1%23frag%202",
			);
			expect(await boardCardLink(board, "remote", "w1:p3")).toBe("https://board.test/task/?card=m%231%26x%3Dy:w1:p3");
		} finally {
			server.stop(true);
		}
	});

	test("#24/#25: planUndo returns missing plan when .git directory or snapshot objects are unreadable", async () => {
		const repo = makeRepo(repos);
		const before = await captureTree(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		const after = await captureTree(repo);
		const row: TurnSnapshotRow = {
			id: 1,
			originKey: "discord/dm/200000000000000001",
			opRef: "op-1",
			repo,
			headBefore: before.head,
			treeBefore: before.tree,
			headAfter: after.head,
			treeAfter: after.tree,
			startedAt: 1000,
			endedAt: 2000,
			revertedAt: null,
		};

		const failGit: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad object" });
		const badObjectPlan = await planUndo({ row, run: failGit });
		expect(badObjectPlan).toEqual({ repo, source: before.tree, missing: true, files: [] });
		expect(undoPlanNotes(badObjectPlan)).toEqual([`저장소를 찾을 수 없음: ${repo}`]);

		rmSync(join(repo, ".git"), { recursive: true, force: true });
		const missingGitPlan = await planUndo({ row });
		expect(missingGitPlan).toEqual({ repo, source: before.tree, missing: true, files: [] });

		const timeoutGit: GitRunner = async () => ({ code: 124, stdout: "", stderr: "git diff timed out after 10000ms" });
		await expect(planUndo({ row, run: timeoutGit })).rejects.toThrow("timed out");
	});

	test("#36: jabbu_dispatch worker follow-up rejects done and cancelled tasks", async () => {
		const signal = new AbortController().signal;
		for (const status of ["done", "cancelled"] as const) {
			const mb = fakeMailbox();
			const { row, ledger, tasks } = localTask("headless", mb.port);
			ledger.transition(row.taskId, status, "human", "close");
			const tool = buildDispatchTool({
				originKey: "discord/dm/200000000000000001",
				ompExecutable: "omp",
				homeDir: "/h",
				workspaceDir: "/h/workspace",
				herdr: {},
				tasks,
				log: { info() {}, warn() {} },
			});
			await expect(tool.execute({ mode: "worker", name: row.agent, task: "후속 지시" }, { signal })).rejects.toThrow(
				`이미 ${status}로 닫힌 작업입니다`,
			);
			expect(mb.calls.routed).toEqual([]);
		}
	});

	test("#39: guardCode handles deep unclosed templates linearly without stack overflow", () => {
		const nasty = "`${".repeat(10_000);
		const t0 = performance.now();
		const actual = guardCode(nasty);
		expect(performance.now() - t0).toBeLessThan(200);
		expect(actual).toBe(nasty);
		const dollar = "$";
		const interp = (expr: string) => `${dollar}{${expr}}`;
		expect(guardCode(`const a = \`${interp("user.name")}\`; // keep`)).toBe('const a = "";');
		const nested = `const b = \`${interp("fn(`inner`)")}\`;`;
		expect(guardCode(nested)).toBe(nested);
	});

	test("#41: checkSignalsOf and withoutCheckTail stay linear on repeated [check: inputs", () => {
		const repeatedOpen = "[check: ".repeat(10_000);
		const t0 = performance.now();
		expect(() => checkSignalsOf(repeatedOpen)).toThrow(SignalSyntaxError);
		expect(checkSignalsOf(`${repeatedOpen}] tail`)).toEqual([]);
		expect(withoutCheckTail(`${repeatedOpen}] tail`)).toBe(`${repeatedOpen}] tail`);
		expect(checkSignalsOf(`${repeatedOpen}] [foo]`)).toEqual([]);
		expect(withoutCheckTail(`${repeatedOpen}] [foo]`)).toBe(`${repeatedOpen}] [foo]`);
		expect(() => checkSignalsOf(`[check: ${"[".repeat(10_000)}]`)).toThrow(SignalSyntaxError);
		expect(performance.now() - t0).toBeLessThan(200);

		expect(parseChecks('say "hello [check: file a]" [check: file b]')).toEqual([{ kind: "file", path: "b" }]);
		expect(checkSignalsOf('[check: command ["grep","[check:"]]')).toEqual(['command ["grep","[check:"]']);
	});
});
