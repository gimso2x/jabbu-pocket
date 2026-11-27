import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sessionDirFor } from "../core/origin";

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DIR = /^e([1-9][0-9]*)$/;

type OriginRow = { origin_key: string; epoch: number; session_dir: string; updated_at: number };

/** The real path of an existing path; a path that is not there is only resolved. */
function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

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
 * Whole-origin activity is measured BEFORE pass 1: pruning an old epoch dir bumps the origin dir's own mtime to now,
 * which would otherwise make every origin with a pruned epoch look freshly active. Unreadable dirs are skipped instead
 * of failing the whole gc run.
 */
export function measureOriginActivity(
	origins: readonly OriginRow[],
	sessionsRoot: string,
	shouldMeasure: (originKey: string) => boolean,
	skippedOrigins: Set<string>,
	sessionsSkipped: string[],
): Map<string, number> {
	const originActivity = new Map<string, number>();
	for (const origin of origins) {
		if (!shouldMeasure(origin.origin_key)) continue;
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		try {
			// A missing directory (the row was made, the first turn has not written yet) ages by the row's updated_at.
			const exists = lstatSync(originDir, { throwIfNoEntry: false }) !== undefined;
			originActivity.set(origin.origin_key, exists ? newestMtimeMs(originDir) : origin.updated_at);
		} catch {
			skippedOrigins.add(origin.origin_key);
			sessionsSkipped.push(originDir);
		}
	}
	return originActivity;
}

/**
 * Pass 1: prunes previous-epoch directories older than `cutoff`. Unreadable directories or epoch entries are recorded
 * in `skippedOrigins` and `sessionsSkipped`, never crashing the run and preventing pass 2 from deleting skipped origins.
 */
export function prunePreviousEpochs(
	origins: readonly OriginRow[],
	sessionsRoot: string,
	cutoff: number,
	dryRun: boolean | undefined,
	skippedOrigins: Set<string>,
	result: { removed: string[]; retained: string[]; sessionsSkipped: string[] },
): void {
	for (const origin of origins) {
		if (skippedOrigins.has(origin.origin_key)) continue;
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		try {
			// An origin directory that is not a plain directory (a link swapped in) is skipped whole: gc never reaches past it.
			if (lstatSync(originDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
			for (const name of readdirSync(originDir)) {
				const epoch = EPOCH_DIR.exec(name)?.[1];
				if (epoch === undefined || Number(epoch) >= origin.epoch) continue;
				const path = join(originDir, name);
				try {
					// `/resume-jabbu` can make an older epoch's directory the live one again.
					// Compared by real path: a symlinked home must not make the live directory look like another one.
					if (realpathOrResolve(path) === realpathOrResolve(origin.session_dir)) continue;
					if (!lstatSync(path).isDirectory()) continue;
					if (newestMtimeMs(path) < cutoff) {
						if (dryRun !== true) rmSync(path, { recursive: true, force: true });
						result.removed.push(path);
					} else result.retained.push(path);
				} catch {
					skippedOrigins.add(origin.origin_key);
					result.sessionsSkipped.push(path);
				}
			}
		} catch {
			skippedOrigins.add(origin.origin_key);
			result.sessionsSkipped.push(originDir);
		}
	}
}

/**
 * A closed lane's kept evidence (`<home>/lanes/<lane>/artifacts`) goes with the same retention window as the sessions,
 * measured from the newest file in the lane's directory. A link in place of a lane directory is never followed.
 * Lanes that cannot be read are reported as `skipped`, not silently dropped.
 */
export function gcLaneArtifacts(options: { homeDir: string; retentionDays: number; now: number; dryRun?: boolean }): {
	removed: string[];
	skipped: string[];
} {
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
