import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsCommand } from "../src/cli/skills";
import { readSkillLock, type SkillVerifyResult, verifySkillLock, writeSkillLock } from "../src/review/skill-lock";
import { runCliCapture } from "./helpers/daemon-process";

let dir: string;
let skillsDir: string;
let homeDir: string;
let lockPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-skill-lock-"));
	skillsDir = join(dir, "managed-skills");
	homeDir = join(dir, "jabbu-home");
	lockPath = join(homeDir, "skills.lock.json");
	mkdirSync(skillsDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, files: Record<string, string>): void {
	const base = join(skillsDir, name);
	mkdirSync(base, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(base, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, { mode: 0o600 });
	}
}

function captureOutput(fn: () => number): { code: number; stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: fn(), stdout, stderr };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

describe("skill-lock integrity and risk scan", () => {
	test("pins checksums, skips revisions/_archived/.git, and verifies clean round-trip", () => {
		writeSkill("alpha", {
			"SKILL.md": "---\nname: alpha\n---\n\nCheck `git status` only.\n",
			"scripts/run.sh": "#!/bin/sh\necho ok\n",
			"revisions/2026-11-27T00-00-00-000Z.md": "old\n",
		});
		writeSkill("_archived", { "stale/SKILL.md": "ignored\n" });
		writeSkill(".git", { config: "ignored\n" });

		const lock = writeSkillLock(skillsDir, lockPath, () => Date.UTC(2026, 10, 27, 0, 0, 0));
		expect(lock.version).toBe(1);
		expect(Object.keys(lock.files)).toEqual(["alpha/SKILL.md", "alpha/scripts/run.sh"]);
		expect(statSync(lockPath).mode & 0o777).toBe(0o600);
		expect(readSkillLock(lockPath)).toEqual(lock);

		const verified = verifySkillLock(skillsDir, lockPath);
		expect(verified.ok).toBe(true);
		expect(verified.added).toEqual([]);
		expect(verified.modified).toEqual([]);
		expect(verified.removed).toEqual([]);
		expect(verified.symlinks).toEqual([]);
		expect(verified.warnings).toEqual([]);
	});

	test("files over 64 KiB are still scanned on their head; content past the cap is the documented residual", () => {
		const filler = "filler line\n".repeat(6000); // ~72 KiB
		writeSkill("big-head", { "SKILL.md": `safe line\nrm -rf /\n${filler}` });
		writeSkill("big-tail", { "SKILL.md": `${filler}rm -rf /\n` });
		writeSkillLock(skillsDir, lockPath);

		const verified = verifySkillLock(skillsDir, lockPath);
		expect(verified.ok).toBe(true);
		// The danger on line 2 of a >64 KiB file is now reported; the one past the 64 KiB cap is not.
		expect(verified.warnings.map((w) => [w.path, w.rule])).toEqual([["big-head/SKILL.md", "rm_rf_absolute"]]);

		// And --strict now fails on the head danger instead of passing a dangerous skill.
		const env = { JABBU_HOME: homeDir, JABBU_TEST_HOOKS: "1", JABBU_SKILLS_DIR: skillsDir };
		const strict = captureOutput(() => skillsCommand(["verify", "--strict", "--json"], env));
		expect(strict.code).toBe(1);
		expect((JSON.parse(strict.stdout) as SkillVerifyResult).warnings).toHaveLength(1);
	});

	test("detects added, modified, and removed skill files", () => {
		writeSkill("alpha", { "SKILL.md": "v1\n" });
		writeSkill("beta", { "SKILL.md": "v1\n" });
		writeSkillLock(skillsDir, lockPath);

		writeSkill("alpha", { "SKILL.md": "v2\n", "extra.md": "new\n" });
		rmSync(join(skillsDir, "beta", "SKILL.md"));

		const verified = verifySkillLock(skillsDir, lockPath);
		expect(verified.ok).toBe(false);
		expect(verified.added).toEqual(["alpha/extra.md"]);
		expect(verified.modified).toEqual(["alpha/SKILL.md"]);
		expect(verified.removed).toEqual(["beta/SKILL.md"]);
	});

	test("refuses symlinks inside skill tree and refuses symlinked lockfiles", () => {
		const outside = join(dir, "outside.txt");
		writeFileSync(outside, "secret");
		writeSkill("alpha", { "SKILL.md": "ok\n" });
		symlinkSync(outside, join(skillsDir, "alpha", "link.md"));

		expect(() => writeSkillLock(skillsDir, lockPath)).toThrow("symbolic link");

		rmSync(join(skillsDir, "alpha", "link.md"));
		writeSkillLock(skillsDir, lockPath);
		symlinkSync(outside, join(skillsDir, "alpha", "link.md"));
		const verified = verifySkillLock(skillsDir, lockPath);
		expect(verified.ok).toBe(false);
		expect(verified.symlinks).toEqual(["alpha/link.md"]);

		rmSync(join(skillsDir, "alpha", "link.md"));
		const symlinkLock = join(homeDir, "sym.lock.json");
		symlinkSync(outside, symlinkLock);
		expect(() => writeSkillLock(skillsDir, symlinkLock)).toThrow("symbolic link");
		expect(() => readSkillLock(symlinkLock)).toThrow("symbolic link");
		expect(readFileSync(outside, "utf8")).toBe("secret");
	});

	test("reports high-risk commands as warnings while ignoring forbidden clauses", () => {
		writeSkill("safe", { "SKILL.md": "rm -rf / 금지\n" });
		writeSkill("risky", { "SKILL.md": "cleanup:\nrm -rf /\ncat ~/.jabbu/secrets/discord.json\n" });
		writeSkillLock(skillsDir, lockPath);

		const verified = verifySkillLock(skillsDir, lockPath);
		expect(verified.ok).toBe(true);
		expect(verified.warnings.map((w) => [w.path, w.rule])).toEqual([
			["risky/SKILL.md", "rm_rf_absolute"],
			["risky/SKILL.md", "secret_path"],
		]);
	});
});

describe("skills lock and verify CLI", () => {
	test("supports lock, verify, --json, --strict, missing lockfile, usage errors, and rollback", async () => {
		writeSkill("demo", { "SKILL.md": "clean\n" });
		const env = { JABBU_HOME: homeDir, JABBU_TEST_HOOKS: "1", JABBU_SKILLS_DIR: skillsDir };

		const missing = captureOutput(() => skillsCommand(["verify"], env));
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("lockfile not found");

		const locked = captureOutput(() => skillsCommand(["lock", "--json"], env));
		expect(locked.code).toBe(0);
		expect(Object.keys((JSON.parse(locked.stdout) as { files: Record<string, unknown> }).files)).toEqual([
			"demo/SKILL.md",
		]);

		const ok = captureOutput(() => skillsCommand(["verify"], env));
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("skill_verify ok=true locked=1 current=1");

		// High-risk content pinned: default verify passes, --strict fails
		writeSkill("risky", { "SKILL.md": "cat ~/.jabbu/secrets/token\n" });
		expect(captureOutput(() => skillsCommand(["lock"], env)).code).toBe(0);
		expect(captureOutput(() => skillsCommand(["verify"], env)).code).toBe(0);
		const strictFail = captureOutput(() => skillsCommand(["verify", "--strict", "--json"], env));
		expect(strictFail.code).toBe(1);
		const parsed = JSON.parse(strictFail.stdout) as SkillVerifyResult & { strict: boolean; passed: boolean };
		expect(parsed.ok).toBe(true);
		expect(parsed.strict).toBe(true);
		expect(parsed.passed).toBe(false);
		expect(parsed.warnings).toHaveLength(1);

		// Extra positional argument returns exit 2
		const badArgs = captureOutput(() => skillsCommand(["verify", "extra"], env));
		expect(badArgs.code).toBe(2);
		expect(badArgs.stderr).toContain("skills verify");

		// Help / subprocess check & rollback non-regression
		const helpRes = await runCliCapture(homeDir, ["--help"]);
		expect(helpRes.code).toBe(0);
		expect(helpRes.stderr).toContain("skills lock");
		expect(helpRes.stderr).toContain("skills verify");
	});
});
