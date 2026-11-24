import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLaneCompletion, laneDiffUnreadRefusal } from "../src/lanes/integrity";
import { collectLaneDiff } from "../src/lanes/lane-diff";
import { LANE_DIFF_MAX_BYTES } from "../src/lanes/verify";

const roots: string[] = [];
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();

/** About `kb` kilobytes of distinct comment lines, with `extra` lines after them. */
const filler = (kb: number, tag: string, ...extra: string[]): string =>
	`${Array.from({ length: Math.ceil((kb * 1024) / 40) }, (_, i) => `// ${tag} filler line number ${i}`).join("\n")}\n${extra.map((line) => `${line}\n`).join("")}`;

/** A repository with one base commit; `lane(files)` commits the files and returns `{ dir, base, head }`. */
function repoWith(files: Record<string, string>, before: Record<string, string> = {}, rename?: [string, string]) {
	const dir = mkdtempSync(join(tmpdir(), "ompbot-lane-diff-"));
	roots.push(dir);
	git(dir, "init", "-q", "-b", "main");
	const write = (all: Record<string, string>) => {
		for (const [name, text] of Object.entries(all)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
	};
	write({ "README.md": "base\n", ...before });
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "base");
	const base = git(dir, "rev-parse", "HEAD");
	if (rename !== undefined) git(dir, "mv", rename[0], rename[1]);
	write(files);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "lane work");
	return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

const categories = (diff: string): string[] => classifyLaneCompletion({ summary: "done", diff }).map((r) => r.category);

describe("a diff past the output cap is read file by file (T-20261124-03 AC-4)", () => {
	test("(a) the whole is over 512KB but each file is under: no unread files, a late TODO is found", async () => {
		const { dir, base, head } = repoWith({
			"src/a.ts": filler(250, "a"),
			"src/b.ts": filler(250, "b"),
			"src/c.ts": filler(250, "c", "// TODO finish this"),
		});
		const { diff, unread } = await collectLaneDiff(dir, { baseSha: base }, head);
		expect(Buffer.byteLength(diff)).toBeGreaterThan(LANE_DIFF_MAX_BYTES);
		expect(unread).toEqual([]);
		expect(categories(diff)).toEqual(["unfinished_work_marker"]);
	});

	test("(b) one code file over 512KB is named as unread; another file's TODO is still found", async () => {
		const { dir, base, head } = repoWith({
			"src/huge.ts": filler(700, "huge"),
			"src/small.ts": "// TODO later\nexport const small = 1;\n",
		});
		const { diff, unread } = await collectLaneDiff(dir, { baseSha: base }, head);
		expect(unread).toEqual(["src/huge.ts"]);
		expect(categories(diff)).toEqual(["unfinished_work_marker"]);
		const refusal = laneDiffUnreadRefusal(unread);
		expect(refusal).toMatchObject({ category: "lane_diff_unavailable" });
		expect(refusal.excerpt).toBe("읽지 못한 파일 1개: src/huge.ts");
		expect(refusal.remedy).toContain("나눠 커밋");
	});

	test("(b) the excerpt names the first three unread files", () => {
		expect(laneDiffUnreadRefusal(["a", "b", "c", "d"]).excerpt).toBe("읽지 못한 파일 4개: a, b, c…");
	});

	test("(c) only non-code files are large: nothing unread, nothing refused", async () => {
		const { dir, base, head } = repoWith({
			"docs/big.md": filler(700, "md"),
			"bun.lock": filler(700, "lock"),
			"src/ok.ts": "export const ok = 1;\n",
		});
		const { diff, unread } = await collectLaneDiff(dir, { baseSha: base }, head);
		expect(unread).toEqual([]);
		expect(diff).toContain("+++ b/src/ok.ts");
		expect(diff).not.toContain("filler line");
		expect(categories(diff)).toEqual([]);
	});

	test("(d) a large diff with a renamed file that dropped its guard: the deleted line is read", async () => {
		const guarded = (name: string) => filler(150, name, 'if (!ok) throw new Error("bad input");');
		const { dir, base, head } = repoWith(
			{
				"src/new-name.ts": filler(150, "old"),
				"src/x.ts": filler(250, "x"),
				"src/y.ts": filler(250, "y"),
			},
			{ "src/old-name.ts": guarded("old") },
			["src/old-name.ts", "src/new-name.ts"],
		);
		const { diff, unread } = await collectLaneDiff(dir, { baseSha: base }, head);
		expect(unread).toEqual([]);
		expect(categories(diff)).toEqual(["guard_deletion_without_adversarial_regression"]);
	});

	test("the total limits stop the reading: the rest is unread by name", async () => {
		const { dir, base, head } = repoWith({
			"src/a.ts": filler(250, "a"),
			"src/b.ts": filler(250, "b"),
			"src/c.ts": filler(250, "c"),
		});
		const limits = { totalMaxBytes: 8 * 1024 * 1024, maxFiles: 1, totalMs: 60_000, now: () => 0 };
		const byFiles = await collectLaneDiff(dir, { baseSha: base }, head, undefined, limits);
		expect(byFiles.unread).toEqual(["src/b.ts", "src/c.ts"]);
		expect(byFiles.diff).toContain("+++ b/src/a.ts");
		const byBytes = await collectLaneDiff(dir, { baseSha: base }, head, undefined, {
			...limits,
			maxFiles: 9,
			totalMaxBytes: 300_000,
		});
		expect(byBytes.unread).toEqual(["src/b.ts", "src/c.ts"]);
		let tick = 0;
		const byTime = await collectLaneDiff(dir, { baseSha: base }, head, undefined, {
			...limits,
			maxFiles: 9,
			totalMs: 10,
			now: () => (tick++ === 0 ? 0 : 10),
		});
		expect(byTime.unread).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});
});
