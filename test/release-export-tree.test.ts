import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, makeRepo } from "./helpers/git-fixtures";

/**
 * The public tree `release/export.ts` builds from HEAD must carry the public CI files and pass the public CI
 * commands on its own. `release/` is absent from the exported tree, so this file skips there; unlike the other
 * release tests it does not skip without gitleaks (the export's leak gate needs it, so a missing scanner fails).
 */
const REPO = resolve(import.meta.dir, "..");
const EXPORT = join(REPO, "release", "export.ts");

interface ExportModule {
	exportRelease(options: {
		ref: string;
		to: string;
		repo?: string;
		main?: string;
		installCheck?: (tree: string, print: (line: string) => void) => Promise<boolean>;
		print?: (line: string) => void;
	}): Promise<number>;
}

// Dynamic import: release/ is absent from the exported public tree, where a static import would break tsc.
const mod = existsSync(EXPORT) ? ((await import(EXPORT)) as ExportModule) : undefined;
if (mod === undefined) console.log("[skip] release-export-tree.test.ts: release/export.ts is not in this tree");

const EXPORT_TEST_TIMEOUT_MS = 30_000;
const CI_COMMANDS_TIMEOUT_MS = 180_000;

const scratch: string[] = [];
let tree = "";
let exportOut = "";
let exportCode = -1;

beforeAll(async () => {
	if (mod === undefined) return;
	const dir = makeRepo(scratch, "jabbu-release-tree-");
	git(dir, "config", "user.name", "release");
	git(dir, "config", "user.email", "release@example.com");
	const lines: string[] = [];
	exportCode = await mod.exportRelease({
		ref: "HEAD",
		to: dir,
		repo: REPO,
		main: "HEAD",
		installCheck: async () => true,
		print: (line) => lines.push(line),
	});
	exportOut = lines.join("\n");
	tree = dir;
}, 120_000);

afterAll(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listFiles(root: string, rel = ""): string[] {
	return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === ".git") return [];
		const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
		return entry.isDirectory() ? listFiles(root, path) : [path];
	});
}

// release/ is not in the exported public tree: there is nothing to export, so these suites are not registered.
if (mod !== undefined) {
	describe("exported public tree", () => {
		test(
			"exports allowlisted public files",
			() => {
				expect({ code: exportCode, out: exportOut.split("\n").slice(-3) }).toMatchObject({ code: 0 });
				for (const path of [
					".github/workflows/ci.yml",
					".github/actions/setup/action.yml",
					".github/pull_request_template.md",
					"knip.json",
					"AGENTS.md",
					"docs/how-it-works-dark.svg",
					"docs/how-it-works-light.svg",
				])
					expect(existsSync(join(tree, path)), path).toBe(true);
				const files = listFiles(tree);
				expect(files.filter((path) => /^(doc|docs\/tasks|release|archive)\//.test(path))).toEqual([]);
			},
			EXPORT_TEST_TIMEOUT_MS,
		);

		test(
			".github is public-safe",
			() => {
				const files = listFiles(join(tree, ".github")).map((path) => `.github/${path}`);
				expect(files.length).toBeGreaterThan(0);
				for (const file of files) {
					const text = readFileSync(join(tree, file), "utf8");
					for (const word of ["secrets.", "self-hosted", "/home/", "doc/", "records-private"])
						expect(text.toLowerCase().includes(word), `${file}: ${word}`).toBe(false);
				}
			},
			EXPORT_TEST_TIMEOUT_MS,
		);

		test(
			"CI commands pass in the exported tree",
			() => {
				symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
				for (const args of [
					["run", "check"],
					["run", "knip"],
					["test", "test/ci-workflow.test.ts"],
				]) {
					const result = Bun.spawnSync(["bun", ...args], { cwd: tree, stdout: "pipe", stderr: "pipe" });
					const out = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-30).join("\n");
					expect({ args, code: result.exitCode, out: result.exitCode === 0 ? "" : out }).toEqual({
						args,
						code: 0,
						out: "",
					});
				}
			},
			CI_COMMANDS_TIMEOUT_MS,
		);
	});

	// Account name pieces: this file is allowlisted, so the denylist gate would block the literal name.
	const ACCOUNT = ["gimso", "2x"].join("");
	const PASS = [
		`https://github.com/${ACCOUNT}/jabbu-pocket`,
		`git@github.com:${ACCOUNT}/jabbu-pocket.git`,
		`github.com/${ACCOUNT}/jabbu-pocket/issues`,
		`https://github.com/${ACCOUNT}/jabbu-pocket.git`,
		`See https://github.com/${ACCOUNT}/jabbu-pocket.`,
	];
	const BLOCK = [
		ACCOUNT,
		`${ACCOUNT}/records-private`,
		`github.com/${ACCOUNT}/records-private`,
		`https://github.com/${ACCOUNT}/records-private`,
		`git@github.com:${ACCOUNT}/records-private.git`,
		`${ACCOUNT}/jabbu-pocket.private`,
		`ssh://${ACCOUNT}/jabbu-pocket`,
		`/home/${ACCOUNT}/jabbu-pocket`,
		`herdr.${ACCOUNT}.com`,
		`${ACCOUNT}/jabbu-pocket-x`,
		`https://github.com/${ACCOUNT}/jabbu-pocket-x`,
		`https://github.com/${ACCOUNT}/jabbu-pocket.private`,
		`evilgithub.com/${ACCOUNT}/jabbu-pocket`,
		`evil.github.com/${ACCOUNT}/jabbu-pocket`,
		`my-github.com/${ACCOUNT}/jabbu-pocket`,
	];

	describe("denylist allows only the public repository address", () => {
		const denylistPath = join(REPO, "release", "denylist.txt");
		const patterns = existsSync(denylistPath)
			? readFileSync(denylistPath, "utf8")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "" && !line.startsWith("#"))
					.map((source) => new RegExp(source, "i"))
			: [];
		const hits = (text: string) => patterns.some((pattern) => pattern.test(text));

		test.each(PASS)("passes %s", (sample) => {
			expect(hits(sample)).toBe(false);
		});
		test.each(BLOCK)("blocks %s", (sample) => {
			expect(hits(sample)).toBe(true);
		});
	});
}
