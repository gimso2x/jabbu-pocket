import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonTaskPrLand } from "../src/daemon/daemon-task-pr-land";
import type { PrTools } from "../src/lanes/pr";
import type { TaskRow } from "../src/tasks/ledger";

/**
 * G7: the deps of a task PR landing carried `new AbortController().signal` — a controller nothing could
 * abort — so a daemon stop left an in-flight poll read running to its 120s timeout. The landing now owns
 * one controller (as the lanes' PrLandHost does) and `stop()` cuts the read.
 */
describe("task PR landing stop signal", () => {
	test("stop() aborts the signal an in-flight poll read is running with", async () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "jabbu-g7-")));
		try {
			execFileSync("git", ["init", "-q", "-b", "main", repo]);
			const sha = "a".repeat(40);
			const row = {
				taskId: "T-20261127-07",
				status: "review",
				title: "stop signal",
				branch: "task/T-20261127-07",
				repo,
				worktree: repo,
				host: null,
				baseSha: sha,
				threadRef: "111:222",
				acceptance: [],
				land: {
					mode: "pr",
					state: "active",
					requestedBy: "owner",
					sha,
					baseBranch: "main",
					prLand: { step: "pr-created", number: 2, slug: "acme/widgets", pushedSha: sha, pushedAt: 0 },
				},
			} as unknown as TaskRow;
			let seen: AbortSignal | undefined;
			let release: (() => void) | undefined;
			const called = new Promise<void>((resolve) => {
				release = resolve;
			});
			const tools: PrTools = {
				git: async () => ({ code: 0, stdout: "", stderr: "" }),
				gh: (_argv, options) => {
					seen = options.signal;
					release?.();
					// A read that only the abort ends: without it this promise never settles.
					return new Promise((resolve) => {
						options.signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "aborted" }), {
							once: true,
						});
					});
				},
			};
			const tasks = {
				get: () => row,
				isPaused: () => false,
				setLand: () => {},
			};
			const ctx = {
				options: { config: { lanes: { land: { [repo]: { mode: "pr" } } } }, prLand: { tools } },
				clock: { now: () => 1_000_000 },
				clockFormat: new Intl.DateTimeFormat("ko-KR"),
				log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
				channels: {},
				adapters: new Map(),
				frozen: () => undefined,
				store: { tasks },
				router: undefined,
				lanes: undefined,
				broker: undefined,
				wikiNotes: undefined,
				taskGates: undefined,
				lander: undefined,
				checkRunner: undefined,
				taskSweeper: undefined,
				requestIdleSweep: () => {},
			} as unknown as DaemonContext;
			const prLand = new DaemonTaskPrLand(ctx, new Set(), async () => []);
			const polling = prLand.poll(row);
			await called;
			expect(seen).toBeDefined();
			expect(seen?.aborted).toBe(false);
			prLand.stop();
			await polling;
			expect(seen?.aborted).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
