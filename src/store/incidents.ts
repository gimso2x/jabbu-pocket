import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/**
 * The incident counter shared by `alert_incidents` (Store owner-notice suppression) and `monitor_incidents`
 * (MonitorLedger failure suppression): the first occurrence alerts, the same (key, normalized sign) within
 * `repeatMs` stays quiet, a still-standing condition re-alerts after `repeatMs`, and a resolved condition that
 * comes back reopens loudly. The two tables share one shape; only the key column differs.
 */
type IncidentTable = "alert_incidents" | "monitor_incidents";

const KEY_COLUMN = { alert_incidents: "scope", monitor_incidents: "monitor_id" } as const;

/** Masks durations and long numbers so "timeout after 603s" and "timeout after 611s" share one incident. */
export function normalizeIncidentError(error: string): string {
	const normalized = error
		.replace(/^\[turn failed\]\s*/, "")
		.replace(/\d+(\.\d+)?\s*(ms|초|분|시간|(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b)/gi, "N")
		.replace(/\d{4,}/g, "N")
		.replace(/\s+/g, " ")
		.trim();
	return normalized;
}

/** Outcome of counting one occurrence: whether to notify now, and how the condition has stood so far. */
export interface IncidentDecision {
	notify: boolean;
	/** Occurrences counted in this period (the first alert included). */
	count: number;
	/** When this period started; `now - firstAt` is how long the condition has stood. */
	firstAt: number;
	/** The row's pre-call state: this same condition had already alerted the owner and never resolved. */
	standing: boolean;
}

/**
 * Counts one occurrence of the (key, normalized sign) condition in `table` and decides whether the owner should be
 * told. Callers keep their own default for `repeatMs` (both 24h today) and their own return projection.
 */
export function countIncident(
	db: Database,
	table: IncidentTable,
	key: string,
	sign: string,
	now: number,
	repeatMs: number,
): IncidentDecision {
	const keyCol = KEY_COLUMN[table];
	const signature = createHash("sha256")
		.update(`${key}\n${normalizeIncidentError(sign)}`)
		.digest("hex");
	return db.transaction((): IncidentDecision => {
		const row = db
			.query(`SELECT status, count, first_at, alerted_at FROM ${table} WHERE ${keyCol} = ? AND signature = ?`)
			.get(key, signature) as {
			status: "alerted" | "resolved";
			count: number;
			first_at: number;
			alerted_at: number;
		} | null;
		const standing = row !== null && row.status === "alerted";
		if (row === null) {
			db.query(
				`INSERT INTO ${table} (${keyCol}, signature, status, count, first_at, last_at, alerted_at) VALUES (?, ?, 'alerted', 1, ?, ?, ?)`,
			).run(key, signature, now, now, now);
			return { notify: true, count: 1, firstAt: now, standing };
		}
		if (row.status === "resolved") {
			db.query(
				`UPDATE ${table} SET status = 'alerted', count = 1, first_at = ?, last_at = ?, alerted_at = ? WHERE ${keyCol} = ? AND signature = ?`,
			).run(now, now, now, key, signature);
			return { notify: true, count: 1, firstAt: now, standing };
		}
		if (now - row.alerted_at < repeatMs) {
			db.query(`UPDATE ${table} SET count = count + 1, last_at = ? WHERE ${keyCol} = ? AND signature = ?`).run(
				now,
				key,
				signature,
			);
			return { notify: false, count: row.count + 1, firstAt: row.first_at, standing };
		}
		db.query(
			`UPDATE ${table} SET count = count + 1, last_at = ?, alerted_at = ? WHERE ${keyCol} = ? AND signature = ?`,
		).run(now, now, key, signature);
		return { notify: true, count: row.count + 1, firstAt: row.first_at, standing };
	})();
}

/**
 * Marks the key's open incidents resolved, so the same condition re-alerts when it comes back. `last_at` moves to
 * `now`, so a resolution lists at its own time in the recent-incident view.
 */
export function resolveIncidents(db: Database, table: IncidentTable, key: string, now: number): void {
	db.query(
		`UPDATE ${table} SET status = 'resolved', last_at = ? WHERE ${KEY_COLUMN[table]} = ? AND status = 'alerted'`,
	).run(now, key);
}

/** One incident row as the `#ops` panel reads it: the key (alert scope or monitor id) plus its counters. */
interface IncidentRow {
	key: string;
	status: "alerted" | "resolved";
	count: number;
	lastAt: number;
}

/** The newest `limit` rows of `table` by `last_at` (the panel's recent list), or only the open ones. */
function readIncidentRows(
	db: Database,
	table: IncidentTable,
	options: { limit?: number; openOnly?: boolean },
): IncidentRow[] {
	const where = options.openOnly === true ? "WHERE status = 'alerted'" : "";
	const limit = options.limit === undefined ? "" : `LIMIT ${Math.max(0, Math.trunc(options.limit))}`;
	const rows = db
		.query(
			`SELECT ${KEY_COLUMN[table]} AS key, status, count, last_at FROM ${table} ${where} ORDER BY last_at DESC, incident_id DESC ${limit}`,
		)
		.all() as Array<{ key: string; status: "alerted" | "resolved"; count: number; last_at: number }>;
	return rows.map((r) => ({ key: r.key, status: r.status, count: r.count, lastAt: r.last_at }));
}

/**
 * The `#ops` panel's incident view. `monitors`: enabled count and the monitors with open incidents (one entry per
 * monitor, counts summed over its signatures, a deleted monitor keeps its id as name). `recent`: the newest rows of
 * both tables (any status, one per scope; monitor rows are `monitor:<name>`), newest first.
 */
export function readOpsIncidents(
	db: Database,
	limit: number,
): {
	monitors: { total: number; failing: Array<{ name: string; count: number; lastAt: number }> };
	recent: Array<{ scope: string; status: "alerted" | "resolved"; lastAt: number }>;
} {
	const monitors = db.query("SELECT id, name, enabled FROM monitors").all() as Array<{
		id: string;
		name: string;
		enabled: number;
	}>;
	const nameOf = (id: string): string => monitors.find((m) => m.id === id)?.name ?? id;
	const failing = new Map<string, { name: string; count: number; lastAt: number }>();
	for (const row of readIncidentRows(db, "monitor_incidents", { openOnly: true })) {
		const entry = failing.get(row.key) ?? { name: nameOf(row.key), count: 0, lastAt: 0 };
		entry.count += row.count;
		entry.lastAt = Math.max(entry.lastAt, row.lastAt);
		failing.set(row.key, entry);
	}
	const rows = [
		...readIncidentRows(db, "alert_incidents", { limit }),
		...readIncidentRows(db, "monitor_incidents", { limit }).map((r) => ({ ...r, key: `monitor:${nameOf(r.key)}` })),
	].sort((a, b) => b.lastAt - a.lastAt);
	const seen = new Set<string>();
	const recent = rows
		.filter((r) => !seen.has(r.key) && seen.add(r.key))
		.slice(0, limit)
		.map((r) => ({ scope: r.key, status: r.status, lastAt: r.lastAt }));
	return {
		monitors: {
			total: monitors.filter((m) => m.enabled === 1).length,
			failing: [...failing.values()].sort((a, b) => b.lastAt - a.lastAt),
		},
		recent,
	};
}
