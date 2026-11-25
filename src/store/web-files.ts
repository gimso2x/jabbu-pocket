import type { Database } from "bun:sqlite";
import { basename } from "node:path";

/** Base names of the files every `web_messages` row names in `files_json`; a malformed row names nothing. */
export function referencedWebFileNames(db: Database): Set<string> {
	const names = new Set<string>();
	const rows = db.query("SELECT files_json FROM web_messages WHERE files_json IS NOT NULL").all() as Array<{
		files_json: string;
	}>;
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.files_json) as unknown;
			if (!Array.isArray(parsed)) continue;
			for (const entry of parsed) {
				const path = (entry as { path?: unknown } | null)?.path;
				if (typeof path === "string") names.add(basename(path));
			}
		} catch {
			// a malformed legacy row names nothing
		}
	}
	return names;
}
