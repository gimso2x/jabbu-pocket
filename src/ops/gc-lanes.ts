import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GcOptions } from "./gc";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Newest modification time of a directory tree (symlinks are not followed). */
export function newestMtimeMs(path: string): number {
	const stat = lstatSync(path);
	let newest = stat.mtimeMs;
	if (stat.isDirectory()) {
		for (const name of readdirSync(path)) newest = Math.max(newest, newestMtimeMs(join(path, name)));
	}
	return newest;
}

/**
 * A closed lane's kept evidence (`<home>/lanes/<lane>/artifacts`) goes with the same retention window as the sessions,
 * measured from the newest file in the lane's directory. A link in place of a lane directory is never followed.
 * Lanes that cannot be read are reported as `skipped`, not silently dropped.
 */
export function gcLaneArtifacts(options: GcOptions): { removed: string[]; skipped: string[] } {
	const root = join(options.homeDir, "lanes");
	if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return { removed: [], skipped: [] };
	const cutoff = options.now - options.retentionDays * DAY_MS;
	const removed: string[] = [];
	const skipped: string[] = [];
	// Runs after the session and ledger deletions are committed: one lane that cannot be read (a permission change, a
	// race with the lane's own cleanup) is left for the next gc instead of discarding the whole run's summary.
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return { removed, skipped: [root] };
	}
	for (const name of names) {
		const path = join(root, name);
		try {
			if (lstatSync(path).isDirectory() && newestMtimeMs(path) < cutoff) {
				if (options.dryRun !== true) rmSync(path, { recursive: true, force: true });
				removed.push(path);
			}
		} catch {
			skipped.push(path);
		}
	}
	return { removed, skipped };
}
