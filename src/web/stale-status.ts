import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WebMessageStore } from "../store/web-messages";

/**
 * Closes the `status` rows (`⏳ 작업 중`) a previous daemon process left running. The status tracker lives in memory, so after
 * a restart nothing will ever finish those rows: they would keep the spinner on and the conversation under "진행 중"
 * for good. Run once when the web channel attaches, before the first new turn. Returns how many rows it closed.
 */
export function retireStaleWebStatus(store: WebMessageStore, homeDir: string): number {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return 0;
	const db = new Database(dbPath, { readonly: true, strict: true });
	let ids: number[];
	try {
		ids = (
			db
				.query("SELECT id FROM web_messages WHERE role = 'status' AND card_json LIKE '%\"deleted\":false%' ORDER BY id")
				.all() as Array<{ id: number }>
		).map((row) => row.id);
	} catch {
		return 0;
	} finally {
		db.close();
	}
	for (const id of ids) store.edit(id, { text: "", cardJson: JSON.stringify({ kind: "status", deleted: true }) });
	return ids.length;
}
