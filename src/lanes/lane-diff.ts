import { CODE_EXT, type LaneDiffRange, LaneDiffUnavailable, laneRange } from "./integrity";
import { cappedDiffGit, GitOutputCapError, type GitRunner } from "./verify";

/** The most a lane's per-file diffs add up to, the most change bundles read, and the longest the reading may take. */
export const LANE_DIFF_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const LANE_DIFF_MAX_FILES = 2000;
export const LANE_DIFF_TOTAL_MS = 60_000;

export interface LaneDiffLimits {
	totalMaxBytes: number;
	maxFiles: number;
	totalMs: number;
	now: () => number;
}

const DEFAULT_LIMITS: LaneDiffLimits = {
	totalMaxBytes: LANE_DIFF_TOTAL_MAX_BYTES,
	maxFiles: LANE_DIFF_MAX_FILES,
	totalMs: LANE_DIFF_TOTAL_MS,
	now: () => Date.now(),
};

/** What was read of a lane's diff and the changed code files it could not read (named by their path). */
export interface LaneDiff {
	diff: string;
	unread: string[];
}

/** The paths one change touched: old and new for a rename or copy, else the one path. */
type Bundle = string[];

/** `git diff --name-status -z` output as bundles; undefined when it does not parse. */
function parseNameStatus(out: string): Bundle[] | undefined {
	const parts = out.split("\0");
	if (parts.at(-1) === "") parts.pop();
	const bundles: Bundle[] = [];
	for (let i = 0; i < parts.length; ) {
		const status = parts[i++] as string;
		const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		const paths = parts.slice(i, i + count);
		if (status === "" || paths.length < count || paths.some((path) => path === "")) return undefined;
		bundles.push(paths);
		i += count;
	}
	return bundles;
}

const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--text"];

/**
 * `git diff <from>..sha` of the lane's repository (see `laneRange` for `from`). A base branch that cannot be read
 * throws `LaneDiffUnavailable`; without one, `from` is `baseSha`. "" when the repository, a merge-base with `sha` or
 * the diff cannot be read (the classifier then only sees the claim). A diff over the output cap is read again one
 * changed code file at a time (renames with both paths, so their deleted lines come along); a file over the cap, or
 * one the total limits stop short of, is returned in `unread`. A change list that cannot be read throws
 * `LaneDiffUnavailable`.
 */
export async function collectLaneDiff(
	laneCwd: string,
	range: LaneDiffRange,
	sha: string,
	git: GitRunner = cappedDiffGit,
	limits: LaneDiffLimits = DEFAULT_LIMITS,
): Promise<LaneDiff> {
	const resolved = await laneRange(laneCwd, range, sha, git);
	if (resolved === undefined || resolved.from === undefined) return { diff: "", unread: [] };
	const span = `${resolved.from}..${sha}`;
	const base = ["-C", resolved.root, "-c", "core.quotepath=false"];
	try {
		const diff = await git([...base, "diff", ...DIFF_OPTIONS, span, "--no-color", "--unified=0"]);
		return { diff: diff.code === 0 ? diff.stdout : "", unread: [] };
	} catch (error) {
		if (!(error instanceof GitOutputCapError)) throw error;
	}
	const listed = await git([
		...base,
		"diff",
		"--name-status",
		"-z",
		"--no-ext-diff",
		"--no-textconv",
		"-M",
		span,
	]).catch((error: unknown) => {
		throw new LaneDiffUnavailable(error instanceof Error ? error.message : String(error));
	});
	const bundles = listed.code === 0 ? parseNameStatus(listed.stdout) : undefined;
	if (bundles === undefined) throw new LaneDiffUnavailable("레인의 변경 목록을 읽지 못했습니다");
	const started = limits.now();
	const chunks: string[] = [];
	const unread: string[] = [];
	let total = 0;
	let reads = 0;
	let stopped = false;
	for (const bundle of bundles) {
		if (!bundle.some((path) => CODE_EXT.test(path))) continue;
		const name = bundle.at(-1) as string;
		if (!stopped && (reads >= limits.maxFiles || limits.now() - started >= limits.totalMs)) stopped = true;
		if (stopped) {
			unread.push(name);
			continue;
		}
		reads += 1;
		try {
			const part = await git([
				...base,
				"diff",
				...DIFF_OPTIONS,
				"-M",
				span,
				"--no-color",
				"--unified=0",
				"--",
				...bundle,
			]);
			if (part.code !== 0) throw new Error(`git diff exit ${part.code}`);
			if (total + part.stdout.length > limits.totalMaxBytes) {
				stopped = true;
				unread.push(name);
				continue;
			}
			total += part.stdout.length;
			chunks.push(part.stdout);
		} catch {
			unread.push(name);
		}
	}
	return { diff: chunks.join(""), unread };
}
