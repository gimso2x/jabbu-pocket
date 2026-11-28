import { readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Best-effort removal of staged lock files (`<lock>.<pid>.<uuid>.tmp`, see `acquireLock`) left by starters that died
 * mid-acquire — SIGKILL, OOM, or the watchdog kill between `openSync` and the unlink. Only a file whose creator pid
 * is dead goes: a live pid's file may be a starter between write and link, so it stays. A reused pid can keep a
 * stale file behind, never remove a live starter's — the sweep errs toward leaving files. Never throws: a listing
 * failure must not hide the acquire error that follows.
 */
export function sweepStaleStaged(path: string, isAlive: (pid: number) => boolean): void {
	let names: string[];
	try {
		names = readdirSync(dirname(path));
	} catch {
		return;
	}
	const prefix = `${basename(path)}.`;
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const pid = Number(name.slice(prefix.length).split(".", 1)[0]);
		if (!Number.isInteger(pid) || isAlive(pid)) continue;
		try {
			unlinkSync(join(dirname(path), name));
		} catch {
			// Another starter removed it first, or it is not ours to remove.
		}
	}
}
