// `jabbu-pocket onboarding [--reset]` CLI 명령.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type CursorStore, ONBOARDING_CURSOR, RESET_STATE, readState, writeState } from "../onboarding/state";
import { hasHomeDatabase } from "./home-config";

export const ONBOARDING_USAGE = `  onboarding [--reset]           show the first-run onboarding state; --reset makes the next conversation a first run again
                                 (also repairs an unreadable state)
`;

/** The cursor table straight on the file: the CLI must not run the daemon store's boot recovery. */
function cursorStore(db: Database): CursorStore {
	return {
		getCursor: (key) =>
			(db.query("SELECT last_ts FROM slack_cursors WHERE cursor_key = ?").get(key) as { last_ts: string } | null)
				?.last_ts,
		setCursor: (key, value) => {
			db.query(
				"INSERT INTO slack_cursors (cursor_key, last_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(cursor_key) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at",
			).run(key, value, Date.now());
		},
	};
}

/** `jabbu-pocket onboarding [--reset]` 실행기. */
export function onboardingCommand(args: string[], homeDir: string): number {
	const { values, positionals } = parseArgs({
		args,
		options: { reset: { type: "boolean" } },
		allowPositionals: true,
	});
	if (positionals.length > 0) {
		process.stderr.write(`onboarding: too many arguments\n${ONBOARDING_USAGE}`);
		return 2;
	}
	if (!hasHomeDatabase("onboarding", homeDir)) return 1;
	const db = new Database(join(homeDir, "jabbu.db"), { create: false, strict: true });
	try {
		const store = cursorStore(db);
		if (values.reset === true) writeState(store, RESET_STATE);
		const read = readState(store);
		process.stdout.write(
			`${ONBOARDING_CURSOR} ${read.ok ? JSON.stringify(read.state) : "unreadable (running); repair with --reset"}\n`,
		);
		return 0;
	} finally {
		db.close();
	}
}
