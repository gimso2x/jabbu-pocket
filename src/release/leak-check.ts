/**
 * Leak checks for what goes public: the manual core export (`release/export.ts`, a
 * whole tree) and a lane's PR (`checkLeaks`, every commit of `<base>..<sha>`). A hit names a place — `path:line
 * (kind)`, or `commit <sha>:<field>` — never the text that matched: the hits go to logs and cards.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";

/** Non-empty, non-comment lines of a list file (throws when it cannot be read). */
export function readList(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/** gitleaks from JABBU_GITLEAKS, PATH, or ~/.local/bin. */
export function findGitleaks(): string | undefined {
	const candidates = [process.env.JABBU_GITLEAKS, Bun.which("gitleaks"), join(homedir(), ".local", "bin", "gitleaks")];
	return candidates.find(
		(candidate): candidate is string => candidate !== undefined && candidate !== null && existsSync(candidate),
	);
}

/** Text lines of a regular file, or undefined for symlinks and binaries. */
export function textLines(path: string): string[] | undefined {
	if (!lstatSync(path).isFile()) return undefined;
	const bytes = readFileSync(path);
	if (bytes.includes(0)) return undefined;
	return bytes.toString("utf8").split("\n");
}

/** File names that are credentials whatever they hold (gitleaks only knows contents). */
const CREDENTIAL_FILES = [".env", "auth.json", "credentials.json"];
const KEY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];

function credentialName(name: string): boolean {
	if (CREDENTIAL_FILES.includes(name)) return true;
	if (name.startsWith(".env.")) return name !== ".env.example" && name !== ".env.sample";
	if (KEY_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
	return /^id_[a-z0-9]+(\.pub)?$/i.test(name);
}

/** A character no shipped path has: control characters, backslash, colon. */
function oddPath(path: string): boolean {
	for (const char of path) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f || char === "\\" || char === ":") return true;
	}
	return false;
}

/** The paths with an odd character or a credential-looking component (`.env`, `*.pem`, `id_ed25519`, …). */
export function secretPathHits(paths: readonly string[]): string[] {
	return paths.filter((path) => oddPath(path) || path.split("/").some(credentialName));
}

/**
 * The provenance marker of code taken from Cataly (SUL-1.0, not MIT): such code is rewritten before it ships. Built
 * from pieces so this file does not carry the marker itself.
 */
export const CATALY_MARKER = new RegExp(["Ported from", ["vntrevx", "Cataly"].join("\\/")].join(" "));

/**
 * Locations (`path:line`; `path:0 (path)` for the name) in `files` under `tree` where any pattern matches.
 * @public
 */
export function treeLineHits(tree: string, files: readonly string[], patterns: readonly RegExp[]): string[] {
	const hits: string[] = [];
	for (const path of files) {
		if (patterns.some((pattern) => pattern.test(path))) hits.push(`${path}:0 (path)`);
		const lines = textLines(join(tree, path));
		lines?.forEach((line, index) => {
			if (patterns.some((pattern) => pattern.test(line))) hits.push(`${path}:${index + 1}`);
		});
	}
	return hits;
}

/** `](target` of an inline markdown link; the target is `<…>` or runs to whitespace or `)`. */
const MD_LINK = /\]\(\s*(<[^>]*>|[^)\s]*)/g;

/** The relative link targets of one markdown line (code spans dropped), as paths relative to the tree root. */
function linkTargets(path: string, line: string): string[] {
	const targets: string[] = [];
	for (const match of line.replace(/`[^`]*`/g, "").matchAll(MD_LINK)) {
		const raw = (match[1] ?? "").replace(/^<|>$/g, "").split(/[#?]/)[0] ?? "";
		if (raw === "" || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
		let decoded = raw;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			// A malformed %-escape: the target is checked as written.
		}
		targets.push(normalize(decoded.startsWith("/") ? decoded.slice(1) : join(dirname(path), decoded)));
	}
	return targets;
}

/**
 * Locations (`path:line`) of relative links in the `*.md` files that point at nothing (`exists` false, or out of the
 * tree): what a public reader cannot follow. Scheme links and bare anchors are skipped; fenced code is no link.
 */
export function deadLinkHits(
	files: readonly { path: string; lines: readonly string[] }[],
	exists: (path: string) => boolean,
): string[] {
	const hits: string[] = [];
	for (const { path, lines } of files) {
		if (!path.endsWith(".md")) continue;
		let fenced = false;
		lines.forEach((line, index) => {
			if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
			else if (!fenced && linkTargets(path, line).some((target) => target.startsWith("..") || !exists(target))) {
				hits.push(`${path}:${index + 1}`);
			}
		});
	}
	return hits;
}

/**
 * `deadLinkHits` over the files of a tree on disk.
 * @public
 */
export function treeDeadLinks(tree: string, files: readonly string[]): string[] {
	const read = files.flatMap((path) => {
		const lines = path.endsWith(".md") ? textLines(join(tree, path)) : undefined;
		return lines === undefined ? [] : [{ path, lines }];
	});
	return deadLinkHits(read, (path) => existsSync(join(tree, path)));
}

interface GitleaksFinding {
	File?: string;
	StartLine?: number;
	RuleID?: string;
	Commit?: string;
}

/**
 * Runs gitleaks (`argv` after the binary) with a JSON report under `scratch`; the findings as `path:line rule`
 * (`--redact`: the report never holds the secret either). Throws when gitleaks fails.
 */
async function gitleaksRun(binary: string, argv: string[], scratch: string, root: string): Promise<string[]> {
	const report = join(scratch, "gitleaks.json");
	const proc = Bun.spawn(
		[
			binary,
			...argv,
			"--no-banner",
			"--redact",
			"--report-format",
			"json",
			"--report-path",
			report,
			"--exit-code",
			"3",
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (code === 0) return [];
	if (code !== 3) throw new Error(`gitleaks failed (exit ${code})`);
	const findings: unknown = JSON.parse(readFileSync(report, "utf8"));
	if (!Array.isArray(findings) || findings.length === 0) throw new Error("gitleaks reported leaks without a report");
	return findings.map((finding: GitleaksFinding) => {
		const file = String(finding.File ?? "?");
		const path = file.startsWith("/") ? relative(root, file) : file;
		return `${path}:${Number(finding.StartLine ?? 0)} ${String(finding.RuleID ?? "")}`.trim();
	});
}

/**
 * gitleaks over a directory tree (`gitleaks dir`).
 * @public
 */
export function gitleaksDirHits(binary: string, tree: string, scratch: string): Promise<string[]> {
	return gitleaksRun(binary, ["dir", tree], scratch, tree);
}

export interface LeakCheckInput {
	/** The repository (a lane's worktree) the commits are read from. */
	repo: string;
	/** Commits of `<base>..<sha>` are checked: what the push adds to the public repository. */
	base: string;
	sha: string;
	/** `<recordsRepo>/release/denylist.txt`: one case-insensitive pattern per line. */
	denylistFile: string;
	/** The gitleaks binary; absent = not installed (the check fails). */
	gitleaks: string | undefined;
	/** Text that goes public with the commits (the PR title and body), by name. */
	texts?: Readonly<Record<string, string>>;
}

export type LeakCheckResult = { ok: true } | { ok: false; hits: string[]; reason?: string };

/** Paths of the records repository: they never go to a public branch. */
const RECORDS_PATHS = ["doc/plans/", "docs/tasks/", "archive/", "release/"];

async function gitOut(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", repo, "-c", "core.quotePath=false", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LC_ALL: "C" },
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
	return stdout;
}

/** The added lines of one commit (`-U0` patch against its first parent), by path, with their line numbers. */
function addedLines(patch: string): Map<string, Array<[number, string]>> {
	const byPath = new Map<string, Array<[number, string]>>();
	let path: string | undefined;
	let next = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			path = undefined;
			inHunk = false;
		} else if (!inHunk && line.startsWith("+++ ")) {
			const target = line.slice(4).replace(/^"|"$/g, "");
			path = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
		} else if (line.startsWith("@@ ")) {
			next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
			inHunk = true;
		} else if (inHunk && path !== undefined && line.startsWith("+")) {
			const lines = byPath.get(path) ?? [];
			lines.push([next, line.slice(1)]);
			byPath.set(path, lines);
			next += 1;
		}
	}
	return byPath;
}

/** Hits of one commit: its author, committer and message, its paths, and the lines it adds. */
async function commitHits(repo: string, commit: string, denylist: readonly RegExp[]): Promise<string[]> {
	const hits: string[] = [];
	const short = commit.slice(0, 12);
	const matches = (text: string, patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(text));
	const [author, committer, ...message] = (
		await gitOut(repo, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", commit])
	)
		.trimEnd()
		.split("\n");
	if (matches(author ?? "", denylist)) hits.push(`commit ${short}:author (denylist)`);
	if (matches(committer ?? "", denylist)) hits.push(`commit ${short}:committer (denylist)`);
	message.forEach((line, index) => {
		if (matches(line, denylist)) hits.push(`commit ${short}:message:${index + 1} (denylist)`);
		if (CATALY_MARKER.test(line)) hits.push(`commit ${short}:message:${index + 1} (cataly)`);
	});
	const paths = (await gitOut(repo, ["diff-tree", "-r", "-z", "--root", "--no-commit-id", "--name-only", commit]))
		.split("\0")
		.filter((path) => path !== "");
	for (const path of secretPathHits(paths)) hits.push(`${path}:0 (secret name)`);
	for (const path of paths) {
		if (RECORDS_PATHS.some((prefix) => path.startsWith(prefix))) hits.push(`${path}:0 (records path)`);
		if (matches(path, denylist)) hits.push(`${path}:0 (path)`);
	}
	const patch = await gitOut(repo, [
		"diff-tree",
		"-p",
		"-U0",
		"--no-color",
		"--no-ext-diff",
		"--root",
		"--no-commit-id",
		commit,
	]);
	for (const [path, lines] of addedLines(patch)) {
		for (const [number, line] of lines) {
			if (matches(line, denylist)) hits.push(`${path}:${number} (denylist)`);
			if (CATALY_MARKER.test(line)) hits.push(`${path}:${number} (cataly)`);
		}
	}
	return hits;
}

/** Dead relative links in the `*.md` files `<base>..<sha>` touched, as they are at `sha`. */
async function rangeDeadLinks(repo: string, base: string, sha: string): Promise<string[]> {
	const split = (text: string) => text.split("\0").filter((path) => path !== "");
	const tree = new Set(split(await gitOut(repo, ["ls-tree", "-r", "-z", "--name-only", sha])));
	const dirs = new Set(
		[...tree].flatMap((path) =>
			path
				.split("/")
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join("/")),
		),
	);
	const changed = split(await gitOut(repo, ["diff", "--name-only", "-z", "--no-renames", `${base}...${sha}`]));
	const files: { path: string; lines: string[] }[] = [];
	for (const path of changed) {
		if (path.endsWith(".md") && tree.has(path)) {
			files.push({ path, lines: (await gitOut(repo, ["show", `${sha}:${path}`])).split("\n") });
		}
	}
	return deadLinkHits(files, (path) => path === "." || tree.has(path) || dirs.has(path));
}

/**
 * The leak gate of a lane's PR (§2): every commit of `<base>..<sha>` (an intermediate commit's secret stays in the
 * pushed branch) — author, committer and message, paths (credential names, records paths), added lines (denylist,
 * Cataly marker) — dead links in the touched `*.md`, gitleaks over the same commits, and `texts`. A denylist that
 * cannot be read, a missing gitleaks or a git failure is no pass (`ok:false` with `reason`).
 */
export async function checkLeaks(input: LeakCheckInput): Promise<LeakCheckResult> {
	let denylist: RegExp[];
	try {
		denylist = readList(input.denylistFile).map((source) => new RegExp(source, "i"));
	} catch {
		return { ok: false, hits: [], reason: "denylist를 읽지 못함" };
	}
	if (input.gitleaks === undefined) return { ok: false, hits: [], reason: "gitleaks 없음" };
	const scratch = mkdtempSync(join(tmpdir(), "jabbu-leak-"));
	try {
		const hits: string[] = [];
		const range = `${input.base}..${input.sha}`;
		const commits = (await gitOut(input.repo, ["rev-list", "--reverse", range])).split("\n").filter((c) => c !== "");
		for (const commit of commits) hits.push(...(await commitHits(input.repo, commit, denylist)));
		hits.push(...(await rangeDeadLinks(input.repo, input.base, input.sha)));
		hits.push(...(await gitleaksRun(input.gitleaks, ["git", `--log-opts=${range}`, input.repo], scratch, input.repo)));
		const texts = Object.entries(input.texts ?? {});
		for (const [name, text] of texts) {
			text.split("\n").forEach((line, index) => {
				if (denylist.some((pattern) => pattern.test(line))) hits.push(`${name}:${index + 1} (denylist)`);
				if (CATALY_MARKER.test(line)) hits.push(`${name}:${index + 1} (cataly)`);
			});
		}
		if (texts.length > 0) {
			const dir = join(scratch, "texts");
			mkdirSync(dir);
			for (const [name, text] of texts) writeFileSync(join(dir, name), text);
			hits.push(...(await gitleaksRun(input.gitleaks, ["dir", dir], scratch, dir)));
		}
		const unique = [...new Set(hits)];
		return unique.length === 0 ? { ok: true } : { ok: false, hits: unique };
	} catch (error) {
		return {
			ok: false,
			hits: [],
			reason: `검사 실패: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
