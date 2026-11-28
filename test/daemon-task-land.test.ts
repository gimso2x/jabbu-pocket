import { describe, expect, test } from "bun:test";
import type { DaemonContext } from "../src/daemon/daemon-context";
import { DaemonTaskLanding } from "../src/daemon/daemon-task-land";
import type { ProcessRunner } from "../src/dispatch/omp";
import type { TaskRow } from "../src/tasks/ledger";

/** `closeTaskAgent` with a removed dispatch host: the guard, not the throw. */
describe("closeTaskAgent", () => {
	const row = (host: string | null) =>
		({ taskId: "T-1", host, agent: "t-1", runtime: "herdr", status: "done" }) as unknown as TaskRow;
	const landing = (config: Record<string, unknown>, run?: ProcessRunner) =>
		new DaemonTaskLanding({
			options: { config, ...(run === undefined ? {} : { herdrRun: run }) },
			log: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as DaemonContext);

	test("a removed host is skipped, not thrown (afterDone never throws)", async () => {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
		};
		const closed = await landing({ dispatchHosts: {}, herdr: {} }, run).closeTaskAgent(row("gone-host"));
		expect(closed).toBeUndefined();
		expect(calls).toEqual([]); // no records commit, no herdr call: the guard runs first
	});

	test("a configured host still closes over ssh; a local row with herdr off is skipped", async () => {
		const calls: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			calls.push(cmd);
			return { code: 0, stdout: JSON.stringify({ result: { agents: [] } }), timedOut: false };
		};
		const kept = await landing(
			{ dispatchHosts: { box1: { ssh: "box1" } }, herdr: {}, workspaceDir: "/tmp" },
			run,
		).closeTaskAgent(row("box1"));
		expect(kept).toBeUndefined();
		expect(calls.some((cmd) => cmd.includes("box1"))).toBe(true);
		const local = await landing({ dispatchHosts: {}, herdr: undefined }, run).closeTaskAgent(row(null));
		expect(local).toBeUndefined();
	});
});
