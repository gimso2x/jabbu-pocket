// A `bin` entry that git does not track as executable makes `bun link`/`npm i -g` install a command the shell cannot
// run, and nothing else in the suite would notice: the file is there and its content is fine.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./helpers/git-fixtures";

const REPO_ROOT = join(import.meta.dir, "..");

/** `package.json` of this repository as parsed JSON (the real one, not a fixture). */
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
	bin?: Record<string, string>;
	scripts?: Record<string, string>;
};

/**
 * The mode git records for `path` (`100755`, `100644`, …). The release install check runs the suite in an exported
 * copy that is not a checkout of this history (no `.git`, or a fresh empty one), so there the file's own executable
 * bit stands in: the export copies files with their modes.
 */
function trackedMode(path: string): string {
	const entry = existsSync(join(REPO_ROOT, ".git")) ? git(REPO_ROOT, "ls-files", "-s", "--", path) : "";
	const mode = /^(\d{6}) /.exec(entry)?.[1];
	if (mode !== undefined) return mode;
	return (statSync(join(REPO_ROOT, path)).mode & 0o111) === 0 ? "100644" : "100755";
}

describe("every command this repository installs can be run", () => {
	// The `bin` map plus the runner the test script itself uses: a shell script git does not mark executable fails with
	// "Permission denied" on a fresh checkout, however right its content is.
	const executables = [...Object.values(pkg.bin ?? {}), "scripts/heavy-run"];

	for (const path of executables) {
		test(`${path} is tracked as executable`, () => {
			expect(trackedMode(path)).toBe("100755");
		});
	}

	test("package.json names src/main.ts as the ompbot and jabbu-pocket bins", () => {
		expect(pkg.bin).toEqual({ ompbot: "src/main.ts", "jabbu-pocket": "src/main.ts" });
	});
});
