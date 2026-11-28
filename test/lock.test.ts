import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, currentBootId, holderAlive, LockHeldError, pidAlive } from "../src/daemon/lock";
import { processStartedAt } from "../src/daemon/proc-start";

// The stale-lock reclaim is serialized by an exclusive `<lock>.reclaim` barrier.

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-lock-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A lock left by an earlier boot: stale whatever its pid is. */
function staleLock(path: string): void {
	writeFileSync(path, JSON.stringify({ pid: process.pid, bootId: "some-earlier-boot", startedAt: 1 }));
}

describe("a directory at the lock path", () => {
	test("an old directory is refused with LockHeldError naming the path and is left in place", () => {
		const path = join(dir, "jabbu.lock");
		mkdirSync(path);
		const old = new Date("2020-01-01T00:00:00Z");
		utimesSync(path, old, old);
		let thrown: unknown;
		try {
			acquireLock(path);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(LockHeldError);
		expect((thrown as LockHeldError).message).toContain(path);
		expect(statSync(path).isDirectory()).toBe(true);
	});
});

describe("staged lock files", () => {
	test("acquire removes a staged file left by a dead starter, and keeps a live starter's", async () => {
		const path = join(dir, "jabbu.lock");
		const probe = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
		await probe.exited;
		const deadPid = probe.pid;
		expect(pidAlive(deadPid)).toBe(false);
		const deadStaged = `${path}.${deadPid}.00000000-0000-4000-8000-000000000000.tmp`;
		const liveStaged = `${path}.${process.pid}.00000000-0000-4000-8000-000000000001.tmp`;
		writeFileSync(deadStaged, "{}");
		writeFileSync(liveStaged, "{}");
		const lock = acquireLock(path);
		expect(existsSync(deadStaged)).toBe(false);
		expect(existsSync(liveStaged)).toBe(true);
		lock.release();
		rmSync(liveStaged, { force: true });
	});

	test.skipIf(process.platform === "win32" || Bun.which("sh") === null)(
		"a failed staged write leaves no .tmp file behind",
		async () => {
			// `ulimit -f 0` makes the staged write fail with EFBIG (SIGXFSZ ignored): the bug left the file.
			const path = join(dir, "jabbu.lock");
			const childFile = join(dir, "child.ts");
			writeFileSync(
				childFile,
				[
					`import { acquireLock } from ${JSON.stringify(resolve(import.meta.dir, "../src/daemon/lock.ts"))};`,
					`import { readdirSync } from "node:fs";`,
					"let error = '';",
					`try { acquireLock(${JSON.stringify(path)}); } catch (e) { error = String(e); }`,
					`console.log(JSON.stringify({ error, staged: readdirSync(${JSON.stringify(dir)}).filter((n) => n.endsWith(".tmp")) }));`,
					"",
				].join("\n"),
			);
			const child = Bun.spawn(
				["sh", "-c", `trap "" XFSZ; ulimit -f 0; exec "${process.execPath}" ${JSON.stringify(childFile)}`],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
			await child.exited;
			expect(err).toBe("");
			const result = JSON.parse(out) as { error: string; staged: string[] };
			expect(result.error).toContain("EFBIG");
			expect(result.staged).toEqual([]);
		},
	);

	test.skipIf(process.platform === "win32" || Bun.which("nice") === null)(
		"three lost races throw LockHeldError, not a bare lock_unavailable",
		async () => {
			const path = join(dir, "jabbu.lock");
			const module = resolve(import.meta.dir, "../src/daemon/lock.ts");
			// A spoiler that re-plants a stale lock (earlier boot) as fast as it is reclaimed, so every link hits EEXIST.
			const spoilerCode = `
			import { existsSync, writeFileSync } from "node:fs";
			const content = JSON.stringify({ pid: process.pid, bootId: "some-earlier-boot", startedAt: 1 });
			for (;;) {
				if (!existsSync(${JSON.stringify(path)})) {
					try { writeFileSync(${JSON.stringify(path)}, content, { flag: "wx" }); } catch {}
				}
			}
		`;
			// The acquirer runs niced down: on a small machine the spoiler would otherwise starve mid-race and the
			// acquirer would win a link. With the spoiler preferred, every attempt loses the race.
			const acquirerCode = `
			import { acquireLock } from ${JSON.stringify(module)};
			import { existsSync } from "node:fs";
			const started = Date.now();
			while (!existsSync(${JSON.stringify(path)})) {
				if (Date.now() - started > 5_000) throw new Error("spoiler never planted the lock");
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			let thrown: { name: string; message: string } | null = null;
			for (let round = 0; round < 5 && thrown === null; round++) {
				try { acquireLock(${JSON.stringify(path)}).release(); }
				catch (error) { thrown = { name: (error as Error).name, message: (error as Error).message }; }
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			console.log(JSON.stringify({ thrown }));
		`;
			const spoiler = Bun.spawn([process.execPath, "-e", spoilerCode], { stdout: "ignore", stderr: "ignore" });
			try {
				const acquirer = Bun.spawn(["nice", "-n", "19", process.execPath, "-e", acquirerCode], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [out, err] = await Promise.all([
					new Response(acquirer.stdout).text(),
					new Response(acquirer.stderr).text(),
				]);
				await acquirer.exited;
				expect(err).toBe("");
				const { thrown } = JSON.parse(out) as { thrown: { name: string; message: string } | null };
				expect(thrown?.name).toBe("LockHeldError");
				expect(thrown?.message).toContain("already_running");
			} finally {
				spoiler.kill();
				await spoiler.exited;
			}
		},
		20_000,
	);
});

describe("holderAlive with a recorded start time", () => {
	/** Off Linux `/proc/<pid>/stat` is unreadable and liveness falls back to the pid alone. */
	const procStartAvailable = processStartedAt(process.pid) !== undefined;

	test.skipIf(!procStartAvailable)("a live pid that started after the lock was written is not the holder", () => {
		expect(holderAlive(process.pid, currentBootId(), () => true, currentBootId(), 1)).toBe(false);
		expect(holderAlive(process.pid, currentBootId(), () => true, currentBootId(), Date.now())).toBe(true);
	});

	test("without a recorded start time the pid alone still decides", () => {
		expect(holderAlive(process.pid, currentBootId(), () => true, currentBootId())).toBe(true);
		expect(holderAlive(process.pid, currentBootId(), () => false, currentBootId())).toBe(false);
		expect(holderAlive(process.pid, "some-earlier-boot", () => true, currentBootId())).toBe(false);
	});
});

describe("stale lock with a reused pid", () => {
	const procStartAvailable = processStartedAt(process.pid) !== undefined;

	test.skipIf(!procStartAvailable)("a lock naming a live pid that started after the lock is stale", async () => {
		const path = join(dir, "jabbu.lock");
		const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		try {
			expect(processStartedAt(sleeper.pid)).not.toBeUndefined();
			// The pid was reused after the lock was written: the holder died uncleanly, another process took its pid.
			writeFileSync(
				path,
				JSON.stringify({ pid: sleeper.pid, bootId: currentBootId(), startedAt: Date.now() - 3_600_000 }),
			);
			const lock = acquireLock(path);
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid });
			lock.release();
			// Control: the same live pid with a lock written after it started is still the holder.
			writeFileSync(path, JSON.stringify({ pid: sleeper.pid, bootId: currentBootId(), startedAt: Date.now() }));
			expect(() => acquireLock(path)).toThrow(LockHeldError);
		} finally {
			sleeper.kill();
			await sleeper.exited;
		}
	});
});

describe("stale lock reclaim", () => {
	test("a reclaim barrier left by another starter refuses at once and leaves the stale lock in place", () => {
		const path = join(dir, "jabbu.lock");
		staleLock(path);
		writeFileSync(`${path}.reclaim`, "");
		let refused: unknown;
		try {
			acquireLock(path);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(LockHeldError);
		expect(String(refused)).toContain(`${path}.reclaim`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ bootId: "some-earlier-boot" });
		expect(existsSync(`${path}.reclaim`)).toBe(true);
	});

	test("a reclaim takes the stale lock and removes its barrier", () => {
		const path = join(dir, "jabbu.lock");
		staleLock(path);
		const lock = acquireLock(path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid, bootId: currentBootId() });
		expect(existsSync(`${path}.reclaim`)).toBe(false);
		lock.release();
		expect(existsSync(path)).toBe(false);
	});

	test("starters racing over one stale lock: exactly one holds it", async () => {
		const path = join(dir, "jabbu.lock");
		staleLock(path);
		const module = resolve(import.meta.dir, "../src/daemon/lock.ts");
		// Each starter reports once, then holds (or not) until its stdin closes, so no winner releases before all reported.
		const code = `
			import { acquireLock } from ${JSON.stringify(module)};
			let lock;
			try { lock = acquireLock(${JSON.stringify(path)}); console.log("held"); } catch { console.log("refused"); }
			for await (const _ of Bun.stdin.stream()) {}
			lock?.release();
		`;
		const starters = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, "-e", code], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
		);
		const reports = await Promise.all(
			starters.map(async (child) => {
				const reader = child.stdout.getReader();
				let text = "";
				while (!text.includes("\n")) {
					const { value, done } = await reader.read();
					if (done) break;
					text += new TextDecoder().decode(value);
				}
				reader.releaseLock();
				return text.trim();
			}),
		);
		for (const child of starters) child.stdin.end();
		await Promise.all(starters.map((child) => child.exited));
		expect(reports.filter((report) => report === "held")).toHaveLength(1);
		expect(reports.filter((report) => report === "refused")).toHaveLength(starters.length - 1);
	});
});
