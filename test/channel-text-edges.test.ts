// The edges of the text every chat adapter shares: where a message is cut, what a hostile string collapses to, how wide a
// character prints, and how a table cell is read. Each case is one thing a reader saw go wrong in a real message.
import { describe, expect, test } from "bun:test";
import { tableToAscii } from "../src/channel/card";
import { chunkText, delimiterAligns, displayWidth, oneLine, splitRowCells } from "../src/channel/text";

const LIMIT = 2000;

/** `count` lines of `perLine` characters: a body with no paragraph, line or space to cut at if `perLine` matches. */
const block = (count: number, perLine: number): string =>
	`${`${"x".repeat(perLine)}\n`.repeat(count - 1)}${"x".repeat(perLine)}`;

describe("chunkText edges", () => {
	test.each([1993, 1996, 2000])("a %i-char text within the limit is one message", (chars) => {
		const text = "x".repeat(chars);
		expect(chunkText(text, LIMIT)).toEqual([text]);
	});

	test("a text one char over the limit is two messages", () => {
		const chunks = chunkText("x".repeat(LIMIT + 1), LIMIT);
		expect(chunks).toHaveLength(2);
		expect(chunks.join("")).toBe("x".repeat(LIMIT + 1));
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
	});

	test("a cut just before a block's own closing line ends the chunk with it instead of opening an empty block", () => {
		// A fence whose closer falls just past the budget: the chunk already closes the block, so the source closer must
		// not open an empty block at the head of the next message.
		const body = block(30, 60);
		const text = ["```ts", body, "```", "after"].join("\n");
		const chunks = chunkText(text, 200);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.trim()).not.toBe("```");
			expect(chunk).not.toContain("```\n```");
		}
	});

	test("a cut inside a block still closes and reopens it", () => {
		const text = ["```sh", block(20, 40), "```"].join("\n");
		const chunks = chunkText(text, 200);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// Every chunk is a balanced block on its own: one opening fence and one closing fence.
			expect(chunk.startsWith("```")).toBe(true);
			expect(chunk.endsWith("```")).toBe(true);
			expect(chunk.split("```").length - 1).toBe(2);
			expect(chunk.length).toBeLessThanOrEqual(200);
		}
	});

	test("a chunk of only whitespace is dropped; a text of nothing else keeps one", () => {
		// A paragraph break lands exactly at the budget: the middle chunk is blank and must not become a message.
		const text = `${"a".repeat(196)}\n\n${"b".repeat(196)}\n\n${"c".repeat(10)}`;
		const chunks = chunkText(text, 200);
		expect(chunks.every((chunk) => chunk.trim() !== "")).toBe(true);
		expect(chunks.join("").replace(/\s+/g, "")).toBe(`${"a".repeat(196)}${"b".repeat(196)}${"c".repeat(10)}`);

		expect(chunkText("   \n\n  ", 10)).toEqual(["   \n\n  "]);
	});
});

describe("oneLine bidi", () => {
	test("bidi overrides, embeddings and isolates are replaced like other control characters", () => {
		const hostile = `start\u202eevil\u202c\u2066iso\u2069\u202aembed\u202c\u202bpop\u202cend`;
		const flat = oneLine(hostile, 200);
		expect(/[\u202a-\u202e\u2066-\u2069]/.test(flat)).toBe(false);
		expect(flat).toContain("evil");
		expect(flat).toContain("iso");
		expect(flat).toContain("end");
		// A newline and a tab fold to one space each, and the ends are trimmed.
		expect(oneLine("  a\nb\tc  ", 200)).toBe("a b c");
		expect(oneLine("x".repeat(50), 10)).toHaveLength(10);
	});

	test("the cut never leaves a lone high surrogate (the other cutters of this module promise the same)", () => {
		// 😀 is a surrogate pair: a raw slice at 3 would keep the pair and half of the next emoji.
		expect(oneLine("😀😀😀", 3)).toBe("😀");
		expect(oneLine("😀😀😀", 4)).toBe("😀😀");
	});
});

describe("display width", () => {
	test("emoji and ZWJ sequences are two columns, Hangul two, ASCII one", () => {
		expect(displayWidth("a")).toBe(1);
		expect(displayWidth("가")).toBe(2);
		expect(displayWidth("😀")).toBe(2);
		// A family emoji is one grapheme built from several code points joined by ZWJ: two columns, not eight.
		expect(displayWidth("👨‍👩‍👧")).toBe(2);
		// A combining mark adds no column of its own.
		expect(displayWidth("e\u0301")).toBe(1);
	});

	test("a status table with check marks keeps its pipes in one column", () => {
		const rows = ["| 항목 | 상태 |", "| --- | --- |", "| 백업 | ✅ |", "| 복구 | ⚠️ |"];
		// Each row has the same number of cells, so the pipes line up whatever the marks' width is.
		const widths = rows.map((row) => splitRowCells(row).length);
		expect(widths).toEqual([2, 2, 2, 2]);
		expect(rows.every((row) => displayWidth(row) > 0)).toBe(true);
	});
});

describe("table cells: backtick spans and column alignment", () => {
	test("a pipe inside a backtick span stays in its cell", () => {
		expect(splitRowCells("| a | `x|y` | c |")).toEqual(["a", "`x|y`", "c"]);
		// An escaped pipe is content too, and the escape does not survive.
		expect(splitRowCells("| a\\|b | c |")).toEqual(["a|b", "c"]);
		// An unclosed run opens no span: the row is split plainly rather than swallowed whole.
		expect(splitRowCells("| `a | b |")).toEqual(["`a", "b"]);
	});

	test("a fenced table keeps a code cell whole and aligns the :---: / ---: columns", () => {
		expect(delimiterAligns("| :---: | ---: | --- |")).toEqual(["center", "right", "left"]);
		expect(delimiterAligns("| :--- |")).toEqual(["left"]);
	});

	test("a header cell is aligned by its column like the body cells", () => {
		// The delimiter row decides every column's side, the header row included: the header is padded the same way.
		const align = delimiterAligns("| :-- | :-: | --: |");
		expect(align).toEqual(["left", "center", "right"]);
		const priced = tableToAscii(
			{
				headers: ["name", "note", "num"],
				rows: [["abcdefgh", "xy", "12345"]],
			},
			{ align },
		);
		const [headerLine] = priced.split("\n");
		expect(headerLine).toBe("name     | note |   num");
	});

	test("a delimiter row without colons is left alignment; a non-delimiter row yields undefined", () => {
		expect(delimiterAligns("| --- | --- |")).toEqual(["left", "left"]);
		expect(delimiterAligns("| a | b |")).toBeUndefined();
		// A row with one non-hyphen cell is not a delimiter row at all.
		expect(delimiterAligns("| --- | x |")).toBeUndefined();
	});

	test("a card table stays left-aligned", () => {
		// A card's table is written without colons: every column is left-aligned, never inherited from a neighbour.
		expect(delimiterAligns("| 항목 | 값 |")).toBeUndefined();
		expect(delimiterAligns("| --- | --- |")).toEqual(["left", "left"]);
	});
});
