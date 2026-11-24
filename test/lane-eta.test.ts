import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { buildLaneOutcomeCard } from "../src/lanes/card";
import type { LaneRow } from "../src/lanes/status";
import { laneDurationSamples } from "../src/store/lane-duration";
import { typicalDuration } from "../src/store/turn-duration";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const MIN = 60_000;

function lanesDb(durationsMin: number[]): Database {
	const db = new Database(":memory:", { strict: true });
	db.run(
		"CREATE TABLE lanes (name TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
	);
	durationsMin.forEach((minutes, i) => {
		const closedAt = NOW - (i + 1) * MIN;
		db.query("INSERT INTO lanes VALUES (?, 'closed', ?, ?)").run(`lane-${i}`, closedAt - minutes * MIN, closedAt);
	});
	db.query("INSERT INTO lanes VALUES ('open', 'working', ?, ?)").run(NOW - 5 * MIN, NOW);
	return db;
}

describe("lane ETA", () => {
	test("under 10 closed lanes there is no typical duration", () => {
		expect(typicalDuration(laneDurationSamples(lanesDb([5, 6, 7, 8, 9, 10, 11, 12, 13]), NOW))).toBeUndefined();
	});

	test("10 or more closed lanes give median and p90; open lanes are no sample", () => {
		const samples = laneDurationSamples(lanesDb([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), NOW);
		expect(samples).toHaveLength(10);
		expect(typicalDuration(samples)).toEqual({ medianMs: 50 * MIN, p90Ms: 90 * MIN });
	});

	test("the rework card shows the range only when a typical duration is known", () => {
		const lane = {
			name: "l",
			title: "제목",
			threadRef: "1:2",
			originKey: "o",
			cwd: "/c",
			sessionDir: "/s",
			status: "working",
			history: [],
			meta: { startedAt: NOW, lastProgressAt: NOW, steerSeq: 0 },
			createdAt: NOW,
			updatedAt: NOW,
		} as LaneRow;
		const without = buildLaneOutcomeCard(lane, { kind: "rework", reason: "다시 엽니다" });
		expect(without.text).not.toContain("보통");
		const withEta = buildLaneOutcomeCard(lane, {
			kind: "rework",
			reason: "다시 엽니다",
			typical: { medianMs: 50 * MIN, p90Ms: 90 * MIN },
		});
		expect(withEta.text).toContain("보통 50~90분");
	});
});
