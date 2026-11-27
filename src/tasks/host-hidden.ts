import type { RunProcessResult } from "../dispatch/omp";

/** One command on a task's host (`exec` of `host.ts`): local through a shell, or over ssh. */
export type HostExec = (argv: string[], timeoutMs: number) => Promise<RunProcessResult>;

const HIDDEN_PATHS_MAX = 200;

/**
 * Whether a host worktree carries an edit `git status` cannot see: an index flag (`--assume-unchanged`,
 * `--skip-worktree`) hides a path whose disk content or mode differs from HEAD's. The local path asks
 * `hiddenChanges` (src/lanes/hidden-changes.ts), which stats the disk itself — a host worktree's disk is not
 * the bot's, so every probe here is a host command (git, plus `stat` for the disk mode). `true` also when a
 * probe cannot answer: a cleanliness gate that cannot tell must refuse, never assume clean. A path missing on
 * disk differs only under assume-unchanged; a sparse checkout leaves skip-worktree paths out on purpose.
 */
export async function hiddenOnHost(exec: HostExec, worktree: string, timeoutMs: number): Promise<boolean> {
	const git = (...args: string[]) => exec(["git", "-C", worktree, ...args], timeoutMs);
	const flagged = await git("ls-files", "-v", "-s", "-z");
	if (flagged.code !== 0 || flagged.timedOut) return true;
	let fileMode: boolean | undefined;
	let looked = 0;
	for (const entry of flagged.stdout.split("\0")) {
		const tag = entry[0];
		if (tag === undefined || tag === "" || !/[a-zS]/.test(tag)) continue;
		// `<tag> <mode> <object> <stage>\t<path>`
		const tab = entry.indexOf("\t");
		const mode = entry.slice(2, tab).split(" ")[0] ?? "";
		const path = entry.slice(tab + 1);
		const [disk, head] = await Promise.all([
			git("hash-object", "--", path),
			git("rev-parse", "-q", "--verify", `HEAD:${path}`),
		]);
		if (disk.code !== 0) {
			if (tag !== "S" && tag !== "s") return true;
			continue;
		}
		if (head.code !== 0 || disk.stdout.trim() !== head.stdout.trim()) return true;
		// A gitlink (`160000`) is a directory on disk: its mode says nothing.
		if (mode === "160000") continue;
		if (looked >= HIDDEN_PATHS_MAX) return true;
		looked += 1;
		fileMode ??= (await git("config", "--bool", "core.fileMode")).stdout.trim() !== "false";
		// Without `core.fileMode` the disk's execute bit is not read, so the index's is not compared.
		const indexMode = !fileMode && mode === "100755" ? "100644" : mode;
		const stat = await exec(["stat", "-c", "%a %F", `${worktree}/${path}`], timeoutMs);
		if (stat.code !== 0 || stat.timedOut) return true;
		const [perms = "0", ...kind] = stat.stdout.trim().split(" ");
		const diskMode = kind.join(" ").startsWith("symbolic")
			? "120000"
			: fileMode && (Number.parseInt(perms, 8) & 0o100) !== 0
				? "100755"
				: "100644";
		if (diskMode !== indexMode) return true;
	}
	return false;
}
