import { describe, expect, test } from "bun:test";
import { clampBacktickRuns, maxBacktickRun, outsideCode } from "../src/discord/code-spans";

/**
 * Direct coverage for the code-span scanner behind `format.ts`: what it calls
 * code is never rewritten, what it calls plain always is, and clamping only
 * ever inserts ZWSP. The fuzz loop is bounded and seeded: 20k cases run in
 * well under a second.
 */

let seed = 0xc0de1234;
function rnd(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}
const alphabet = ["`", "\\", "\n", "a", "가", " ", "~", "*", "```", "``", "x", "\t", "|"];

function gen(): string {
	const n = Math.floor(rnd() * 24);
	let s = "";
	for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
	return s;
}

describe("outsideCode", () => {
	test("identity over 20k backtick/escape/fence soups: never loses or reorders a byte", () => {
		for (let i = 0; i < 20_000; i++) {
			const text = gen();
			expect(outsideCode(text, (x) => x)).toBe(text);
		}
	});

	test("convert never touches fenced or inline code", () => {
		const mask = (plain: string) => plain.replace(/[a-z]/g, "#");
		expect(outsideCode("```\nconst a = 1;\n```\nhello", mask)).toBe("```\nconst a = 1;\n```\n#####");
		// a 4-backtick fence wraps 3-backtick lines: everything inside stays verbatim
		expect(outsideCode("````\n```\nnested\n```\n````\ntail", mask)).toBe("````\n```\nnested\n```\n````\n####");
		expect(outsideCode("pre `inline code` post", mask)).toBe("### `inline code` ####");
		// an unclosed fence keeps the rest of the message verbatim
		expect(outsideCode("```\nunclosed stays\nverbatim", mask)).toBe("```\nunclosed stays\nverbatim");
		// a run closes only on an unescaped run of the exact same length
		expect(outsideCode("`a` b ``c`` d", mask)).toBe("`a` # ``c`` #");
	});

	test("an escaped opener is not an opener: the whole line converts", () => {
		const mask = (plain: string) => plain.replace(/[a-z]/g, "#");
		expect(outsideCode("\\`escaped` plain", mask)).toBe("\\`#######` #####");
	});
});

describe("clampBacktickRuns", () => {
	test("no run reaches the cap, and stripping ZWSP restores the input", () => {
		for (let i = 0; i < 20_000; i++) {
			const text = gen();
			const cap = 2 + Math.floor(rnd() * 4);
			const clamped = clampBacktickRuns(text, cap);
			expect(maxBacktickRun(clamped)).toBeLessThan(cap);
			expect(clamped.replaceAll("\u200B", "")).toBe(text);
		}
	});

	test("a run exactly at the cap is split once, shorter runs pass through", () => {
		expect(clampBacktickRuns("````x``", 4)).toBe("```\u200B`x``");
		expect(clampBacktickRuns("```x`", 4)).toBe("```x`");
	});
});
