import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FINAL_MARKS } from "../channel/text";
import type { WebMessageStore } from "../store/web-messages";

/**
 * Closes the `status` rows (`⏳ 작업 중`) a previous daemon process left running. The status tracker lives in memory, so after
 * a restart nothing will ever finish those rows: they would keep the spinner on and the conversation under "진행 중"
 * for good. A row that already ends in a result (`🚫 취소됨`, `⚠️ 실패`, `✅ 완료`) keeps its text and is only marked
 * `final`; a row still reading `⏳ 작업 중` is closed (hidden). Rows already marked `final` are left alone.
 * Run once when the web adapter is built, before the first new turn. Returns how many rows it touched.
 */
export function retireStaleWebStatus(store: WebMessageStore, homeDir: string): number {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return 0;
	const db = new Database(dbPath, { readonly: true, strict: true });
	let rows: Array<{ id: number; text: string }>;
	try {
		rows = db
			.query(
				"SELECT id, text FROM web_messages WHERE role = 'status' AND card_json LIKE '%\"deleted\":false%' AND card_json NOT LIKE '%\"final\":true%' ORDER BY id",
			)
			.all() as Array<{ id: number; text: string }>;
	} catch {
		return 0;
	} finally {
		db.close();
	}
	const labels = Object.values(FINAL_MARKS).map((mark) => mark.label);
	for (const { id, text } of rows) {
		const ended = labels.some((label) => text.startsWith(label));
		store.edit(id, {
			text: ended ? text : "",
			cardJson: JSON.stringify(
				ended ? { kind: "status", deleted: false, final: true } : { kind: "status", deleted: true },
			),
		});
	}
	return rows.length;
}
