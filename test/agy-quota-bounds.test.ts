import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAccountPool } from "../src/omp/agy-account-pool";
import { DEFAULT_QUOTA_BLOCK_MS, parseResetDurationMs, QUOTA_RESET_BUFFER_MS } from "../src/omp/agy-quota";
import { createPendingTurn, handleAgyQuotaSwitch, type QuotaSwitchHost } from "../src/omp/agy-switch";

// Only exports that exist before the fix: the same file runs unchanged against the old and the new code.
const NOW = 1_000_000;
// The daemon always gives the pool a logger; markExhausted logs `until` as an ISO date.
const QUIET = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** One 429 on the only account, through the public switch path; returns the finals sent and the pool. */
async function quota429(
	detail: string,
): Promise<{ finals: Array<{ status: string; error?: string }>; pool: AgyAccountPool }> {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-quota-bounds-"));
	try {
		const pool = new AgyAccountPool({
			config: () => undefined,
			statePath: join(dir, "quota.json"),
			now: () => NOW,
			log: QUIET,
		});
		const turn = createPendingTurn("op1", "hello");
		turn.rateLimit = `agy rate limited (429): ${detail}`;
		turn.rateLimitDetail = detail;
		turn.rateLimitResetMs = parseResetDurationMs(detail);
		const finals: Array<{ status: string; error?: string }> = [];
		const host = {
			options: { accounts: pool, timezone: "Asia/Seoul" },
			started: () => true,
			activeTurn: () => turn,
			activeClient: () => undefined,
			currentAccount: () => ({ name: "a", tier: "primary", appDataDir: "x" }),
			now: () => NOW,
			dropSession: () => {},
			retireChild: () => {},
			finish: (_turn: unknown, final: { status: string; error?: string }) => finals.push(final),
		} as unknown as QuotaSwitchHost;
		await handleAgyQuotaSwitch(host, turn, {} as never);
		return { finals, pool };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const blockedUntil = (pool: AgyAccountPool): number | undefined => {
	for (let at = NOW; at < NOW + 400 * 86_400_000; at += 3_600_000) if (!pool.isBlocked("a", at)) return at;
	return undefined;
};

test("realistic resets are untouched: 2h30m and a 72h weekly-style reset block for exactly that long", async () => {
	for (const [phrase, ms] of [
		["Resets in 2h30m", 9_000_000],
		["Resets in 72h", 72 * 3_600_000],
	] as const) {
		const { finals, pool } = await quota429(`Individual quota reached. ${phrase}`);
		expect(finals).toHaveLength(1);
		expect(finals[0]?.status).toBe("error");
		expect(pool.isBlocked("a", NOW + ms + QUOTA_RESET_BUFFER_MS - 1)).toBe(true);
		expect(pool.isBlocked("a", NOW + ms + QUOTA_RESET_BUFFER_MS)).toBe(false);
	}
});

// Before the fix markExhausted threw RangeError (Invalid Date, from its log line) inside the switch: no final at all.
test("a reset past the Date range ends the turn once with the quota error and blocks for the default time", async () => {
	for (const phrase of ["Resets in 99999999999999h", "Resets in 3000000000h"]) {
		const { finals, pool } = await quota429(`Individual quota reached. ${phrase}`);
		expect(finals).toHaveLength(1);
		expect(finals[0]?.status).toBe("error");
		expect(pool.isBlocked("a", NOW)).toBe(true);
		expect(pool.isBlocked("a", NOW + DEFAULT_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS - 1)).toBe(true);
		expect(pool.isBlocked("a", NOW + DEFAULT_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS)).toBe(false);
		expect(blockedUntil(pool)).toBeDefined();
	}
});

test("a saved quota file loads only blocks that are finite, positive and inside the Date range", () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-quota-state-"));
	try {
		const statePath = join(dir, "quota.json");
		const blocked = {
			ok: 2_000_000,
			edge: 8.64e15,
			over: 8.64e15 + 1,
			huge: 1e300,
			inf: "INF",
			zero: 0,
			neg: -5,
			text: "7",
			nul: null,
		};
		// JSON.parse reads 1e999 as Infinity; build the text by hand since JSON.stringify would write null.
		const raw = JSON.stringify({ current: "ok", blocked }).replace('"INF"', "1e999");
		writeFileSync(statePath, raw);
		const pool = new AgyAccountPool({ config: () => undefined, statePath, now: () => NOW });
		const loaded = Object.keys(blocked).filter((name) => pool.isBlocked(name, NOW));
		expect(loaded.sort()).toEqual(["edge", "ok"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
