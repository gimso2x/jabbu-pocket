import type { Database } from "bun:sqlite";
import { isRecord } from "../omp/type-guards";
import { readSchemaVersion } from "./schema-version";

/**
 * Schema 9: the one-time move of the old project names (`ompbot`, `kencrew`) out of the ledger's values, run once by
 * `Store` on a ledger stamped below 9. The code reads only the new names, so without it an old ledger would keep lane
 * conversations the code no longer recognises, wiki drafts that never go out (the same unit gets a new id) and receipts
 * whose source commit reads as missing — which `gateChangedOf` takes as "gate source unchanged" (fail-open).
 * Absolute paths (`session_dir`, `worktree`, `repo`, `docs_dir`, `cwd`) and session files are a host move, not this.
 */
/** The schema version this rename landed in; `SCHEMA_VERSION` must cover it (see `test/schema-version.test.ts`). */
export const RENAMED_AT = 9;
const OLD_LANE_ORIGIN = "ompbot/work/";
const NEW_LANE_ORIGIN = "jabbu/work/";
const WIKI_SOURCE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
	["ompbot-task-", "jabbu-task-"],
	["ompbot-lane-", "jabbu-lane-"],
	["ompbot-turns-", "jabbu-turns-"],
];
const OLD_RUNTIME_KEY = "kencrew";
const NEW_RUNTIME_KEY = "source";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function tables(db: Database): string[] {
	const rows = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
		.all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

function columns(db: Database, table: string): Array<{ name: string }> {
	return db.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>;
}

/**
 * Swaps `prefix` for `replacement` at the start of every value of `table.column` that has it. The match is a
 * `substr` compare, not LIKE, so the `_` in a prefix is literal.
 */
function swapPrefix(db: Database, table: string, column: string, prefix: string, replacement: string): void {
	const col = quote(column);
	db.query(
		`UPDATE ${quote(table)} SET ${col} = ?2 || substr(${col}, length(?1) + 1) WHERE substr(${col}, 1, length(?1)) = ?1`,
	).run(prefix, replacement);
}

/**
 * Lane origins `ompbot/work/<name>`: found by column name, not a hand-made table list — `origin_key` in every table that
 * has it and `*_origin` (`board_posts.author_origin`), the same value under another name. Bodies are not looked at.
 */
const isOriginColumn = (name: string): boolean => name === "origin_key" || name.endsWith("_origin");

function renameLaneOrigins(db: Database): void {
	for (const table of tables(db)) {
		for (const { name } of columns(db, table)) {
			if (isOriginColumn(name)) swapPrefix(db, table, name, OLD_LANE_ORIGIN, NEW_LANE_ORIGIN);
		}
	}
}

/** Wiki note source ids, in the key and in the `sourceId` of a kept draft. */
function renameWikiSources(db: Database): void {
	if (!tables(db).includes("wiki_notes")) return;
	for (const [prefix, replacement] of WIKI_SOURCE_PREFIXES)
		swapPrefix(db, "wiki_notes", "source_id", prefix, replacement);
	const drafts = db
		.query("SELECT source_id, draft FROM wiki_notes WHERE draft IS NOT NULL AND draft <> ''")
		.all() as Array<{ source_id: string; draft: string }>;
	const update = db.query("UPDATE wiki_notes SET draft = ? WHERE source_id = ?");
	for (const row of drafts) {
		const draft = parseJson(row.draft);
		const id = isRecord(draft) ? draft.sourceId : undefined;
		if (!isRecord(draft) || typeof id !== "string") continue;
		const pair = WIKI_SOURCE_PREFIXES.find(([prefix]) => id.startsWith(prefix));
		if (pair === undefined) continue;
		draft.sourceId = pair[1] + id.slice(pair[0].length);
		update.run(JSON.stringify(draft), row.source_id);
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Renames the `kencrew` key of every `runtime` object in `value`, in place, keeping the key order; anything else —
 * the word in a note or a summary — is left as it is. Returns whether something changed.
 */
function renameRuntimeKeys(value: unknown): boolean {
	if (Array.isArray(value)) return value.map(renameRuntimeKeys).some(Boolean);
	if (!isRecord(value)) return false;
	let changed = false;
	for (const [key, child] of Object.entries(value)) {
		if (key === "runtime" && isRecord(child) && OLD_RUNTIME_KEY in child && !(NEW_RUNTIME_KEY in child)) {
			const entries = Object.entries(child).map(([k, v]) => [k === OLD_RUNTIME_KEY ? NEW_RUNTIME_KEY : k, v]);
			for (const k of Object.keys(child)) delete child[k];
			Object.assign(child, Object.fromEntries(entries));
			changed = true;
		}
		if (renameRuntimeKeys(child)) changed = true;
	}
	return changed;
}

/** Receipt runtimes in the JSON columns (`lanes.meta`, `tasks.gate_json` and every other `meta` or `*_json`). */
function renameReceiptRuntimes(db: Database): void {
	for (const table of tables(db)) {
		for (const { name } of columns(db, table)) {
			if (name !== "meta" && !name.endsWith("_json")) continue;
			const col = quote(name);
			const rows = db
				.query(`SELECT rowid AS id, ${col} AS value FROM ${quote(table)} WHERE instr(${col}, ?) > 0`)
				.all(`"${OLD_RUNTIME_KEY}"`) as Array<{ id: number; value: string }>;
			const update = db.query(`UPDATE ${quote(table)} SET ${col} = ? WHERE rowid = ?`);
			for (const row of rows) {
				const parsed = parseJson(row.value);
				if (renameRuntimeKeys(parsed)) update.run(JSON.stringify(parsed), row.id);
			}
		}
	}
}

/**
 * Moves the old names of a ledger below schema 9 in one transaction; a ledger at 9 or above is left alone, so a second
 * open changes nothing. `origins.origin_key` is referenced by `inbound`, so the keys move with foreign keys off (the
 * pragma is a no-op inside a transaction) and every reference moves with its parent.
 */
export function migrateOldNames(db: Database): void {
	if (readSchemaVersion(db) >= RENAMED_AT) return;
	db.run("PRAGMA foreign_keys = OFF");
	try {
		db.transaction(() => {
			renameLaneOrigins(db);
			renameWikiSources(db);
			renameReceiptRuntimes(db);
		})();
	} finally {
		db.run("PRAGMA foreign_keys = ON");
	}
}
