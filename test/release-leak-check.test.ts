import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLeaks, findGitleaks, type LeakCheckResult, secretPathHits } from "../src/release/leak-check";
import { git, makeRepo } from "./helpers/git-fixtures";

// Planted denylist marker (not an owner identifier: the real denylist is never read here).
const PLANTED = "planted-owner-marker-7310";
// The Cataly provenance marker, assembled so this file does not carry it.
const MARKER = ["Ported", "from", `${"vntrevx"}/${"Cataly"} x.ts@0 (SUL-1.0)`].join(" ");
const gitleaks = findGitleaks();
// Real git and gitleaks per test.
const TIMEOUT_MS = 30_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository on `main` with a denylist file beside it; `base` is the commit the range starts from. */
function fixture(): { repo: string; base: string; denylistFile: string } {
	const repo = makeRepo(dirs, "jabbu-leak-");
	const records = mkdtempSync(join(tmpdir(), "jabbu-leak-records-"));
	dirs.push(records);
	const denylistFile = join(records, "denylist.txt");
	writeFileSync(denylistFile, `# planted\n${PLANTED}\n`);
	return { repo, base: git(repo, "rev-parse", "HEAD"), denylistFile };
}

function commit(repo: string, files: Record<string, string>, message = "change", ...config: string[]): string {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "add", "-A");
	git(repo, ...config, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

async function check(
	f: { repo: string; base: string; denylistFile: string },
	sha: string,
	texts?: Record<string, string>,
): Promise<LeakCheckResult> {
	return checkLeaks({ repo: f.repo, base: f.base, sha, denylistFile: f.denylistFile, gitleaks, texts });
}

/** The hits of a failed check; the planted text is nowhere in the result. */
function hitsOf(result: LeakCheckResult): string[] {
	expect(JSON.stringify(result)).not.toContain(PLANTED);
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.hits;
}

describe("secretPathHits", () => {
	test("credential names and odd characters, not their look-alikes", () => {
		const paths = ["a/.env", ".env.local", "k/id_ed25519.pub", "x.pem", "auth.json", "a\\b", "c:d", ".env.example"];
		expect(secretPathHits([...paths, "src/env.ts", "docs/key.md"])).toEqual(paths.slice(0, 7));
	});
});

describe("checkLeaks: refusals that are no pass", () => {
	test("a missing denylist file is ok:false", async () => {
		const f = fixture();
		const sha = commit(f.repo, { "a.txt": "fine\n" });
		const result = await checkLeaks({ ...f, sha, denylistFile: join(f.repo, "nope.txt"), gitleaks });
		expect(result).toEqual({ ok: false, hits: [], reason: "denylist를 읽지 못함" });
	});

	test("no gitleaks is ok:false", async () => {
		const f = fixture();
		const sha = commit(f.repo, { "a.txt": "fine\n" });
		expect(await checkLeaks({ ...f, sha, gitleaks: undefined })).toEqual({
			ok: false,
			hits: [],
			reason: "gitleaks 없음",
		});
	});
});

// The range check runs the real gitleaks (CI installs it, JABBU_GITLEAKS): a host without it fails here, never skips.
describe("checkLeaks over <base>..<sha>", () => {
	test("gitleaks is installed", () => {
		expect(gitleaks).toBeDefined();
	});

	test(
		"a clean range passes",
		async () => {
			const f = fixture();
			const sha = commit(f.repo, { "src/a.ts": "export const a = 1;\n", "docs/b.md": "[readme](../README.md)\n" });
			expect(await check(f, sha)).toEqual({ ok: true });
		},
		TIMEOUT_MS,
	);

	test(
		"denylist, credential name, Cataly marker and dead link each give path:line only",
		async () => {
			const f = fixture();
			const sha = commit(f.repo, {
				"src/a.ts": `const a = 1;\n// ${PLANTED}\n`,
				"conf/.env": "X=1\n",
				"src/b.ts": `// ${MARKER}\nexport {};\n`,
				"notes/c.md": "intro\n\nsee [gone](missing.md)\n",
			});
			expect(hitsOf(await check(f, sha)).sort()).toEqual(
				["src/a.ts:2 (denylist)", "conf/.env:0 (secret name)", "src/b.ts:1 (cataly)", "notes/c.md:3"].sort(),
			);
		},
		TIMEOUT_MS,
	);

	test(
		"a gitleaks finding names the file and line, never the secret",
		async () => {
			const f = fixture();
			// Assembled at runtime so this file itself stays clean for secret scanners.
			const fakeKey = ["Tq7LmZp4", "XwRk9VbN", "c2HyJ8sD"].join("");
			const sha = commit(f.repo, { "src/keys.ts": `export const apiToken = "${fakeKey}";\n` });
			const result = await check(f, sha);
			expect(JSON.stringify(result)).not.toContain(fakeKey);
			expect(hitsOf(result).some((hit) => hit.startsWith("src/keys.ts:1 "))).toBe(true);
		},
		TIMEOUT_MS,
	);

	test(
		"commit messages, author and committer are checked",
		async () => {
			const f = fixture();
			commit(f.repo, { "a.txt": "1\n" }, `fix\n\nsee ${PLANTED}`);
			const sha = commit(f.repo, { "b.txt": "2\n" }, "ok", "-c", `user.email=${PLANTED}@example.invalid`);
			const hits = hitsOf(await check(f, sha));
			const message = git(f.repo, "rev-parse", "--short=12", "HEAD~1");
			const identity = sha.slice(0, 12);
			expect(hits.sort()).toEqual(
				[
					`commit ${message}:message:3 (denylist)`,
					`commit ${identity}:author (denylist)`,
					`commit ${identity}:committer (denylist)`,
				].sort(),
			);
		},
		TIMEOUT_MS,
	);

	test(
		"a denylist line added in a middle commit and removed later still fails",
		async () => {
			const f = fixture();
			commit(f.repo, { "src/a.ts": `// ${PLANTED}\n` });
			const sha = commit(f.repo, { "src/a.ts": "// clean\n" });
			expect(git(f.repo, "show", `${sha}:src/a.ts`)).not.toContain(PLANTED);
			expect(hitsOf(await check(f, sha))).toEqual(["src/a.ts:1 (denylist)"]);
		},
		TIMEOUT_MS,
	);

	test(
		"records paths never go to a public branch",
		async () => {
			const f = fixture();
			const sha = commit(f.repo, { "docs/tasks/T-1/spec.md": "x\n", "doc/plans/p.md": "y\n" });
			expect(hitsOf(await check(f, sha)).sort()).toEqual(
				["doc/plans/p.md:0 (records path)", "docs/tasks/T-1/spec.md:0 (records path)"].sort(),
			);
		},
		TIMEOUT_MS,
	);

	test(
		"the PR title and body are checked by name and line",
		async () => {
			const f = fixture();
			const sha = commit(f.repo, { "a.txt": "1\n" });
			const hits = hitsOf(await check(f, sha, { "pr-title": "fine", "pr-body": `line\n${PLANTED}\n` }));
			expect(hits).toEqual(["pr-body:2 (denylist)"]);
		},
		TIMEOUT_MS,
	);

	test(
		"commits already in the base are not checked",
		async () => {
			const f = fixture();
			const base = commit(f.repo, { "old.txt": `${PLANTED}\n` });
			const sha = commit(f.repo, { "new.txt": "clean\n" });
			expect(await check({ ...f, base }, sha)).toEqual({ ok: true });
		},
		TIMEOUT_MS,
	);
});
