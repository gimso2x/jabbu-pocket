import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskLedger } from "../src/tasks/ledger";
import { migrateTaskSchema } from "../src/tasks/ledger-schema";

interface ChildTalk {
	stdout: string;
	stderr: string;
	code: number;
}

/** A child's whole output and how it ended, read before the exit code so nothing is lost with the pipe. */
async function collect(child: {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}): Promise<ChildTalk> {
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

/** The child's `{ok, failures}` line. A child that died before printing names what it left on stderr — the JSON read
 * alone would only say "Unexpected EOF" and hide the reason it died at open. */
function resultOf(talk: ChildTalk, what: string): { ok: number; failures: string[] } {
	if (talk.code !== 0 || talk.stdout.trim() === "") {
		throw new Error(`${what} child printed no result (exit ${talk.code}): ${talk.stderr.trim().slice(-1200)}`);
	}
	return JSON.parse(talk.stdout.trim()) as { ok: number; failures: string[] };
}

const victimTask = {
	title: "victim",
	risk: "L2",
	originKey: "o",
	threadRef: "D1:1",
	host: "h",
	repo: "/r",
	acceptance: [],
} as never;

// Persona: the owner runs `tasks pause` / `tasks cancel` in a shell while the daemon registers a new task.
// Two processes share one WAL database. A deferred BEGIN that reads, then writes, fails at once with
// SQLITE_BUSY(_SNAPSHOT) when the other process committed in between; busy_timeout does not wait for that upgrade.
test("a daemon registering tasks and a CLI pausing one never fail each other (two processes, one ledger)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-xproc-"));
	try {
		const path = join(dir, "jabbu.db");
		const seed = openTaskLedger(path, "Asia/Seoul");
		const victim = seed.register(victimTask);
		seed.close();
		const child = join(import.meta.dir, "fixtures", "ledger-writer-child.ts");
		const run = (...args: string[]) =>
			Bun.spawn([process.execPath, child, path, ...args], { stdout: "pipe", stderr: "pipe" });
		const [a, b] = [run("register", "150"), run("pause", "150", victim.taskId)];
		const [talkA, talkB] = await Promise.all([collect(a), collect(b)]);
		const ra = resultOf(talkA, "register");
		const rb = resultOf(talkB, "pause");
		expect(ra.failures).toEqual([]);
		expect(rb.failures).toEqual([]);
		expect([ra.ok, rb.ok]).toEqual([150, 150]);
		const check = openTaskLedger(path, "Asia/Seoul");
		expect(check.list().length).toBe(1 + 150);
		check.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

async function spawnLockHolder(path: string, holdMs = 1000): Promise<() => Promise<void>> {
	const holder = Bun.spawn(
		[process.execPath, join(import.meta.dir, "fixtures", "ledger-lock-child.ts"), path, String(holdMs)],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = holder.stdout.getReader();
	const first = await reader.read();
	reader.releaseLock();
	expect(new TextDecoder().decode(first.value)).toContain("locked");
	return async () => {
		const code = await holder.exited;
		const stderr = await new Response(holder.stderr).text();
		if (code !== 0) throw new Error(`lock holder exited ${code}: ${stderr.trim().slice(-1200)}`);
	};
}

// Persona: the owner's CLI opens the ledger while another jabbu process holds the file — what a WAL recovery (a crash,
// a killed daemon) or a plain writer holds it for. The open's first statement has to wait out that lock; answering
// SQLITE_BUSY at once kills the CLI before it ever reaches a transaction (`openTaskLedger` sets busy_timeout first).
test("an open waits for another process's write lock instead of failing with SQLITE_BUSY", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-xproc-lock-"));
	try {
		const path = join(dir, "jabbu.db");
		const fresh = new Database(path, { create: true, strict: true });
		migrateTaskSchema(fresh); // an older ledger still in rollback-journal mode: nothing has switched it to WAL yet
		fresh.close();
		const finishHolder = await spawnLockHolder(path);
		const ledger = openTaskLedger(path, "Asia/Seoul");
		await finishHolder();
		expect(ledger.list()).toEqual([]);
		expect(ledger.register(victimTask).status).toBe("working");
		ledger.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

test("a readonly open also waits for another process's write lock instead of failing with SQLITE_BUSY", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-xproc-ro-lock-"));
	try {
		const path = join(dir, "jabbu.db");
		const fresh = new Database(path, { create: true, strict: true });
		migrateTaskSchema(fresh);
		fresh.close();
		const finishHolder = await spawnLockHolder(path);
		const ledger = openTaskLedger(path, "Asia/Seoul", undefined, { readonly: true });
		await finishHolder();
		expect(ledger.list()).toEqual([]);
		ledger.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);
