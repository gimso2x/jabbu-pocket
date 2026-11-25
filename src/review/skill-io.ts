import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

export interface SafeSkillPathOpts {
	requireFile?: boolean;
	requireDir?: boolean;
	checkHardLink?: boolean;
}

/** Refuses symlinks (live or dangling), unexpected entry types, and multi-hardlink files before touching `path`. */
export function assertSafeSkillPath(path: string, action: string, opts: SafeSkillPathOpts = {}): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return false;
	if (stat.isSymbolicLink()) throw new Error(`${action} refused: ${path} is a symbolic link`);
	if (opts.requireDir && !stat.isDirectory()) throw new Error(`${action} refused: ${path} is not a directory`);
	if (opts.requireFile && !stat.isFile()) throw new Error(`${action} refused: ${path} is not a regular file`);
	if (opts.checkHardLink && stat.nlink > 1) throw new Error(`${action} refused: ${path} has more than one hard link`);
	return true;
}

/** Creates a new regular file strictly without following symlinks (`O_CREAT | O_EXCL | O_NOFOLLOW`) and sets `mode`. */
export function writeExclusiveNoFollow(path: string, data: string | Buffer, mode: number): void {
	const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
	try {
		try {
			for (let offset = 0; offset < buf.length; ) {
				offset += writeSync(fd, buf, offset, buf.length - offset);
			}
			fchmodSync(fd, mode);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup of a partial exclusive write.
		}
		throw error;
	}
}

/** Atomically replaces `target` via a UUID-named exclusive no-follow temp file + rename. */
export function writeAtomicNoFollow(target: string, data: string | Buffer, mode: number): void {
	const staged = stageTempPath(target, "tmp");
	writeExclusiveNoFollow(staged, data, mode);
	try {
		renameSync(staged, target);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
}

/** Unpredictable temp file path next to `target`. */
export function stageTempPath(target: string, tag: string): string {
	return `${target}.${randomUUID()}.${tag}`;
}
