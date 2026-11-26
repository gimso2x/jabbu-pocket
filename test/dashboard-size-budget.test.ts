import { describe, expect, test } from "bun:test";
import { PAGE_CSS } from "../src/dashboard/assets";
import { SCRIPT } from "../src/dashboard/html";

// Budgets and their measured baseline live in docs/performance.md. Raise a budget only by editing that page in the same change.
const KIB = 1024;
// 2026-11-26 T-20261126-01: raised for headless TASK panel (12/64 -> 12.5/68 KiB).
// 2026-11-27 UX benchmark (P0-P2): raised to 13.5 / 70 KiB (no docs/performance.md in repo).
// 2026-11-27 ops UX: raised script budget to 74 KiB for idle inbox pulse, peer health/alerts, bot filters, channel names.
const STYLE_GZIP_BUDGET = 13.5 * KIB;
const SCRIPT_GZIP_BUDGET = 74 * KIB;

describe("dashboard size budget", () => {
	// The page's script and style ship as cached assets, but a first load still pays for them, so they carry the budget.
	test("the page style stays within its gzip budget", () => {
		expect(Bun.gzipSync(PAGE_CSS).length).toBeLessThanOrEqual(STYLE_GZIP_BUDGET);
	});

	test("the page script stays within its gzip budget", () => {
		expect(Bun.gzipSync(SCRIPT).length).toBeLessThanOrEqual(SCRIPT_GZIP_BUDGET);
	});
});
