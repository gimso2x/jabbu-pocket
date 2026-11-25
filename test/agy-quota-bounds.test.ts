import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAccountPool } from "../src/omp/agy-account-pool";
import { MAX_QUOTA_BLOCK_MS, parseResetDurationMs, QUOTA_RESET_BUFFER_MS } from "../src/omp/agy-quota";
import { createPendingTurn, handleAgyQuotaSwitch, type QuotaSwitchHost } from "../src/omp/agy-switch";

const HUGE = "Individual quota reached. Resets in 99999999999999h";

test("a reset phrase far past what a Date holds is cut to the longest block, not kept", () => {
	expect(parseResetDurationMs(HUGE)).toBe(MAX_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS);
	expect(parseResetDurationMs("Resets in 2h30m")).toBe(9_000_000 + QUOTA_RESET_BUFFER_MS);
});

// Persona: the only account hits a 429 whose text carries an absurd reset. Before: markExhausted threw RangeError
// (Invalid Date from the log line) inside a `void`ed switch, so the turn's final never went out.
test("a 429 with an absurd reset still ends the turn with the quota error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-quota-bounds-"));
	try {
		const pool = new AgyAccountPool({
			config: () => undefined,
			statePath: join(dir, "quota.json"),
			now: () => 1_000_000,
		});
		const turn = createPendingTurn("op1", "hello");
		turn.rateLimit = `agy rate limited (429): ${HUGE}`;
		turn.rateLimitDetail = HUGE;
		turn.rateLimitResetMs = parseResetDurationMs(HUGE);
		const finals: Array<{ status: string; error?: string | undefined }> = [];
		const host = {
			options: { accounts: pool, timezone: "Asia/Seoul" },
			started: () => true,
			activeTurn: () => turn,
			activeClient: () => undefined,
			currentAccount: () => ({ name: "a", tier: "primary", appDataDir: "x" }),
			now: () => 1_000_000,
			dropSession: () => {},
			retireChild: () => {},
			finish: (_turn: unknown, final: { status: string; error?: string }) => finals.push(final),
		} as unknown as QuotaSwitchHost;
		await handleAgyQuotaSwitch(host, turn, {} as never);
		expect(finals).toHaveLength(1);
		expect(finals[0]?.status).toBe("error");
		expect(pool.isBlocked("a", 1_000_000)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a saved block past the Date range is not loaded (it could not be shown in /status)", () => {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-quota-state-"));
	try {
		const statePath = join(dir, "quota.json");
		writeFileSync(statePath, JSON.stringify({ current: "a", blocked: { a: 1e300, b: 2_000_000 } }));
		const pool = new AgyAccountPool({ config: () => undefined, statePath });
		expect(pool.isBlocked("a", 1_000_000)).toBe(false);
		expect(pool.isBlocked("b", 1_000_000)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
