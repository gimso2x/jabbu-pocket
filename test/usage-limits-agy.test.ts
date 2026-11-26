import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../src/dispatch/omp";
import { clampPct, collectAgyAccounts, parseAgy } from "../src/dashboard/usage-limits-agy";

const ARGV = ["agy", "-p", "/usage"];

/** One account dir per test, removed afterwards. */
const dirs: string[] = [];
function accountsDir(order: string, tokens: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-usage-test-"));
	dirs.push(dir);
	writeFileSync(join(dir, "order"), order);
	for (const [name, body] of Object.entries(tokens)) writeFileSync(join(dir, `${name}.token`), body);
	return dir;
}
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A runner that answers from a table keyed by the token file it finds under its isolated HOME. */
function runnerByToken(table: Record<string, { code: number; stdout: string; stderr?: string; timedOut?: boolean }>): {
	run: ProcessRunner;
	homes: string[];
} {
	const homes: string[] = [];
	const run: ProcessRunner = async (_cmd, opts) => {
		const home = opts?.env?.HOME ?? "";
		homes.push(home);
		const token = existsSync(join(home, ".gemini/antigravity-cli/antigravity-oauth-token"))
			? String(Bun.file(join(home, ".gemini/antigravity-cli/antigravity-oauth-token")).size)
			: "";
		const found = table[token];
		if (found === undefined) return { code: 1, stdout: "", stderr: `no token ${token}`, timedOut: false };
		return { code: found.code, stdout: found.stdout, stderr: found.stderr, timedOut: found.timedOut ?? false };
	};
	return { run, homes };
}

describe("parseAgy", () => {
	test("four-field lines become rows: 5h/weekly/other windows, reset times kept when parseable", () => {
		const rows = parseAgy(
			"gemini\tFive hour limit\t42%\t2026-11-26T20:00:00Z\n" +
				"gemini\tWeekly limit\t87.6%\tnot-a-date\n" +
				"claude\tSonnet quota\t0%\t\n",
		);
		expect(Array.isArray(rows)).toBe(true);
		if (typeof rows === "string") throw new Error(rows);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ label: "gemini", window: "5h", remainingPct: 42, resetsAt: Date.parse("2026-11-26T20:00:00Z") });
		expect(rows[1]).toMatchObject({ window: "weekly", remainingPct: 88 });
		expect(rows[1]?.resetsAt).toBeUndefined();
		expect(rows[2]).toMatchObject({ window: "other", remainingPct: 0 });
		expect(rows[2]?.resetsAt).toBeUndefined();
	});

	test("blank lines are skipped and CRLF endings are tolerated", () => {
		const rows = parseAgy("\r\n\ngemini\tFive hour limit\t10%\t\r\n\n");
		expect(Array.isArray(rows) && rows).toHaveLength(1);
	});

	test("a short or long line fails the whole source with its 1-based line number", () => {
		expect(parseAgy("gemini\tFive hour limit\t10%\tx\nbroken\tline")).toBe("2번째 줄 칸 수");
		expect(parseAgy("gemini\tFive hour limit\t10%\tx\tsurplus\tfield")).toBe("1번째 줄 칸 수");
		expect(parseAgy("gemini\tFive hour limit\t많음\tx")).toBe("1번째 줄 남은 %");
	});

	test("empty output is its own mismatch", () => {
		expect(parseAgy("\n  \n")).toBe("빈 출력");
	});

	test("clampPct bounds the percentage to 0..100 and 999% clamps to 100", () => {
		expect(clampPct(-5)).toBe(0);
		expect(clampPct(105)).toBe(100);
		const rows = parseAgy("g\tFive hour limit\t999%\tx");
		expect(Array.isArray(rows) && rows[0]?.remainingPct).toBe(100);
	});
});

describe("collectAgyAccounts", () => {
	test("no order file (or no valid names) means no agy section at all", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-usage-test-"));
		dirs.push(dir);
		expect(await collectAgyAccounts(ARGV, dir, undefined, async () => ({ code: 0, stdout: "", timedOut: false }))).toBeUndefined();
		const onlyBad = accountsDir("# comment\n../evil\na/b\nok-but-no-token\n", {});
		expect(await collectAgyAccounts(ARGV, onlyBad, undefined, async () => ({ code: 0, stdout: "", timedOut: false }))).toBeUndefined();
	});

	test("names failing ACCOUNT_NAME or lacking a token file are skipped; duplicates collapse", async () => {
		const dir = accountsDir("alpha\nalpha\n../evil\nbeta extra words\nmissing\n", {
			alpha: "A".repeat(12),
			beta: "B".repeat(12),
		});
		const { run, homes } = runnerByToken({
			"12": { code: 0, stdout: "g\tFive hour limit\t50%\tx" },
		});
		const result = await collectAgyAccounts(ARGV, dir, "alpha", run);
		expect(result?.accounts.map((a) => a.name)).toEqual(["alpha", "beta"]);
		expect(result?.account).toBe("alpha");
		// Both ran, each with its own isolated HOME that no longer exists after cleanup.
		expect(homes).toHaveLength(2);
		expect(new Set(homes).size).toBe(2);
		for (const home of homes) expect(existsSync(home)).toBe(false);
	});

	test("an account whose run times out is an error row, the others still answer", async () => {
		const dir = accountsDir("slow\nfast\n", { slow: "S".repeat(12), fast: "F".repeat(12) });
		const byContent: ProcessRunner = async (_cmd, opts) => {
			const home = opts?.env?.HOME ?? "";
			const token = await Bun.file(join(home, ".gemini/antigravity-cli/antigravity-oauth-token")).text();
			if (token.startsWith("S")) return { code: 0, stdout: "", timedOut: true };
			return { code: 0, stdout: "g\tWeekly limit\t70%\tx", timedOut: false };
		};
		const result = await collectAgyAccounts(ARGV, dir, undefined, byContent);
		const slow = result?.accounts.find((a) => a.name === "slow");
		const fast = result?.accounts.find((a) => a.name === "fast");
		expect(slow?.ok).toBe(false);
		if (slow !== undefined && !slow.ok) expect(slow.error).toContain("30초");
		expect(fast).toMatchObject({ ok: true, rows: [{ window: "weekly", remainingPct: 70 }] });
	});

	test("a nonzero exit reports the last stderr line; garbage output is a shape mismatch", async () => {
		const dir = accountsDir("broken\nweird\n", { broken: "K".repeat(12), weird: "W".repeat(12) });
		const run: ProcessRunner = async (_cmd, opts) => {
			const home = opts?.env?.HOME ?? "";
			const token = await Bun.file(join(home, ".gemini/antigravity-cli/antigravity-oauth-token")).text();
			if (token.startsWith("K")) return { code: 3, stdout: "", stderr: "noise\nquota endpoint down", timedOut: false };
			return { code: 0, stdout: "this is not the usage table", timedOut: false };
		};
		const result = await collectAgyAccounts(ARGV, dir, undefined, run);
		const broken = result?.accounts.find((a) => a.name === "broken");
		const weird = result?.accounts.find((a) => a.name === "weird");
		if (broken !== undefined && !broken.ok) expect(broken.error).toBe("종료 코드 3: quota endpoint down");
		if (weird !== undefined && !weird.ok) expect(weird.error).toContain("모양이 다름");
	});

	test("the order file's current marker falls back to the current file when no active name is passed", async () => {
		const dir = accountsDir("one\ntwo\n", { one: "1".repeat(12), two: "2".repeat(12) });
		writeFileSync(join(dir, "current"), "two\n");
		const run: ProcessRunner = async () => ({ code: 0, stdout: "g\tFive hour limit\t5%\tx", timedOut: false });
		const result = await collectAgyAccounts(ARGV, dir, undefined, run);
		expect(result?.account).toBe("two");
		expect(result?.accounts.find((a) => a.name === "two")?.active).toBe(true);
		expect(result?.accounts.find((a) => a.name === "one")?.active).toBeUndefined();
	});
});
