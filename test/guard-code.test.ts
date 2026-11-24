import { describe, expect, test } from "bun:test";
import { classifyLaneCompletion } from "../src/lanes/integrity";

const GUARD = "guard_deletion_without_adversarial_regression";
const DIFF = (...lines: string[]): string =>
	["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", ...lines].join("\n");
const verdict = (before: string, after?: string): string[] =>
	classifyLaneCompletion({
		summary: "done",
		diff: DIFF(`-${before}`, ...(after === undefined ? [] : [`+${after}`])),
	}).map((refusal) => refusal.category);
/** `${expression}` written without the literal sequence in this source. */
const hole = (expression: string): string => ["$", `{${expression}}`].join("");
const template = (text: string): string => `\`${text}\``;

describe("guard message edits (T-20261124-03 AC-3)", () => {
	const before = 'assert(x, "msg");';

	test("a plain string becomes a template that only reads values: not a deletion", () => {
		expect(verdict(before, `assert(x, ${template(`msg ${hole("name")}`)});`)).toEqual([]);
		expect(verdict(before, `assert(x, ${template(`msg ${hole("a.b")}`)});`)).toEqual([]);
		expect(verdict(before, `assert(x, ${template(`msg ${hole("a?.b")}`)});`)).toEqual([]);
		expect(verdict(before, `assert(x, ${template(`msg ${hole("a[0]")}`)});`)).toEqual([]);
		expect(verdict(before, `assert(x, ${template(`msg ${hole('a["k"]')}`)});`)).toEqual([]);
	});

	test("a call, an operator or a nested template inside the interpolation stays code", () => {
		expect(verdict(before, `assert(x, ${template(`msg ${hole("f()")}`)});`)).toEqual([GUARD]);
		expect(verdict(before, `assert(x, ${template(hole("a + b"))});`)).toEqual([GUARD]);
		expect(verdict(before, `assert(x, ${template(hole(`f(${template("x")})`))});`)).toEqual([GUARD]);
	});

	test("an assert line that is only removed is a deletion", () => {
		expect(verdict(before)).toEqual([GUARD]);
	});

	test("the template scanner follows braces and quotes inside the interpolation", () => {
		// A closing brace inside a string in the hole does not end it; the template after it is still blanked.
		const edited = `assert(x, ${template(`a ${hole('f("}")')} b`)}, ${template(`c ${hole("d")}`)});`;
		expect(verdict('assert(x, "a", "c");', edited)).toEqual([GUARD]);
		expect(verdict(`assert(x, ${template(`a ${hole("n")} b`)}, "c");`, 'assert(x, "z", "c");')).toEqual([]);
	});
});
