// Taking `<home>/apply.lock` for one apply: a live holder is waited for (no drain, no restart meanwhile), a stale one
// taken over. Running past the limit changes nothing and fails, leaving the holder's lock alone.
import { currentBootId, holderAlive } from "../daemon/lock";
import { processStartedAt } from "../daemon/proc-start";
import { type ApplyLockInfo, createApplyLock, errorCode, parseApplyLock, reclaimStaleApplyLock } from "./apply-lock";
import { readRegularText } from "./stamp";

const LOCK_POLL_MS = 1_000;

export interface LockWaitDeps {
	now(): number;
	sleep(ms: number): Promise<void>;
	pid: number;
	isAlive(pid: number): boolean;
	/** Start time of a process (ms), for the holder's recorded start check; absent: the real `/proc` read. */
	processStartedAt?: (pid: number) => number | undefined;
	log(line: string): void;
}

export interface LockWaitResult {
	ok: boolean;
	detail: string;
	/** Something to record as the `wait_apply` step: a wait, a takeover, a refusal or a failure. */
	noted: boolean;
	/** A peer apply found a live holder and left the home to it (`peerOf`). */
	busy?: boolean;
	/** The stamp of the apply this one waited for, if any. */
	waitedFor?: string;
}

export async function acquireApplyLock(
	input: {
		lockPath: string;
		lock: { info: ApplyLockInfo; held: boolean };
		stamp: string;
		limitMs: number;
		/** Set for a peer apply: its outer apply holds another home all along, so a live holder is never waited for. */
		peerOf?: string | undefined;
	},
	deps: LockWaitDeps,
): Promise<LockWaitResult> {
	const { lockPath, lock, stamp, limitMs, peerOf } = input;
	const deadline = deps.now() + limitMs;
	const notes: string[] = [];
	let waitedFor: string | undefined;
	const done = (result: LockWaitResult): LockWaitResult =>
		waitedFor === undefined ? result : { ...result, waitedFor };
	for (;;) {
		if (createApplyLock(lockPath, lock.info)) {
			lock.held = true;
			deps.log(`apply lock taken ${lockPath}`);
			if (waitedFor !== undefined) notes.push(`waited for apply ${waitedFor}`);
			return done({ ok: true, detail: notes.join("; "), noted: notes.length > 0 });
		}
		let seen: string;
		try {
			seen = readRegularText(lockPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue; // released between our link and read: try again
			throw error;
		}
		const holder = parseApplyLock(seen);
		// The outer apply of this very process (same stamp) already holds this home: waiting would wait on itself.
		if (holder?.pid === deps.pid && holder.stamp === stamp) {
			return done({ ok: false, detail: `${lockPath} is held by this apply ${stamp} itself`, noted: true });
		}
		// A dead holder (or one from another boot), broken JSON, or this pid left by an earlier process (another
		// stamp) is stale. So is a holder whose pid was reused after the lock was written: the process at that
		// pid started later than the lock records (the daemon lock checks the same way). An unparsable
		// `startedAt` fails open, exactly as before.
		const recorded = holder === undefined ? Number.NaN : Date.parse(holder.startedAt);
		const recordedStartedAt = Number.isNaN(recorded) ? undefined : recorded;
		const alive =
			holder !== undefined &&
			holderAlive(
				holder.pid,
				holder.bootId,
				deps.isAlive,
				currentBootId(),
				recordedStartedAt,
				deps.processStartedAt ?? processStartedAt,
			);
		if (holder === undefined || holder.pid === deps.pid || !alive) {
			const reclaim = reclaimStaleApplyLock(lockPath, seen, deps.pid);
			if (reclaim.outcome === "contention") {
				return done({ ok: false, detail: `lock contention (moved-aside lock left at ${reclaim.aside})`, noted: true });
			}
			if (reclaim.outcome === "taken") notes.push(`stale lock ${holder?.stamp ?? "(unreadable)"} taken over`);
			continue;
		}
		// The holder is an apply of this checkout that applies this home itself and runs its own peers; a peer that
		// waited for it could close a cycle (A's peer step waits for B's home while B's waits for A's, 11-25).
		if (peerOf !== undefined) {
			const detail = `held by apply ${holder.stamp} pid=${holder.pid}, which applies this home itself (peer of ${peerOf}: not waited for)`;
			return done({ ok: false, busy: true, detail, noted: true });
		}
		if (waitedFor !== holder.stamp) deps.log(`apply wait_apply waiting for apply ${holder.stamp} pid=${holder.pid}`);
		waitedFor = holder.stamp;
		if (deps.now() >= deadline) {
			return done({
				ok: false,
				detail: `apply ${holder.stamp} still running after ${limitMs / 60_000} min`,
				noted: true,
			});
		}
		await deps.sleep(LOCK_POLL_MS);
	}
}
