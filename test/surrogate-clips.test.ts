// A cap that lands between the halves of an emoji must drop the whole emoji: a lone high surrogate in a prompt line or a
// notice is rejected by JSON consumers downstream (a provider answers 400 "no low surrogate").
import { describe, expect, test } from "bun:test";
import { oneLine } from "../src/channel/text";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("caps never split a surrogate pair", () => {
	test("oneLine cuts before the emoji that straddles the cap", () => {
		const out = oneLine(`${"a".repeat(9)}😀tail`, 10);
		expect(out).toBe("a".repeat(9));
		expect(LONE_SURROGATE.test(out)).toBe(false);
		expect(oneLine(`${"a".repeat(8)}😀tail`, 10)).toBe(`${"a".repeat(8)}😀`);
	});
});
