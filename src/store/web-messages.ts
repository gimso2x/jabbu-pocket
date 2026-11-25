import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** DDL for web chat messages (`SCHEMA_VERSION` 12). */
export const WEB_MESSAGES_DDL = `CREATE TABLE IF NOT EXISTS web_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation TEXT NOT NULL,
	thread TEXT,
	role TEXT NOT NULL CHECK (role IN ('owner','assistant','status','approval','choice','system')),
	text TEXT NOT NULL,
	card_json TEXT,
	buttons_json TEXT,
	files_json TEXT,
	created_at INTEGER NOT NULL,
	edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS web_messages_conv_id ON web_messages(conversation, id);
CREATE INDEX IF NOT EXISTS web_messages_conv_thread_id ON web_messages(conversation, thread, id);
CREATE INDEX IF NOT EXISTS web_messages_created ON web_messages(created_at);`;

export type WebMessageRole = "owner" | "assistant" | "status" | "approval" | "choice" | "system";

export interface WebMessageRow {
	id: number;
	conversation: string;
	thread: string | null;
	role: WebMessageRole;
	text: string;
	cardJson: string | null;
	buttonsJson: string | null;
	filesJson: string | null;
	createdAt: number;
	editedAt: number | null;
}

export interface WebConversationSummary {
	conversation: string;
	title: string;
	lastId: number;
	lastText: string;
	lastRole: WebMessageRole;
	updatedAt: number;
	openApprovals: number;
	inProgress: boolean;
}

interface WebMessageSql {
	id: number;
	conversation: string;
	thread: string | null;
	role: WebMessageRole;
	text: string;
	card_json: string | null;
	buttons_json: string | null;
	files_json: string | null;
	created_at: number;
	edited_at: number | null;
}

const toRow = (sql: WebMessageSql): WebMessageRow => ({
	id: sql.id,
	conversation: sql.conversation,
	thread: sql.thread,
	role: sql.role,
	text: sql.text,
	cardJson: sql.card_json,
	buttonsJson: sql.buttons_json,
	filesJson: sql.files_json,
	createdAt: sql.created_at,
	editedAt: sql.edited_at,
});

function hasWebMessagesTable(db: Database): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'web_messages'").get() !== null;
}

function titleOfConversation(rows: WebMessageRow[]): string {
	for (const row of rows) {
		if (row.role === "system" && row.cardJson !== null) {
			try {
				const parsed = JSON.parse(row.cardJson) as { title?: unknown };
				if (typeof parsed.title === "string" && parsed.title.trim() !== "") return parsed.title.trim();
			} catch {
				// malformed metadata falls back to owner text
			}
		}
		if (row.role === "owner" && row.text.trim() !== "") return row.text.trim().slice(0, 80);
	}
	return rows[0]?.conversation ?? "";
}

/** Read/write store for `web_messages` inside the daemon's `Store` (all stored fields go through `redact`). */
export class WebMessageStore {
	readonly #db: Database;
	readonly #clock: { now(): number };
	readonly #redact: (text: string) => string;

	constructor(db: Database, clock: { now(): number }, redact: (text: string) => string) {
		this.#db = db;
		this.#clock = clock;
		this.#redact = redact;
	}

	insert(input: {
		conversation: string;
		thread?: string | undefined;
		role: WebMessageRole;
		text: string;
		cardJson?: string | undefined;
		buttonsJson?: string | undefined;
		filesJson?: string | undefined;
	}): WebMessageRow {
		const now = this.#clock.now();
		const res = this.#db
			.query(
				`INSERT INTO web_messages (conversation, thread, role, text, card_json, buttons_json, files_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.conversation,
				input.thread ?? null,
				input.role,
				this.#redact(input.text),
				input.cardJson === undefined ? null : this.#redact(input.cardJson),
				input.buttonsJson === undefined ? null : this.#redact(input.buttonsJson),
				input.filesJson === undefined ? null : this.#redact(input.filesJson),
				now,
			);
		return this.get(Number(res.lastInsertRowid)) as WebMessageRow;
	}

	edit(
		id: number,
		patch: {
			text: string;
			cardJson?: string | null | undefined;
			buttonsJson?: string | null | undefined;
			filesJson?: string | null | undefined;
		},
	): WebMessageRow | undefined {
		const current = this.get(id);
		if (current === undefined) return undefined;
		const now = this.#clock.now();
		// Ensure `edited_at` advances monotonically even on sub-ms edits or frozen test clocks so SSE never misses an edit.
		const prev = (
			this.#db.query("SELECT COALESCE(MAX(edited_at), 0) AS max_edited FROM web_messages").get() as {
				max_edited: number;
			}
		).max_edited;
		const editedAt = now > prev ? now : prev + 1;
		const nextCard =
			patch.cardJson === undefined ? current.cardJson : patch.cardJson === null ? null : this.#redact(patch.cardJson);
		const nextButtons =
			patch.buttonsJson === undefined
				? current.buttonsJson
				: patch.buttonsJson === null
					? null
					: this.#redact(patch.buttonsJson);
		const nextFiles =
			patch.filesJson === undefined
				? current.filesJson
				: patch.filesJson === null
					? null
					: this.#redact(patch.filesJson);
		this.#db
			.query(
				"UPDATE web_messages SET text = ?, card_json = ?, buttons_json = ?, files_json = ?, edited_at = ? WHERE id = ?",
			)
			.run(this.#redact(patch.text), nextCard, nextButtons, nextFiles, editedAt, id);
		return this.get(id);
	}

	get(id: number): WebMessageRow | undefined {
		const row = this.#db.query("SELECT * FROM web_messages WHERE id = ?").get(id) as WebMessageSql | null;
		return row === null ? undefined : toRow(row);
	}

	listMessages(conversation: string, opts: { thread?: string; after?: number; limit?: number } = {}): WebMessageRow[] {
		return listWebMessagesDb(this.#db, conversation, opts);
	}

	listConversations(limit = 50): WebConversationSummary[] {
		return listWebConversationsDb(this.#db, limit);
	}
}

function listWebMessagesDb(
	db: Database,
	conversation: string,
	opts: { thread?: string; after?: number; limit?: number } = {},
): WebMessageRow[] {
	const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
	const after = opts.after ?? 0;
	const rows = (
		opts.thread !== undefined
			? db
					.query("SELECT * FROM web_messages WHERE conversation = ? AND thread = ? AND id > ? ORDER BY id ASC LIMIT ?")
					.all(conversation, opts.thread, after, limit)
			: db
					.query(
						"SELECT * FROM web_messages WHERE conversation = ? AND thread IS NULL AND id > ? ORDER BY id ASC LIMIT ?",
					)
					.all(conversation, after, limit)
	) as WebMessageSql[];
	return rows.map(toRow);
}

function listWebConversationsDb(db: Database, limit = 50): WebConversationSummary[] {
	const convs = db
		.query(
			`SELECT conversation, MAX(id) AS max_id, MAX(COALESCE(edited_at, created_at)) AS updated_at
			 FROM web_messages GROUP BY conversation ORDER BY updated_at DESC, max_id DESC LIMIT ?`,
		)
		.all(Math.max(1, Math.min(limit, 200))) as Array<{ conversation: string; max_id: number; updated_at: number }>;
	const hasApprovals =
		db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() !== null;
	return convs.map((entry) => {
		const rows = (
			db
				.query("SELECT * FROM web_messages WHERE conversation = ? ORDER BY id ASC LIMIT 20")
				.all(entry.conversation) as WebMessageSql[]
		).map(toRow);
		const lastVisible = db
			.query("SELECT * FROM web_messages WHERE conversation = ? AND role != 'status' ORDER BY id DESC LIMIT 1")
			.get(entry.conversation) as WebMessageSql | null;
		const last = lastVisible === null ? rows.at(-1) : toRow(lastVisible);
		const openApprovals = hasApprovals
			? (
					db
						.query("SELECT COUNT(*) AS n FROM approvals WHERE channel = ? AND status = 'pending'")
						.get(entry.conversation) as { n: number }
				).n
			: 0;
		const statusRow = db
			.query("SELECT card_json FROM web_messages WHERE conversation = ? AND role = 'status' ORDER BY id DESC LIMIT 1")
			.get(entry.conversation) as { card_json: string | null } | null;
		let inProgress = false;
		if (statusRow?.card_json !== null && statusRow?.card_json !== undefined) {
			try {
				inProgress = (JSON.parse(statusRow.card_json) as { deleted?: unknown }).deleted === false;
			} catch {
				inProgress = false;
			}
		}
		return {
			conversation: entry.conversation,
			title: titleOfConversation(rows),
			lastId: entry.max_id,
			lastText: last?.text.slice(0, 120) ?? "",
			lastRole: last?.role ?? "system",
			updatedAt: entry.updated_at,
			openApprovals,
			inProgress,
		};
	});
}

function withReadonlyDb<T>(homeDir: string, fallback: T, read: (db: Database) => T): T {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return fallback;
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		if (!hasWebMessagesTable(db)) return fallback;
		return read(db);
	} finally {
		db.close();
	}
}

export function readWebConversations(homeDir: string, limit = 50): WebConversationSummary[] {
	return withReadonlyDb(homeDir, [], (db) => listWebConversationsDb(db, limit));
}

export function readWebMessages(
	homeDir: string,
	conversation: string,
	opts: { thread?: string; after?: number; limit?: number } = {},
): WebMessageRow[] {
	return withReadonlyDb(homeDir, [], (db) => listWebMessagesDb(db, conversation, opts));
}

export function readWebWatermark(homeDir: string, conversation?: string): { maxId: number; maxEditedAt: number } {
	return withReadonlyDb(homeDir, { maxId: 0, maxEditedAt: 0 }, (db) => {
		const row = (
			conversation !== undefined
				? db
						.query(
							"SELECT COALESCE(MAX(id), 0) AS max_id, COALESCE(MAX(COALESCE(edited_at, 0)), 0) AS max_edited FROM web_messages WHERE conversation = ?",
						)
						.get(conversation)
				: db
						.query(
							"SELECT COALESCE(MAX(id), 0) AS max_id, COALESCE(MAX(COALESCE(edited_at, 0)), 0) AS max_edited FROM web_messages",
						)
						.get()
		) as { max_id: number; max_edited: number };
		return { maxId: row.max_id, maxEditedAt: row.max_edited };
	});
}

export function readWebChanges(
	homeDir: string,
	afterId: number,
	afterEditedAt: number,
	conversation?: string,
	limit = 100,
): WebMessageRow[] {
	return withReadonlyDb(homeDir, [], (db) => {
		const rows = (
			conversation !== undefined
				? db
						.query(
							`SELECT * FROM web_messages
							 WHERE conversation = ? AND (id > ? OR (edited_at IS NOT NULL AND edited_at > ?))
							 ORDER BY id ASC LIMIT ?`,
						)
						.all(conversation, afterId, afterEditedAt, limit)
				: db
						.query(
							`SELECT * FROM web_messages
							 WHERE (id > ? OR (edited_at IS NOT NULL AND edited_at > ?))
							 ORDER BY id ASC LIMIT ?`,
						)
						.all(afterId, afterEditedAt, limit)
		) as WebMessageSql[];
		return rows.map(toRow);
	});
}
