import { describe, expect, test } from "bun:test";
import type { IntegrityRefusal } from "../src/lanes/integrity";
import { refusalFingerprint } from "../src/lanes/integrity-approval";
import { capRefusals, MAX_REFUSALS, refusalCardLines } from "../src/lanes/refusal-cap";

const RANKED: IntegrityRefusal["category"][] = [
	"lane_diff_unavailable",
	"guard_deletion_without_adversarial_regression",
	"undeclared_feature_removal",
	"stub_implementation",
	"skipped_test",
	"unproven_claim_word",
	"unfinished_work_marker",
];

const make = (category: IntegrityRefusal["category"], n: number): IntegrityRefusal => ({
	category,
	excerpt: `${category} #${n}`,
	remedy: "r",
});

describe("capRefusals", () => {
	test("a list within the cap keeps its order", () => {
		const list = [make("unfinished_work_marker", 0), make("skipped_test", 0), make("unfinished_work_marker", 1)];
		expect(capRefusals(list)).toEqual(list);
		expect(capRefusals(list)).not.toBe(list);
	});

	test("14 refusals of 7 categories, two each: every category keeps its first, the spare slot goes to the heaviest", () => {
		const list = RANKED.toReversed().flatMap((c) => [make(c, 0), make(c, 1)]);
		expect(list).toHaveLength(14);
		const out = capRefusals(list);
		expect(out).toHaveLength(MAX_REFUSALS);
		expect(out.map((r) => r.excerpt)).toEqual([
			"lane_diff_unavailable #0",
			"lane_diff_unavailable #1",
			...RANKED.slice(1).map((c) => `${c} #0`),
		]);
	});

	test("the spare slots go by rank, in original order within a category", () => {
		const list = [
			...Array.from({ length: 10 }, (_, i) => make("unfinished_work_marker", i)),
			make("stub_implementation", 0),
			make("stub_implementation", 1),
		];
		const out = capRefusals(list);
		expect(out).toHaveLength(MAX_REFUSALS);
		expect(out.map((r) => r.excerpt)).toEqual([
			"stub_implementation #0",
			"stub_implementation #1",
			...[0, 1, 2, 3, 4, 5].map((i) => `unfinished_work_marker #${i}`),
		]);
	});
});

describe("refusalFingerprint over the cap", () => {
	test("12 TODOs differ from 12 TODOs plus a stub", () => {
		const todos = Array.from({ length: 12 }, (_, i) => make("unfinished_work_marker", i));
		const withStub = [...todos, make("stub_implementation", 0)];
		expect(refusalFingerprint(capRefusals(todos))).not.toBe(refusalFingerprint(capRefusals(withStub)));
	});
});

describe("refusalCardLines", () => {
	test("a list at the cap gets the omission notice, a shorter one does not", () => {
		const full = capRefusals(Array.from({ length: 12 }, (_, i) => make("unfinished_work_marker", i)));
		const lines = refusalCardLines(full);
		expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(MAX_REFUSALS);
		expect(lines).toHaveLength(MAX_REFUSALS + 1);
		expect(refusalCardLines(full.slice(0, 3))).toHaveLength(3);
	});
});
