import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { readStatusFromDb } from "../src/daemon/status";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-status-hs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function openLedger(): string {
	const dbPath = join(dir, "jabbu.db");
	openBotStore(dbPath, { now: () => Date.parse("2026-10-19T06:00:00Z") }, "Asia/Seoul").close();
	return dbPath;
}

// The daemon's own `status()` reports the host session numbers under `hostSessions`; the read-only fallback used when
// no daemon answers (`jabbu-pocket status --json`, the dashboard) must use the same key, not loose top-level fields.
test("status read from the ledger carries the host session numbers under hostSessions", () => {
	const report = readStatusFromDb(openLedger(), "omp-test 0", "Asia/Seoul", { hostSessionCeiling: 8 });
	expect(report.hostSessions).toEqual({ count: expect.any(Number), ceiling: 8 });
	expect(Object.keys(report)).not.toContain("count");
	expect(Object.keys(report)).not.toContain("ceiling");
});

test("status read from the ledger has no hostSessions while no ceiling is decided", () => {
	const report = readStatusFromDb(openLedger(), "omp-test 0", "Asia/Seoul", {});
	expect(report.hostSessions).toBeUndefined();
});
