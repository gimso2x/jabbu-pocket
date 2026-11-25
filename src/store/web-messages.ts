import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { referencedWebFileNames } from "./web-files";

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
	threadCount: number;
}

export interface WebThreadSummary {
	thread: string;
	parentMessageId?: number;
	replyCount: number;
	lastText: string;
	lastRole: WebMessageRole;
	lastAt: number;
	openApprovals: number;
	inProgress: boolean;
}

/** Deterministic thread id (`GRAMMAR.web.thread` valid) rooted at root message `id`. */
export function threadIdForMessage(messageId: number): string {
	return `w_m${String(messageId).padStart(7, "0")}`;
}

/** Parses `w_m0000042` back to its numeric parent root message id, or `undefined` for ad-hoc thread ids. */
export function parentMessageIdOfThread(threadId: string): number | undefined {
	const match = /^w_m0*([1-9]\d{0,14})$/.exec(threadId);
	if (match?.[1] === undefined) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
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

	/** Base names of every file a message row names; the media sweep keeps the uploads among them. */
	referencedFileNames(): Set<string> {
		return referencedWebFileNames(this.#db);
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

function countSql(db: Database, sql: string, ...params: SQLQueryBindings[]): number {
	return (db.query(sql).get(...params) as { n: number }).n;
}

function hasApprovalsTable(db: Database): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() !== null;
}

function hasActiveStatus(db: Database, conversation: string, thread?: string): boolean {
	const col = thread === undefined ? "conversation = ?" : "conversation = ? AND thread = ?";
	const sql = `SELECT 1 FROM web_messages WHERE ${col} AND role = 'status' AND card_json LIKE '%"deleted":false%' LIMIT 1`;
	return (thread === undefined ? db.query(sql).get(conversation) : db.query(sql).get(conversation, thread)) !== null;
}

function listWebConversationsDb(db: Database, limit = 50): WebConversationSummary[] {
	const convs = db
		.query(
			`SELECT conversation, MAX(id) AS max_id, MAX(COALESCE(edited_at, created_at)) AS updated_at
			 FROM web_messages GROUP BY conversation ORDER BY updated_at DESC, max_id DESC LIMIT ?`,
		)
		.all(Math.max(1, Math.min(limit, 200))) as Array<{ conversation: string; max_id: number; updated_at: number }>;
	const hasApprovals = hasApprovalsTable(db);
	return convs.map((entry) => {
		const rootRows = (
			db
				.query("SELECT * FROM web_messages WHERE conversation = ? AND thread IS NULL ORDER BY id ASC LIMIT 20")
				.all(entry.conversation) as WebMessageSql[]
		).map(toRow);
		const lastRow = db
			.query("SELECT * FROM web_messages WHERE conversation = ? AND role != 'status' ORDER BY id DESC LIMIT 1")
			.get(entry.conversation) as WebMessageSql | null;
		const last = lastRow === null ? rootRows.at(-1) : toRow(lastRow);
		const openApprovals = hasApprovals
			? countSql(db, "SELECT COUNT(*) AS n FROM approvals WHERE channel = ? AND status = 'pending'", entry.conversation)
			: 0;
		const threadCount = countSql(
			db,
			"SELECT COUNT(DISTINCT thread) AS n FROM web_messages WHERE conversation = ? AND thread IS NOT NULL AND role NOT IN ('status','system')",
			entry.conversation,
		);
		return {
			conversation: entry.conversation,
			title: titleOfConversation(rootRows) || entry.conversation,
			lastId: entry.max_id,
			lastText: last?.text.slice(0, 120) ?? "",
			lastRole: last?.role ?? "system",
			updatedAt: entry.updated_at,
			openApprovals,
			inProgress: hasActiveStatus(db, entry.conversation),
			threadCount,
		};
	});
}

function listWebThreadsDb(db: Database, conversation: string): WebThreadSummary[] {
	const groups = db
		.query(
			`SELECT thread, MAX(id) AS max_id, MAX(COALESCE(edited_at, created_at)) AS last_at
			 FROM web_messages WHERE conversation = ? AND thread IS NOT NULL
			 GROUP BY thread ORDER BY last_at DESC, max_id DESC LIMIT 100`,
		)
		.all(conversation) as Array<{ thread: string; max_id: number; last_at: number }>;
	const hasApprovals = hasApprovalsTable(db);
	return groups.map((g) => {
		const replyCount = countSql(
			db,
			"SELECT COUNT(*) AS n FROM web_messages WHERE conversation = ? AND thread = ? AND role NOT IN ('status','system')",
			conversation,
			g.thread,
		);
		const lastVisible = db
			.query(
				"SELECT * FROM web_messages WHERE conversation = ? AND thread = ? AND role != 'status' ORDER BY id DESC LIMIT 1",
			)
			.get(conversation, g.thread) as WebMessageSql | null;
		const openApprovals = hasApprovals
			? countSql(
					db,
					`SELECT COUNT(*) AS n FROM approvals a WHERE a.channel = ? AND a.status = 'pending'
					 AND EXISTS (SELECT 1 FROM web_messages w WHERE w.conversation = ? AND w.thread = ? AND CAST(w.id AS TEXT) = a.message_ts)`,
					conversation,
					conversation,
					g.thread,
				)
			: 0;
		const parentMessageId = parentMessageIdOfThread(g.thread);
		return {
			thread: g.thread,
			...(parentMessageId === undefined ? {} : { parentMessageId }),
			replyCount,
			lastText: lastVisible?.text.slice(0, 120) ?? "",
			lastRole: lastVisible?.role ?? "system",
			lastAt: g.last_at,
			openApprovals,
			inProgress: hasActiveStatus(db, conversation, g.thread),
		};
	});
}

function withReadonlyDb<T>(homeDir: string, fallback: T, read: (db: Database) => T): T {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return fallback;
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		return hasWebMessagesTable(db) ? read(db) : fallback;
	} finally {
		db.close();
	}
}

export const readWebConversations = (homeDir: string, limit = 50): WebConversationSummary[] =>
	withReadonlyDb(homeDir, [], (db) => listWebConversationsDb(db, limit));

export const readWebMessages = (
	homeDir: string,
	conversation: string,
	opts: { thread?: string; after?: number; limit?: number } = {},
): WebMessageRow[] => withReadonlyDb(homeDir, [], (db) => listWebMessagesDb(db, conversation, opts));

export const readWebThreads = (homeDir: string, conversation: string): WebThreadSummary[] =>
	withReadonlyDb(homeDir, [], (db) => listWebThreadsDb(db, conversation));

export const readWebMessageById = (homeDir: string, id: number): WebMessageRow | undefined =>
	withReadonlyDb(homeDir, undefined, (db) => {
		const row = db.query("SELECT * FROM web_messages WHERE id = ?").get(id) as WebMessageSql | null;
		return row === null ? undefined : toRow(row);
	});

export function readWebWatermark(homeDir: string, conversation?: string): { maxId: number; maxEditedAt: number } {
	return withReadonlyDb(homeDir, { maxId: 0, maxEditedAt: 0 }, (db) => {
		const cond = conversation === undefined ? "" : " WHERE conversation = ?";
		const cols = "COALESCE(MAX(id), 0) AS max_id, COALESCE(MAX(COALESCE(edited_at, 0)), 0) AS max_edited";
		const sql = `SELECT ${cols} FROM web_messages${cond}`;
		const row = (conversation === undefined ? db.query(sql).get() : db.query(sql).get(conversation)) as {
			max_id: number;
			max_edited: number;
		};
		return { maxId: row.max_id, maxEditedAt: row.max_edited };
	});
}

export function readWebChanges(
	homeDir: string,
	afterId: number,
	afterEditedAt: number,
	conversation?: string,
	limit = 100,
	pageAfterId = 0,
): WebMessageRow[] {
	return withReadonlyDb(homeDir, [], (db) => {
		const pred = "id > ? AND (id > ? OR (edited_at IS NOT NULL AND edited_at > ?))";
		const sql = `SELECT * FROM web_messages WHERE ${conversation === undefined ? "" : "conversation = ? AND "}${pred} ORDER BY id ASC LIMIT ?`;
		const res =
			conversation === undefined
				? db.query(sql).all(pageAfterId, afterId, afterEditedAt, limit)
				: db.query(sql).all(conversation, pageAfterId, afterId, afterEditedAt, limit);
		return (res as WebMessageSql[]).map(toRow);
	});
}
