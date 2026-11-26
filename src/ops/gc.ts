import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isThreadOrigin } from "../core/normalize";
import { sessionDirFor } from "../core/origin";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { checkSchemaVersion } from "../store/schema-version";
import { assertRegularLedger } from "./gates";
import { gcLaneArtifacts, newestMtimeMs } from "./gc-lanes";
import * as ledgerGc from "./gc-ledger";

export { LEDGER_RETENTION_DAYS } from "./gc-ledger";

/** Thread-session origins of the removed Slack and Teams channels. */
const REMOVED_PLATFORM_THREAD = /^(slack|teams)\/ch\/[^/]+\/t\/[^/]+$/;

export const DEFAULT_SESSION_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_DIR = /^e([1-9][0-9]*)$/;
/** Inbound states that keep an origin whole (waiting, in flight or parked as uncertain). */
const WAITING = "state IN ('pending', 'sending', 'dispatched', 'uncertain')";
/** Re-checks the waiting rows at delete time: gc runs with foreign_keys off, so a late inbound would lose its origin. */
const REMOVE_IDLE = `DELETE FROM origins WHERE origin_key = ? AND NOT EXISTS (SELECT 1 FROM inbound WHERE origin_key = ? AND ${WAITING})`;

export interface GcOptions {
	homeDir: string;
	retentionDays: number;
	now: number;
	/** Report what would be removed without deleting. */
	dryRun?: boolean;
	/** Test seam: runs between the ledger scan and the first origin delete (a message arriving mid-gc). */
	afterScan?: () => void;
}

export interface GcResult {
	removed: string[];
	/** Previous-epoch directories still inside the retention window. */
	retained: string[];
	/** Thread-session origins (`slack/ch/<C>/t/<R>`) removed whole (directory + ledger row) past retention. */
	threadOriginsRemoved: string[];
	/** Origins of deleted monitors (`monitor/<id>` with no row in `monitors`) removed whole past retention. */
	monitorOriginsRemoved: string[];
	/** Kept file evidence of closed lanes (`<home>/lanes/<lane>`) removed whole past retention. */
	laneArtifactsRemoved: string[];
	/** Lane directories gc could not read (a permission change, a race with the lane's own cleanup): left for the next gc. */
	laneArtifactsSkipped: string[];
	/** Finished conversation rows past `LEDGER_RETENTION_DAYS` deleted (counted only on a dry run). */
	ledgerRemoved: ledgerGc.LedgerRemoved;
}

/** The real path of an existing path; a path that is not there is only resolved. */
function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Deletes only session directories of PREVIOUS epochs (`sessions/<origin>/e<N>` with N below the origin's current
 * epoch in the ledger) whose newest file is older than the retention window. The current epoch, unknown origins,
 * and anything not named `e<N>` are never touched. The ledger is opened read-only.
 *
 * Thread-session origins never churn epochs, so their sessions would pile up forever: once the origin's newest
 * activity (newest file mtime; a missing directory ages by `updated_at`) is past the retention window the whole
 * directory goes with the ledger row, and a later message opens a fresh origin. An origin with waiting inbound is
 * never removed, and a symlinked origin directory is never followed.
 */
export function gcSessions(options: GcOptions): GcResult {
	const result: GcResult = {
		removed: [],
		retained: [],
		threadOriginsRemoved: [],
		monitorOriginsRemoved: [],
		laneArtifactsRemoved: [],
		laneArtifactsSkipped: [],
		ledgerRemoved: ledgerGc.emptyLedgerRemoved(),
	};
	const dbPath = join(options.homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return result;
	// A FIFO in the ledger's place would block the open forever.
	assertRegularLedger(dbPath);
	const sessionsRoot = join(options.homeDir, "sessions");
	const db = new Database(dbPath, { readonly: true, strict: true });
	let origins: Array<{ origin_key: string; epoch: number; session_dir: string; updated_at: number }>;
	/** Origins with inbound still waiting for a turn (or parked as uncertain until the owner decides): their directory and row stay whatever their age. */
	let waiting: Set<string>;
	// A home without a `monitors` table has no monitor ids, so the deleted-monitor rule is skipped entirely.
	let monitorIds: Set<string> | undefined;
	try {
		origins = db
			.query("SELECT origin_key, epoch, session_dir, updated_at FROM origins ORDER BY origin_key")
			.all() as typeof origins;
		waiting = new Set(
			(
				db.query(`SELECT DISTINCT origin_key FROM inbound WHERE ${WAITING}`).all() as Array<{
					origin_key: string;
				}>
			).map((row) => row.origin_key),
		);
		// Before anything is deleted: a ledger from a newer build must stop gc while every directory is still there.
		if (!options.dryRun) checkSchemaVersion(db);
		if (ledgerGc.hasTable(db, "monitors"))
			monitorIds = new Set((db.query("SELECT id FROM monitors").all() as Array<{ id: string }>).map((row) => row.id));
	} finally {
		db.close();
	}
	const cutoff = options.now - options.retentionDays * DAY_MS;
	// Thread sessions of the removed Slack and Teams channels no longer parse as a chat origin, but still expire like
	// any thread.
	const expiresWhole = (key: string) => isThreadOrigin(key) || REMOVED_PLATFORM_THREAD.test(key);
	const isOrphanMonitor = (key: string) =>
		monitorIds !== undefined &&
		key.startsWith(MONITOR_ORIGIN_PREFIX) &&
		!monitorIds.has(key.slice(MONITOR_ORIGIN_PREFIX.length));
	// Whole-origin activity is measured BEFORE pass 1: pruning an old epoch dir bumps the origin dir's own mtime
	// to now, which would otherwise make every origin with a pruned epoch look freshly active.
	const originActivity = new Map<string, number>();
	for (const origin of origins) {
		if (!isOrphanMonitor(origin.origin_key) && !expiresWhole(origin.origin_key)) continue;
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		// A missing directory (the row was made, the first turn has not written yet) ages by the row's updated_at.
		const exists = lstatSync(originDir, { throwIfNoEntry: false }) !== undefined;
		originActivity.set(origin.origin_key, exists ? newestMtimeMs(originDir) : origin.updated_at);
	}
	for (const origin of origins) {
		const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
		// An origin directory that is not a plain directory (a link swapped in) is skipped whole: gc never reaches past it.
		if (lstatSync(originDir, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
		for (const name of readdirSync(originDir)) {
			const epoch = EPOCH_DIR.exec(name)?.[1];
			if (epoch === undefined || Number(epoch) >= origin.epoch) continue;
			const path = join(originDir, name);
			// `/resume-jabbu` can make an older epoch's directory the live one again.
			// Compared by real path: a symlinked home must not make the live directory look like another one.
			if (realpathOrResolve(path) === realpathOrResolve(origin.session_dir)) continue;
			if (!lstatSync(path).isDirectory()) continue;
			if (newestMtimeMs(path) < cutoff) {
				if (!options.dryRun) rmSync(path, { recursive: true, force: true });
				result.removed.push(path);
			} else result.retained.push(path);
		}
	}
	// The read-only handle is closed before the cleanup pass opens, so the writable short-lived connection
	// never fights a lock. busy_timeout mirrors the ledger's open options: a turn committing at the same
	// moment must not fail the gc with an immediate SQLITE_BUSY. Expired origins and `gcLedger` delete rows.
	// A dry run opens it read-only, only to count.
	const write = new Database(dbPath, options.dryRun ? { readonly: true, strict: true } : { strict: true });
	write.run("PRAGMA busy_timeout = 5000");
	const removeRow = options.dryRun ? undefined : write.query(REMOVE_IDLE);
	options.afterScan?.();
	try {
		for (const origin of origins) {
			const orphanMonitor = isOrphanMonitor(origin.origin_key);
			if (!orphanMonitor && !expiresWhole(origin.origin_key)) continue;
			const originDir = dirname(sessionDirFor(sessionsRoot, origin.origin_key, 1));
			const activity = originActivity.get(origin.origin_key);
			if (activity !== undefined && activity >= cutoff) {
				result.retained.push(originDir);
				continue;
			}
			const present = lstatSync(originDir, { throwIfNoEntry: false });
			// Inbound still waiting for a turn keeps its origin whole; a link in place of the directory is never followed.
			if (waiting.has(origin.origin_key)) {
				result.retained.push(originDir);
				continue;
			}
			if (present !== undefined && !present.isDirectory()) continue;
			if (
				removeRow !== undefined &&
				!ledgerGc.removeOriginWithDir(write, removeRow, origin.origin_key, originDir, present !== undefined)
			) {
				result.retained.push(originDir);
				continue;
			}
			(orphanMonitor ? result.monitorOriginsRemoved : result.threadOriginsRemoved).push(origin.origin_key);
		}
		result.ledgerRemoved = ledgerGc.gcLedger(write, options);
	} finally {
		write.close();
	}
	({ removed: result.laneArtifactsRemoved, skipped: result.laneArtifactsSkipped } = gcLaneArtifacts(options));
	return result;
}
