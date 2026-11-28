// A snapshot of a directory tree that compares what a file *is*, not when it was last touched: a recovery test proves
// that a failed step left the tree exactly as it was, and a second-resolution mtime would hide the difference.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * One path of the tree: the raw `lstat` mode (type and permission bits) and a hash of the content. Directories and
 * special files have no content, so their sha256 is "" and only their presence and mode are compared.
 */
export interface TreeEntry {
	mode: number;
	sha256: string;
}

/**
 * Every file, directory, symbolic link and special file under `root` by relative path (POSIX separators), skipping
 * any path whose top-level segment is in `ignore`. A file hashes its bytes; a link hashes its target string, so
 * swapping the target shows even though the mode stays that of a link. A directory or special file (socket, FIFO,
 * device) has no content to hash, so its sha256 is "" and the entry records its presence and mode — a leftover
 * empty directory or FIFO shows instead of passing as "exactly as it was".
 */
export function treeSnapshot(root: string, ignore: readonly string[] = [".git"]): Map<string, TreeEntry> {
	const skip = new Set(ignore);
	const out = new Map<string, TreeEntry>();
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (prefix === "" && skip.has(entry.name)) continue;
			const rel = prefix === "" ? entry.name : posix.join(prefix, entry.name);
			const full = join(dir, entry.name);
			const stats = lstatSync(full);
			if (stats.isDirectory()) {
				// An empty directory is residue too: record it (no content to hash) and keep walking its content.
				out.set(rel, { mode: stats.mode, sha256: "" });
				walk(full, rel);
				continue;
			}
			if (stats.isSymbolicLink()) {
				const target = readlinkSync(full);
				out.set(rel, { mode: stats.mode, sha256: createHash("sha256").update(target).digest("hex") });
				continue;
			}
			if (!stats.isFile()) {
				// A socket, FIFO or device has no content to compare, but its presence is residue: record it.
				out.set(rel, { mode: stats.mode, sha256: "" });
				continue;
			}
			const content = readFileSync(full);
			out.set(rel, { mode: stats.mode, sha256: createHash("sha256").update(content).digest("hex") });
		}
	};
	walk(root, "");
	return out;
}
