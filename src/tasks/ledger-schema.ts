import type { Database } from "bun:sqlite";
import type { LanePrLand } from "../lanes/pr-land-types";

/**
 * Where a task's own PR landing stands (`tasks.land_json`, `mode` pr only): `active` is being driven, `blocked` and
 * `held` wait for the owner, `rework` sent the worker back. `prLand` is the same record a lane keeps.
 */
export interface TaskLandRecord {
	mode: "pr";
	state: "active" | "blocked" | "held" | "rework";
	requestedBy: "auto" | "owner";
	sha?: string;
	baseBranch?: string;
	reason?: string;
	prLand: LanePrLand;
}

export const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
	task_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	risk TEXT NOT NULL,
	origin_key TEXT NOT NULL,
	thread_ref TEXT NOT NULL,
	host TEXT,
	repo TEXT NOT NULL,
	worktree TEXT NOT NULL,
	branch TEXT NOT NULL,
	agent TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('working','blocked','review','done','cancelled')),
	acceptance_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	progress_at INTEGER,
	reminded_at INTEGER,
	notices_json TEXT NOT NULL DEFAULT '{}',
	closed_at INTEGER,
	worker_model TEXT,
	tier TEXT,
	tier_reason TEXT,
	tier_confidence TEXT,
	gate_json TEXT,
	check_json TEXT,
	base_sha TEXT,
	docs_dir TEXT,
	land_json TEXT,
	runtime TEXT NOT NULL DEFAULT 'herdr'
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_ref);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS task_transitions (
	transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id TEXT NOT NULL REFERENCES tasks(task_id),
	from_status TEXT,
	to_status TEXT NOT NULL,
	actor TEXT NOT NULL CHECK (actor IN ('bot','human','core-land')),
	reason TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_transitions_task ON task_transitions(task_id, transition_id);
`;

/** Columns added after the first `tasks` schema; rows that predate them read null. */
const LATER_TASK_COLUMNS = [
	"worker_model",
	"tier",
	"tier_reason",
	"tier_confidence",
	"gate_json",
	"check_json",
	"base_sha",
	"docs_dir",
	"land_json",
] as const;

/**
 * Creates the tables in a database that may predate them and adds later columns (idempotent). The one row update: a
 * task from before `docs_dir` gets the directory its records always had, `<worktree>/docs/tasks/<id>`; its `base_sha`
 * stays NULL (`no_base`, as a branch without its docs commit was).
 */
export function migrateTaskSchema(db: Database): void {
	db.run(TASK_SCHEMA);
	const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
	for (const column of LATER_TASK_COLUMNS) {
		if (!columns.some((existing) => existing.name === column)) db.run(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
	}
	// Every task from before `runtime` ran on herdr and keeps doing so to its end (`src/tasks/runtime.ts`).
	if (!columns.some((existing) => existing.name === "runtime"))
		db.run("ALTER TABLE tasks ADD COLUMN runtime TEXT NOT NULL DEFAULT 'herdr'");
	db.run("UPDATE tasks SET docs_dir = worktree || '/docs/tasks/' || task_id WHERE docs_dir IS NULL");
	migrateTransitionActors(db);
}

/**
 * The `core-land` actor widens a CHECK constraint, which SQLite cannot ALTER: a task_transitions table without it is
 * rebuilt (rename, create, copy, drop) in one transaction. Existing rows keep their ids and data.
 */
function migrateTransitionActors(db: Database): void {
	const current = db
		.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_transitions'")
		.get() as {
		sql: string;
	} | null;
	if (current === null || current.sql.includes("'core-land'")) return;
	const ddl = TASK_SCHEMA.slice(TASK_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS task_transitions"));
	db.transaction(() => {
		db.run("DROP INDEX IF EXISTS task_transitions_task");
		db.run("ALTER TABLE task_transitions RENAME TO task_transitions_old");
		db.run(ddl);
		db.run(
			"INSERT INTO task_transitions (transition_id, task_id, from_status, to_status, actor, reason, at) SELECT transition_id, task_id, from_status, to_status, actor, reason, at FROM task_transitions_old",
		);
		db.run("DROP TABLE task_transitions_old");
	})();
}
