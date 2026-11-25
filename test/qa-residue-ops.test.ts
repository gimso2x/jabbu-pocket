import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsCommand } from "../src/cli/skills";
import { resolveRestoreSource } from "../src/ops/restore";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("qa-aa 9: restore source with a rollback journal", () => {
	test("a `-journal` beside the source is refused like a `-wal`", () => {
		const home = tmp("jabbu-restore-journal-");
		const source = join(home, "x.db");
		writeFileSync(source, "x");
		writeFileSync(`${source}-journal`, "j");
		expect(() => resolveRestoreSource(home, source)).toThrow("-journal");
	});
});

describe("qa-aa 31: skills rollback with extra names", () => {
	test("a second name is a usage error, not silently dropped", () => {
		const root = tmp("jabbu-skills-extra-");
		expect(skillsCommand(["rollback", "a", "b"], { JABBU_TEST_HOOKS: "1", JABBU_SKILLS_DIR: root })).toBe(2);
	});
});
