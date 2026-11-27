import { type Dirent, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Inbound attachments are context for one turn, not an archive (24h retention). */
export const MEDIA_MAX_AGE_MS = 24 * 60 * 60_000;

/** The web chat's upload directory under the media root (`src/web/upload.ts` `webUploadRoot`). */
const WEB_UPLOAD_SUBDIR = join("inbound", "web");

/** The slice of `WebMessageStore` the sweep reads. */
export interface WebUploadRefs {
	referencedFileNames(): Set<string>;
}

/**
 * Deletes files older than `cutoff` under `root`, skipping the directory `skip` entirely, and the directories they empty
 * out. Best effort per entry (see `pruneMediaFiles`). `root` itself is never followed: a symlink or non-directory is skipped.
 */
export function pruneTree(root: string, cutoff: number, skip: string): number {
	if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return 0;
	return prune(root, cutoff, skip);
}

function prune(dir: string, cutoff: number, skip: string): number {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0; // missing, not a directory, or unreadable
	}
	let removed = 0;
	for (const entry of entries) {
		const child = join(dir, entry.name);
		if (child === skip) continue;
		try {
			if (entry.isDirectory()) {
				removed += pruneDirectory(child, cutoff, skip);
			} else if ((entry.isFile() || entry.isSymbolicLink()) && lstatSync(child).mtimeMs < cutoff) {
				unlinkSync(child);
				removed += 1;
			}
		} catch {
			// vanished, permission denied, ...: leave it for the next sweep
		}
	}
	return removed;
}

function pruneDirectory(dir: string, cutoff: number, skip: string): number {
	const mtimeBefore = lstatSync(dir).mtimeMs;
	const removed = prune(dir, cutoff, skip);
	if ((removed > 0 || mtimeBefore < cutoff) && readdirSync(dir).length === 0) rmdirSync(dir);
	return removed;
}

/**
 * Deletes web chat uploads older than `maxAgeMs` that no `web_messages` row names (`referenced`: the base names from
 * `WebMessageStore.referencedFileNames`): an orphan of an unsent upload, a leftover temp file, or a file whose messages
 * `gc` removed. A file a message still shows stays, so the chat history keeps its images and downloads. Idempotent,
 * best effort per file; a missing or symlinked upload directory is left alone.
 */
export function pruneWebUploads(
	mediaRoot: string,
	referenced: ReadonlySet<string>,
	now: number,
	maxAgeMs = MEDIA_MAX_AGE_MS,
): number {
	const dir = join(mediaRoot, WEB_UPLOAD_SUBDIR);
	if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isFile() || referenced.has(entry.name)) continue;
		const child = join(dir, entry.name);
		try {
			if (lstatSync(child).mtimeMs < now - maxAgeMs) {
				unlinkSync(child);
				removed += 1;
			}
		} catch {
			// vanished or not removable: the next sweep tries again
		}
	}
	return removed;
}

/**
 * The hourly media sweep: files under `mediaRoot` older than `MEDIA_MAX_AGE_MS` go, except the web chat's upload directory,
 * which is judged by the messages that name its files (`pruneWebUploads`). Without the ledger (`web` undefined) that
 * directory is left alone.
 */
export function sweepMedia(mediaRoot: string, now: number, web: WebUploadRefs | undefined): number {
	const removed = pruneTree(mediaRoot, now - MEDIA_MAX_AGE_MS, join(mediaRoot, WEB_UPLOAD_SUBDIR));
	return web === undefined ? removed : removed + pruneWebUploads(mediaRoot, web.referencedFileNames(), now);
}
