import type { Database } from "bun:sqlite";
import { type DeliveryRow, type DeliverySql, toDelivery } from "./db-rows";
import { type DeliveryFacts, StoreError, transitionDelivery } from "./transitions";

/** The one UPDATE every delivery transition writes; a null error keeps the row's stored one. */
export function applyDeliveryFacts(db: Database, deliveryId: number, next: DeliveryFacts, error: string | null): void {
	db.query(
		"UPDATE deliveries SET state = ?, attempts = ?, next_at = ?, redelivered = ?, last_error = COALESCE(?, last_error) WHERE delivery_id = ?",
	).run(next.state, next.attempts, next.nextAt, next.redelivered ? 1 : 0, error, deliveryId);
}

const deliveryFactsOf = (row: DeliverySql): DeliveryFacts => ({
	state: row.state,
	attempts: row.attempts,
	nextAt: row.next_at,
	redelivered: row.redelivered === 1,
	createdAt: row.created_at,
});

/** The `failed_ambiguous` rows waiting for the owner, oldest id first (the `jabbu-pocket deliveries list` list). */
export function listAmbiguousDeliveries(db: Database): DeliveryRow[] {
	return (
		db.query("SELECT * FROM deliveries WHERE state = 'failed_ambiguous' ORDER BY delivery_id").all() as DeliverySql[]
	).map(toDelivery);
}

/**
 * The owner's manual resolution on a bare connection: `transitionDelivery` refuses any row that is not
 * `failed_ambiguous`, so the UPDATE only ever closes a held row. Shared by `Store.resolveAmbiguous` semantics; no
 * hooks fire on this path (the CLI process has none).
 */
export function resolveAmbiguousDelivery(
	db: Database,
	now: number,
	deliveryId: number,
	how: "ack" | "resend",
): DeliveryRow {
	const raw = db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql | null;
	if (raw === null) throw new StoreError("not_found", `delivery ${deliveryId}`);
	applyDeliveryFacts(db, deliveryId, transitionDelivery(deliveryFactsOf(raw), how, now), null);
	return toDelivery(db.query("SELECT * FROM deliveries WHERE delivery_id = ?").get(deliveryId) as DeliverySql);
}
