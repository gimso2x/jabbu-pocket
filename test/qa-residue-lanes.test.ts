import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenChanges } from "../src/lanes/hidden-changes";
import { parseLaneTrigger } from "../src/lanes/trigger";

const sh = (cwd: string, cmd: string): void => {
	const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
};

describe("qa-y 41: core.fileMode=false", () => {
	test("an executable file the index holds as 100755 is not a hidden change when the mode is not tracked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-filemode-"));
		try {
			sh(
				dir,
				"git init -q . && git config user.email a@b && git config user.name n && printf x > build.sh && chmod 755 build.sh && git add build.sh && git commit -qm i && git config core.fileMode false && git update-index --assume-unchanged build.sh",
			);
			const git = async (args: string[]) => {
				const r = spawnSync("git", args, { encoding: "utf8" });
				return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
			};
			expect(await hiddenChanges(git, dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("qa-aa 27: trigger regex", () => {
	test("a long run of blanks after `작업:` that never becomes a trigger is refused in linear time", () => {
		const blanks = " ".repeat(4_000);
		const start = performance.now();
		// No path, a path glued to the title, a path on the next line: each took seconds with the title group `(.+?)`.
		for (const text of [`작업:${blanks}@x`, `작업:${blanks}x@/p`, `작업:${blanks}x\n @/p`]) {
			expect(parseLaneTrigger(text)).toBeUndefined();
		}
		expect(performance.now() - start).toBeLessThan(1_000);
	});

	test("leading blanks and a no-break space before the title still parse", () => {
		expect(parseLaneTrigger("작업:   로그인 고치기 @/r\n본문")).toEqual({
			title: "로그인 고치기",
			cwd: "/r",
			brief: "본문",
		});
		expect(parseLaneTrigger("작업:\u00a0제목 @/r")?.title).toBe("제목");
	});
});
