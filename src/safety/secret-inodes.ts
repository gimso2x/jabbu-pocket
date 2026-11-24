import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `dev:ino` of every regular file under `dir`, a symlink to one by its target (empty when the directory is missing). A
 * directory that cannot be listed throws: the guard cannot tell, so the caller refuses the file (qa-z #5).
 */
export function inodesUnder(dir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { recursive: true, withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const ids: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const path = join(entry.parentPath, entry.name);
		let stat: Stats;
		try {
			stat = statSync(path);
		} catch (error) {
			// A dangling link has no file behind it to protect.
			if (entry.isSymbolicLink() && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isFile()) ids.push(`${stat.dev}:${stat.ino}`);
	}
	return ids;
}
