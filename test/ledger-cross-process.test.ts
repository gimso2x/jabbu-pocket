import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskLedger } from "../src/tasks/ledger";

// Persona: the owner runs `tasks pause` / `tasks cancel` in a shell while the daemon registers a new task.
// Two processes share one WAL database. A deferred BEGIN that reads, then writes, fails at once with
// SQLITE_BUSY(_SNAPSHOT) when the other process committed in between; busy_timeout does not wait for that upgrade.
test("a daemon registering tasks and a CLI pausing one never fail each other (two processes, one ledger)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-xproc-"));
	try {
		const path = join(dir, "jabbu.db");
		const seed = openTaskLedger(path, "Asia/Seoul");
		const victim = seed.register({
			title: "victim",
			risk: "L2",
			originKey: "o",
			threadRef: "D1:1",
			host: "h",
			repo: "/r",
			acceptance: [],
		} as never);
		seed.close();
		const child = join(import.meta.dir, "fixtures", "ledger-writer-child.ts");
		const run = (...args: string[]) =>
			Bun.spawn([process.execPath, child, path, ...args], { stdout: "pipe", stderr: "pipe" });
		const [a, b] = [run("register", "150"), run("pause", "150", victim.taskId)];
		const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
		await Promise.all([a.exited, b.exited]);
		const ra = JSON.parse(outA.trim()) as { ok: number; failures: string[] };
		const rb = JSON.parse(outB.trim()) as { ok: number; failures: string[] };
		expect(ra.failures).toEqual([]);
		expect(rb.failures).toEqual([]);
		const check = openTaskLedger(path, "Asia/Seoul");
		expect(check.list().length).toBe(1 + 150);
		check.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
