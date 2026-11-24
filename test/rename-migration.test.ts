import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/db";
import { NewerSchemaError, readSchemaVersion, SCHEMA_VERSION } from "../src/store/schema-version";

/**
 * Schema 9 moves the old names out of a schema-8 ledger. The rows imitate a long-lived bot ledger (lane origins in
 * every table that keys by origin, wiki drafts of tasks and lanes, receipts in lane meta and task gates); ids, tokens
 * and paths are fake.
 */

let home: string;
let path: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-rename-"));
	chmodSync(home, 0o700);
	path = join(home, "jabbu.db");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const clock = { now: () => 1_700_000_000_000 };
const open = () => openStore({ path, clock, timezone: "Asia/Seoul", redact: (text: string) => text });

const OLD_LANE = "ompbot/work/fix-login";
const NEW_LANE = "jabbu/work/fix-login";
const CHAT = "discord/ch/100000000000000001/t/100000000000000002";
const SOURCE = "1".repeat(40);
const runtime = { head: "a".repeat(40), omp: "omp 18.0.0", kencrew: SOURCE, os: "linux", arch: "arm64" };
const LANE_META = {
	laneId: "L-TEST-1",
	review: { sha: "a".repeat(40), verdict: "pass", runtime },
	note: "kencrew 시절 메모: runtime.kencrew 문자열은 본문이다",
};
const TASK_GATE = {
	review: { sha: "b".repeat(40), runtime: { ...runtime, head: "b".repeat(40) }, summary: "kencrew 낱말이 든 요약" },
};
const TASK_DRAFT = { kind: "task", sourceId: "ompbot-task-T-TEST-1", title: "kencrew 제목", goal: "g" };
const LANE_DRAFT = { kind: "lane", sourceId: "ompbot-lane-L-TEST-1", title: "t", goal: "g" };

/** A ledger as the code before schema 9 left it: created by today's tables, then filled with old-name rows. */
function schema8Ledger(): void {
	open().close();
	const db = new Database(path);
	db.run("PRAGMA foreign_keys = ON");
	const at = 1_699_000_000_000;
	for (const key of [OLD_LANE, CHAT])
		db.query("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)").run(
			key,
			`/home/someone/.ompbot-test/sessions/${encodeURIComponent(key)}/1`,
			at,
		);
	db.query(
		"INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at) VALUES (?, ?, 1, ?, 'answered', ?)",
	).run("discord:900000000000000001", OLD_LANE, "kencrew 이름이 든 본문", at);
	db.query(
		"INSERT INTO deliveries (origin_key, op_ref, part, thread_ref, body, next_at, created_at) VALUES (?, 'op-1', 0, 't', 'b', ?, ?)",
	).run(OLD_LANE, at, at);
	db.query(
		"INSERT INTO lanes (name, title, thread_ref, origin_key, cwd, session_dir, meta, created_at, updated_at) VALUES ('fix-login', 't', 'discord:t1', ?, ?, ?, ?, ?, ?)",
	).run(
		OLD_LANE,
		"/home/someone/work/ompbot-t-1",
		"/home/someone/.ompbot-test/sessions/x",
		JSON.stringify(LANE_META),
		at,
		at,
	);
	db.query("INSERT INTO usage_daily (day, origin_key, cost, calls) VALUES ('2026-11-24', ?, 0.5, 3)").run(OLD_LANE);
	db.query("INSERT INTO board_reads (origin_key, channel) VALUES (?, 'general')").run(OLD_LANE);
	db.query(
		"INSERT INTO board_posts (channel, author_origin, author_label, text, created_at) VALUES ('general', ?, 'fix-login', ?, ?)",
	).run(OLD_LANE, "ompbot/work/fix-login 으로 시작하는 본문", at);
	db.query(
		"INSERT INTO approvals (approval_id, channel, message_ts, summary, status, created_at, expires_at, origin_key) VALUES ('ap-1', 'c', 'm', 's', 'approved', ?, ?, ?)",
	).run(at, at, OLD_LANE);
	db.query(
		"INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, repo, worktree, branch, agent, status, acceptance_json, created_at, updated_at, gate_json) VALUES ('T-TEST-1', 't', 'L2', ?, 'discord:t2', '/r', '/home/someone/work/ompbot-t-1', 'task/T-TEST-1', 'a', 'review', '[]', ?, ?, ?)",
	).run(OLD_LANE, at, at, JSON.stringify(TASK_GATE));
	const draft = db.query("INSERT INTO wiki_notes (source_id, state, draft, at) VALUES (?, ?, ?, ?)");
	draft.run("ompbot-task-T-TEST-1", "draft", JSON.stringify(TASK_DRAFT), at);
	draft.run("ompbot-lane-L-TEST-1", "draft", JSON.stringify(LANE_DRAFT), at);
	draft.run("ompbot-turns-abc123-2026-11-23", "sent", null, at);
	db.run("PRAGMA user_version = 8");
	db.close();
}

/** Every text cell of every table, as `table.column = value`. */
function textCells(): string[] {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'")
			.all() as Array<{ name: string }>;
		return tables.flatMap(({ name }) => {
			const rows = db.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
			return rows.flatMap((row) =>
				Object.entries(row).flatMap(([column, value]) =>
					typeof value === "string" ? [`${name}.${column} = ${value}`] : [],
				),
			);
		});
	} finally {
		db.close();
	}
}

function json(sql: string, ...args: string[]): unknown {
	const db = new Database(path, { readonly: true });
	try {
		const row = db.query(sql).get(...args) as { value: string };
		return JSON.parse(row.value);
	} finally {
		db.close();
	}
}

function schemaVersion(): number {
	const db = new Database(path, { readonly: true });
	try {
		return readSchemaVersion(db);
	} finally {
		db.close();
	}
}

describe("schema 9: old names leave the ledger", () => {
	test("a schema-8 ledger opens at 9 with lane origins, wiki source ids and receipt runtimes renamed", () => {
		schema8Ledger();
		const store = open();
		try {
			expect(store.getOrigin(NEW_LANE)?.epoch).toBe(1);
			expect(store.getOrigin(OLD_LANE)).toBeUndefined();
			expect(store.getLaneByOrigin(NEW_LANE)?.name).toBe("fix-login");
			expect(store.wikiNoteState("jabbu-task-T-TEST-1")).toEqual({
				state: "draft",
				draft: JSON.stringify({ ...TASK_DRAFT, sourceId: "jabbu-task-T-TEST-1" }),
			});
			expect(store.wikiNoteState("jabbu-lane-L-TEST-1")?.state).toBe("draft");
			expect(store.wikiNoteState("jabbu-turns-abc123-2026-11-23")).toEqual({ state: "sent" });
		} finally {
			store.close();
		}
		expect(schemaVersion()).toBe(9);

		const cells = textCells();
		// The lane origin moved in every origin column, found by a scan of all tables, not a list; bodies keep theirs.
		expect(cells.filter((cell) => cell.endsWith(`= ${OLD_LANE}`))).toEqual([]);
		expect(cells.filter((cell) => cell.endsWith(`= ${NEW_LANE}`)).sort()).toEqual(
			[
				"approvals.origin_key",
				"board_posts.author_origin",
				"board_reads.origin_key",
				"deliveries.origin_key",
				"inbound.origin_key",
				"lanes.origin_key",
				"origins.origin_key",
				"tasks.origin_key",
				"usage_daily.origin_key",
			].map((column) => `${column} = ${NEW_LANE}`),
		);
		expect(cells.filter((cell) => /= ompbot-(task|lane|turns)-/.test(cell))).toEqual([]);

		// Receipts: the runtime key is renamed in place, in order; the words in notes and summaries are not touched.
		type Receipt = { review: { runtime: object } };
		const meta = json("SELECT meta AS value FROM lanes WHERE name = 'fix-login'") as Receipt;
		const renamed = { head: runtime.head, omp: runtime.omp, source: SOURCE, os: "linux", arch: "arm64" };
		expect(meta).toEqual({ ...LANE_META, review: { ...LANE_META.review, runtime: renamed } });
		expect(Object.keys(meta.review.runtime)).toEqual(["head", "omp", "source", "os", "arch"]);
		const gate = json("SELECT gate_json AS value FROM tasks WHERE task_id = 'T-TEST-1'");
		expect(gate).toEqual({ review: { ...TASK_GATE.review, runtime: { ...renamed, head: "b".repeat(40) } } });

		// Bodies and absolute paths stay as they were (paths are the host move's job).
		expect(cells).toContain("inbound.text_ref = kencrew 이름이 든 본문");
		expect(cells).toContain("board_posts.text = ompbot/work/fix-login 으로 시작하는 본문");
		expect(cells).toContain("lanes.cwd = /home/someone/work/ompbot-t-1");
		expect(cells).toContain("tasks.worktree = /home/someone/work/ompbot-t-1");
	});

	test("the second open changes nothing", () => {
		schema8Ledger();
		open().close();
		const first = textCells();
		open().close();
		expect(textCells()).toEqual(first);
		expect(schemaVersion()).toBe(SCHEMA_VERSION);
	});

	test("a ledger already at 9 is not rewritten, even with old-looking values", () => {
		open().close();
		const db = new Database(path);
		db.query("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, '/s', 1)").run(OLD_LANE);
		db.close();
		open().close();
		expect(textCells()).toContain(`origins.origin_key = ${OLD_LANE}`);
	});

	test("the migrated ledger is above what schema-8 code accepts, and a ledger above its code is refused", () => {
		schema8Ledger();
		open().close();
		// Schema-8 code refuses a ledger whose user_version is above 8; the same rule here, one version up.
		expect(schemaVersion()).toBe(9);
		const db = new Database(path);
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		db.close();
		expect(open).toThrow(NewerSchemaError);
	});
});
