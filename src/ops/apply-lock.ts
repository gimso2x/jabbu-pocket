import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const STAMP_PATTERN = /^\d{8}-\d{6}$/;

export const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

/** One `apply` per home at a time holds `<home>/apply.lock`; other installs on the checkout use their own home's. */
export const APPLY_LOCK_FILE = "apply.lock";

export interface ApplyLockInfo {
	pid: number;
	stamp: string;
	startedAt: string;
	/**
	 * Kernel boot id of the holder (`currentBootId`): a lock left from before a reboot is stale even when its pid
	 * now belongs to another process. Absent in locks written before this field (judged by pid alone).
	 */
	bootId?: string;
}

/** The holder an apply lock names; undefined for anything that is not a complete lock (broken JSON included). */
export function parseApplyLock(text: string): ApplyLockInfo | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			typeof parsed.pid === "number" &&
			Number.isInteger(parsed.pid) &&
			parsed.pid > 0 &&
			"stamp" in parsed &&
			typeof parsed.stamp === "string" &&
			STAMP_PATTERN.test(parsed.stamp) &&
			"startedAt" in parsed &&
			typeof parsed.startedAt === "string"
		) {
			const bootId = "bootId" in parsed && typeof parsed.bootId === "string" ? parsed.bootId : undefined;
			return {
				pid: parsed.pid,
				stamp: parsed.stamp,
				startedAt: parsed.startedAt,
				...(bootId === undefined ? {} : { bootId }),
			};
		}
	} catch {
		// broken JSON: not a lock anyone can be waited on
	}
	return undefined;
}

/**
 * Puts the lock in place whole: a fully written temp file is hard-linked to the lock name, so no reader ever sees
 * an empty or half-written lock. false when another lock already holds the name.
 */
export function createApplyLock(lockPath: string, info: ApplyLockInfo): boolean {
	const tmp = `${lockPath}.tmp-${info.pid}-${crypto.randomUUID().slice(0, 8)}`;
	writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: "wx" });
	try {
		linkSync(tmp, lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Takes a stale lock (dead holder, broken JSON) out of the way. Only the process whose rename succeeds reclaims it;
 * when the moved file is not the one judged stale (another apply locked in between), it goes back under the lock
 * name (`changed`, wait again). A new lock already there by then is `contention`: nothing more is touched.
 */
export function reclaimStaleApplyLock(
	lockPath: string,
	seen: string,
	pid: number,
): { outcome: "taken" | "changed" | "contention"; aside: string } {
	const aside = `${lockPath}.stale-${pid}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		renameSync(lockPath, aside);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { outcome: "changed", aside };
		throw error;
	}
	if (readFileSync(aside, "utf8") === seen) {
		rmSync(aside, { force: true });
		return { outcome: "taken", aside };
	}
	try {
		linkSync(aside, lockPath);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return { outcome: "contention", aside };
		throw error;
	}
	rmSync(aside, { force: true });
	return { outcome: "changed", aside };
}

/** Removes the lock only while it is still this apply's (same pid and stamp); true when removed. */
export function releaseApplyLock(lockPath: string, info: ApplyLockInfo): boolean {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	const holder = parseApplyLock(text);
	if (holder?.pid !== info.pid || holder.stamp !== info.stamp) return false;
	rmSync(lockPath, { force: true });
	return true;
}
