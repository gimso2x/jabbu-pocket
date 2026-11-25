import { join } from "node:path";
import { MEDIA_MAX_AGE_MS, pruneTree } from "./media-prune";

export { MEDIA_MAX_AGE_MS };

/**
 * Deletes downloaded attachments older than `maxAgeMs` and the directories they empty out. Idempotent.
 *
 * Best effort per entry: a file or directory that cannot be listed, stat'ed or removed is skipped, so one bad entry
 * never aborts the sweep (or the backup run that triggers it). Only regular files and symlinks are unlinked, and
 * symlinks are judged by their own mtime (lstat), never followed. An empty directory is removed only when this pass
 * emptied it or its own mtime is already past the cutoff - a directory a download is about to write into survives.
 * The web chat's `inbound/web` is not touched: its files stay while a chat message shows them (`sweepMedia`).
 */
export function pruneMediaFiles(mediaRoot: string, now: number, maxAgeMs = MEDIA_MAX_AGE_MS): number {
	return pruneTree(mediaRoot, now - maxAgeMs, join(mediaRoot, "inbound", "web"));
}
