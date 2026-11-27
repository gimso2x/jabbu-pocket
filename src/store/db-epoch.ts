import type { Database } from "bun:sqlite";
import { StoreError } from "./transitions";

/** What an epoch bump does with the origin's still-pending inbound rows: discard them (`/new`) or carry them over. */
export type PendingRows = { discard: true; opRef?: string | undefined } | { discard: false };

/**
 * One transaction: bump the origin's epoch, switch its session dir, clear the pinned session file, and settle the
 * pending rows. A discarded row is linked to `opRef` when given (the command's delivery then also finishes its thread
 * status message); a carried-over row keeps its state and takes the new epoch, so delivery follows the new epoch.
 */
export function bumpEpoch(
	db: Database,
	now: number,
	originKey: string,
	sessionDir: string,
	pending: PendingRows,
	sessionFile?: string,
): void {
	db.transaction(() => {
		const origin = db.query("SELECT epoch FROM origins WHERE origin_key = ?").get(originKey) as {
			epoch: number;
		} | null;
		if (origin === null) throw new StoreError("unknown_origin", originKey);
		db.query(
			"UPDATE origins SET epoch = ?, session_dir = ?, session_file = ?, updated_at = ? WHERE origin_key = ?",
		).run(origin.epoch + 1, sessionDir, sessionFile ?? null, now, originKey);
		if (pending.discard) {
			db.query(
				"UPDATE inbound SET state = 'discarded', op_ref = COALESCE(?, op_ref) WHERE origin_key = ? AND state = 'pending'",
			).run(pending.opRef ?? null, originKey);
		} else {
			db.query("UPDATE inbound SET epoch = ? WHERE origin_key = ? AND state = 'pending'").run(
				origin.epoch + 1,
				originKey,
			);
		}
	})();
}
