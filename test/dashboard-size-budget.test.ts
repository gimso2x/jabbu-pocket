import { describe, expect, test } from "bun:test";
import { PAGE_CSS } from "../src/dashboard/assets";
import { SCRIPT } from "../src/dashboard/html";

// Budgets and their measured baseline live in docs/performance.md. Raise a budget only by editing that page in the same change.
const KIB = 1024;
const STYLE_GZIP_BUDGET = 12 * KIB;
const SCRIPT_GZIP_BUDGET = 64 * KIB;

describe("dashboard size budget", () => {
	// The page's script and style ship as cached assets, but a first load still pays for them, so they carry the budget.
	test("the page style stays within its gzip budget", () => {
		expect(Bun.gzipSync(PAGE_CSS).length).toBeLessThanOrEqual(STYLE_GZIP_BUDGET);
	});

	test("the page script stays within its gzip budget", () => {
		expect(Bun.gzipSync(SCRIPT).length).toBeLessThanOrEqual(SCRIPT_GZIP_BUDGET);
	});
});
