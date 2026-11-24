import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";

/** The one git call `hiddenChanges` needs (`GitRunner` of `verify.ts`, which imports this file). */
type Git = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const HIDDEN_PATHS_MAX = 200;

/** The git mode a path on disk has: a symlink, or a file with or without its owner's execute bit. */
function diskMode(stats: Stats, fileMode: boolean): string {
	if (stats.isSymbolicLink()) return "120000";
	return fileMode && (stats.mode & 0o100) !== 0 ? "100755" : "100644";
}

/**
 * Paths whose index flag (`--assume-unchanged`, `--skip-worktree`) hides an edit from `git status`: the file on disk
 * differs from `HEAD`'s in content or in mode (the execute bit, unless `core.fileMode` is off, or a symlink in place
 * of a file: `hash-object` follows a link, so its content alone can match) — a path missing on disk differs only
 * under assume-unchanged; a sparse checkout leaves skip-worktree paths out on purpose. `{ failed }` when git cannot
 * say. Status alone calls such a tree clean.
 */
export async function hiddenChanges(git: Git, dir: string): Promise<string[] | { failed: string }> {
	const flagged = await git(["-C", dir, "ls-files", "-v", "-s", "-z"]);
	if (flagged.code !== 0) return { failed: `git ls-files failed in ${dir}: ${flagged.stderr.trim().split("\n")[0]}` };
	const changed: string[] = [];
	let looked = 0;
	let fileMode: boolean | undefined;
	for (const entry of flagged.stdout.split("\0")) {
		const tag = entry[0];
		if (tag === undefined || tag === "" || !/[a-zS]/.test(tag)) continue;
		// `<tag> <mode> <object> <stage>\t<path>`
		const tab = entry.indexOf("\t");
		const mode = entry.slice(2, tab).split(" ")[0];
		const path = entry.slice(tab + 1);
		const onDisk = join(dir, path);
		let stats: Stats | undefined;
		try {
			stats = lstatSync(onDisk);
		} catch {
			stats = undefined;
		}
		const skipWorktree = tag === "S" || tag === "s";
		if (stats === undefined) {
			if (!skipWorktree) changed.push(path);
			continue;
		}
		if (looked >= HIDDEN_PATHS_MAX) {
			changed.push(`${path} (플래그가 ${HIDDEN_PATHS_MAX}개를 넘어 나머지는 대조하지 않았습니다)`);
			break;
		}
		looked += 1;
		const [disk, head] = [
			await git(["-C", dir, "hash-object", "--", path]),
			await git(["-C", dir, "rev-parse", "-q", "--verify", `HEAD:${path}`]),
		];
		if (disk.code !== 0 || head.code !== 0 || disk.stdout.trim() !== head.stdout.trim()) {
			changed.push(path);
			continue;
		}
		// A gitlink (`160000`) is a directory on disk: its mode says nothing.
		if (mode === "160000") continue;
		fileMode ??= (await git(["-C", dir, "config", "--bool", "core.fileMode"])).stdout.trim() !== "false";
		if (diskMode(stats, fileMode) !== mode) changed.push(path);
	}
	return changed;
}
