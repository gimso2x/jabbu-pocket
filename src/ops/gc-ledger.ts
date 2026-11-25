import type { Database } from "bun:sqlite";
import { hasTable } from "./gc-turns";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long finished inbound, delivery and monitor-event rows stay in the ledger. */
export const LEDGER_RETENTION_DAYS = 90;

/** Options of `gcSessions` that the ledger-retention pass reads. */
interface LedgerGcOptions {
	now: number;
	dryRun?: boolean;
}

/** Row counts `gcLedger` removed per table; `deliveryPosts` are the posts of the removed deliveries. */
export interface LedgerRemoved {
	inbound: number;
	deliveries: number;
	deliveryPosts: number;
	monitorEvents: number;
	monitorSlots: number;
	webMessages: number;
	inboundConflicts: number;
}

export function emptyLedgerRemoved(): LedgerRemoved {
	return {
		inbound: 0,
		deliveries: 0,
		deliveryPosts: 0,
		monitorEvents: 0,
		monitorSlots: 0,
		webMessages: 0,
		inboundConflicts: 0,
	};
}

/**
 * Finished conversation rows past `LEDGER_RETENTION_DAYS` leave the ledger, in one transaction; a dry run only counts.
 * - inbound: `answered`/`failed_notified`/`discarded`, unless a pending approval card was asked from its thread
 *   (`origin_thread_ref`).
 * - deliveries: `confirmed`/`failed_ambiguous`/`expired`; its `delivery_posts` rows (written by older versions) go
 *   first. The gc connection never turns `foreign_keys` on (origins expire at 30 days, inbound at 90, so the origin
 *   delete would be refused), which is why the posts→deliveries order is kept here by hand.
 * - monitor_events: the final stages only, aged by `updated_at`; monitor_slots and inbound_conflicts: every row aged
 *   by `created_at`.
 * Waiting, running and uncertain rows, approvals, usage and alert incidents are never touched. A table missing from an
 * old home makes its rule empty instead of failing.
 */
export function gcLedger(db: Database, options: LedgerGcOptions): LedgerRemoved {
	const cutoff = options.now - LEDGER_RETENTION_DAYS * DAY_MS;
	const inboundWhere = [
		"i.created_at < ? AND i.state IN ('answered','failed_notified','discarded')",
		hasTable(db, "approvals")
			? "NOT EXISTS (SELECT 1 FROM approvals a WHERE a.status = 'pending' AND a.origin_thread_ref = i.thread_ref)"
			: undefined,
	]
		.filter((term) => term !== undefined)
		.join(" AND ");
	const deliveriesWhere = "d.created_at < ? AND d.state IN ('confirmed','failed_ambiguous','expired')";
	const hasDeliveries = hasTable(db, "deliveries");
	const posts = hasDeliveries && hasTable(db, "delivery_posts");
	const events = hasTable(db, "monitor_events");
	const slots = hasTable(db, "monitor_slots");
	const web = hasTable(db, "web_messages");
	const conflicts = hasTable(db, "inbound_conflicts");
	const postsWhere = `delivery_id IN (SELECT d.delivery_id FROM deliveries d WHERE ${deliveriesWhere})`;
	const eventsWhere = "stage IN ('delivered','failed_no_retry','skipped','no_report') AND updated_at < ?";
	const webWhere = [
		"w.created_at < ?",
		hasTable(db, "approvals")
			? "NOT EXISTS (SELECT 1 FROM approvals a WHERE a.status = 'pending' AND a.channel = w.conversation AND a.message_ts = CAST(w.id AS TEXT))"
			: undefined,
	]
		.filter((term) => term !== undefined)
		.join(" AND ");
	const count = (sql: string) => (db.query(`SELECT COUNT(*) AS n FROM ${sql}`).get(cutoff) as { n: number }).n;
	const removed: LedgerRemoved = {
		inbound: count(`inbound i WHERE ${inboundWhere}`),
		deliveries: hasDeliveries ? count(`deliveries d WHERE ${deliveriesWhere}`) : 0,
		deliveryPosts: posts ? count(`delivery_posts WHERE ${postsWhere}`) : 0,
		monitorEvents: events ? count(`monitor_events WHERE ${eventsWhere}`) : 0,
		monitorSlots: slots ? count("monitor_slots WHERE created_at < ?") : 0,
		webMessages: web ? count(`web_messages w WHERE ${webWhere}`) : 0,
		inboundConflicts: conflicts ? count("inbound_conflicts WHERE created_at < ?") : 0,
	};
	if (options.dryRun === true) return removed;
	db.transaction(() => {
		if (posts) db.query(`DELETE FROM delivery_posts WHERE ${postsWhere}`).run(cutoff);
		if (hasDeliveries) db.query(`DELETE FROM deliveries AS d WHERE ${deliveriesWhere}`).run(cutoff);
		db.query(`DELETE FROM inbound AS i WHERE ${inboundWhere}`).run(cutoff);
		if (events) db.query(`DELETE FROM monitor_events WHERE ${eventsWhere}`).run(cutoff);
		if (slots) db.query("DELETE FROM monitor_slots WHERE created_at < ?").run(cutoff);
		if (web) db.query(`DELETE FROM web_messages AS w WHERE ${webWhere}`).run(cutoff);
		if (conflicts) db.query("DELETE FROM inbound_conflicts WHERE created_at < ?").run(cutoff);
	})();
	return removed;
}
