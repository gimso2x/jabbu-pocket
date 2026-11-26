// One message goes through this renderer on the dashboard's page script and, for the web chat, inside the dashboard
// process itself (the page's server render and the SSE poll's `renderWebMessageHtml`). Its work per message must stay
// linear and its recursion bounded: a hostile message must neither overflow the stack (the throw ends the process that
// renders the web chat) nor hold the event loop for seconds on every poll.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/dashboard/markdown";
import { renderWebMessageHtml } from "../src/web/card-html";

const ms = (run: () => void): number => {
	const started = performance.now();
	run();
	return performance.now() - started;
};

const blockquoteCount = (html: string): number => (html.match(/<blockquote>/g) ?? []).length;

describe("markdown rendering is bounded for one message", () => {
	test("a long `>` run is drawn flat instead of recursing once per character", () => {
		const source = `${">".repeat(200_000)}x`;
		let html = "";
		// Before the cap this was `RangeError: Maximum call stack size exceeded`.
		expect(() => {
			html = renderMarkdown(source);
		}).not.toThrow();
		expect(blockquoteCount(html)).toBe(16);
		expect(html).toContain("&gt;");
		// Shallow quotes render as before.
		expect(blockquoteCount(renderMarkdown("> a\n> > b\n> c"))).toBe(2);
	});

	test("unmatched emphasis runs do not cost quadratic time", () => {
		for (const marker of ["**a ", "__a ", "~~a "]) {
			const source = marker.repeat(16_000); // 64 KiB of opening markers with no closer
			// These took 9–10 s before the emphasis span was capped.
			expect(ms(() => renderMarkdown(source))).toBeLessThan(5_000);
		}
	});

	test("a long run of `[` does not cost quadratic time", () => {
		// Took ~11 s before the link text was capped (every `[` scanned to the end of the line).
		expect(ms(() => renderMarkdown(`${"[".repeat(40_000)}x`))).toBeLessThan(5_000);
	});

	test("the caps only move the edge of what is paired", () => {
		const link = (n: number): string => `[${"가".repeat(n)}](https://example.test/a)`;
		expect(renderMarkdown(link(500))).toContain('<a href="https://example.test/a"');
		expect(renderMarkdown(link(600))).not.toContain("<a href=");
		expect(renderMarkdown(`[x](https://example.test/${"a".repeat(2_200)})`)).not.toContain("<a href=");
		expect(renderMarkdown(`**${"가".repeat(900)}**`)).toContain("<strong>");
		expect(renderMarkdown(`**${"가".repeat(1_200)}**`)).not.toContain("<strong>");
		expect(renderMarkdown(`\`${"가".repeat(900)}\``)).toContain("<code>");
		expect(renderMarkdown(`\`${"가".repeat(1_200)}\``)).not.toContain("<code>");
		expect(renderMarkdown("`` ` ``")).toBe("<p><code>`</code></p>");
		expect(renderMarkdown("**bold** _em_ ~~del~~ `code`")).toBe(
			"<p><strong>bold</strong> <em>em</em> <del>del</del> <code>code</code></p>",
		);
	});

	test("long backtick runs and fence prefixes stay linear", () => {
		expect(ms(() => renderMarkdown(`a ${"`".repeat(200_000)}x`))).toBeLessThan(5_000);
		expect(ms(() => renderMarkdown(`${"```"}${" ".repeat(20_000)}\``))).toBeLessThan(5_000);
		expect(ms(() => renderMarkdown(`${"~".repeat(20_000)}\``))).toBeLessThan(5_000);
	});

	test("the web chat renders a hostile message instead of throwing", () => {
		const row = (text: string) => ({ role: "assistant" as const, text, cardJson: null, filesJson: null });
		expect(renderWebMessageHtml(row(`${">".repeat(200_000)}x`))).toContain("<blockquote>");
		expect(renderWebMessageHtml(row(`${"[".repeat(40_000)}x`)).length).toBeGreaterThan(0);
	});
});
