// A fixture git that cannot be changed by the developer's own git setup: every command runs with a throwaway HOME and
// global config (identity, default branch, no hooks, no signing), so a host `.gitconfig` with aliases, a different
// default branch or `commit.gpgsign = true` can never make a test pass or fail differently on someone else's machine.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Root of the fixture's own git world; it lives under the test scratch dir, so the preload removes it with the run. */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "jabbu-git-fixture-"));
const FIXTURE_HOME = join(FIXTURE_ROOT, "home");
/** An empty hooks directory: `core.hooksPath` points here, so neither the host's nor the repository's hooks run. */
const FIXTURE_HOOKS = join(FIXTURE_ROOT, "no-hooks");
const FIXTURE_CONFIG = join(FIXTURE_ROOT, "gitconfig");

mkdirSync(FIXTURE_HOME, { recursive: true });
mkdirSync(FIXTURE_HOOKS, { recursive: true });
// Written once: what a fixture commit sees as its identity and branch name. A test that needs another author passes its
// own `-c user.email=…` after ours, and git keeps the last value.
writeFileSync(
	FIXTURE_CONFIG,
	[
		"[user]",
		"\tname = jabbu fixture",
		"\temail = fixture@jabbu.invalid",
		"[init]",
		"\tdefaultBranch = main",
		"[commit]",
		"\tgpgsign = false",
		"[tag]",
		"\tgpgsign = false",
		"[core]",
		`\thooksPath = ${FIXTURE_HOOKS}`,
		"\tfsmonitor = false",
		"[advice]",
		"\tdetachedHead = false",
		"",
	].join("\n"),
);

/** The environment of every fixture git: no inherited `GIT_*` variable survives, and the global config is ours. */
function fixtureEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: FIXTURE_HOME,
		GIT_CONFIG_GLOBAL: FIXTURE_CONFIG,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/true",
		LC_ALL: "C.UTF-8",
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
	};
}

/**
 * Runs git in `dir` and returns its stdout without the trailing newline. A non-zero exit throws (the error carries
 * git's stderr), which is what a test asserting a refusal expects. Hooks, signing and the host's configuration stay
 * out of it: see the file comment.
 */
export function git(dir: string, ...args: string[]): string {
	const stdout = execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], {
		encoding: "utf8",
		env: fixtureEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.replace(/\n+$/, "");
}

/**
 * Creates a temporary repository on `main` with one commit (`README.md` = `hello\n`) and pushes its path onto `repos`
 * so the test's cleanup can remove it. `prefix` names the directory; a path a shell or `TASK_PATH_PATTERN` would refuse
 * is made by passing such a prefix.
 */
export function makeRepo(repos: string[], prefix = "jabbu-repo-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, "add", "--", "README.md");
	git(dir, "commit", "-q", "-m", "init");
	repos.push(dir);
	return dir;
}
