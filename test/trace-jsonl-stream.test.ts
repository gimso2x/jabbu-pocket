import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { iterJsonlRecords, readBrief, readJsonlRecords } from "../src/dashboard/trace-transcript";

function sessionFile(lines: string[]): string {
	const file = join(mkdtempSync(join(tmpdir(), "jabbu-jsonl-")), "s.jsonl");
	writeFileSync(file, lines.join("\n"));
	return file;
}

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });

test("records across chunk boundaries and multibyte text stay whole, torn last line is skipped", () => {
	const big = "가".repeat(700_000); // > 1 MiB of UTF-8, so a chunk edge falls inside a line and inside a character
	const file = sessionFile(
		[user("첫 요청"), JSON.stringify({ type: "x", big }), user("둘째"), '{"type":"torn'].map((l) => l),
	);
	tempDirs.push(dirname(file));
	const records = readJsonlRecords(file);
	expect(records.length).toBe(3);
	expect((records[1] as { big: string }).big.length).toBe(700_000);
});

test("iterJsonlRecords can stop early and readBrief returns the first non-empty user message", () => {
	const file = sessionFile(["", user("   "), user("처음 할 일"), user("다음")]);
	tempDirs.push(dirname(file));
	expect(readBrief(file)?.text).toBe("처음 할 일");
	const it = iterJsonlRecords(file);
	expect(it.next().done).toBe(false);
	it.return(undefined);
});

test("one very long line stays near whole-file read time, not quadratic in its length", () => {
	const file = sessionFile([user("x".repeat(48_000_000))]); // a single ~48MB line: big tool output, base64
	tempDirs.push(dirname(file));
	const wholeFile = () => JSON.parse(readFileSync(file, "utf8"));
	const time = (read: () => unknown) => {
		read(); // warm the cache and the JIT
		const start = performance.now();
		read();
		return performance.now() - start;
	};
	const base = time(wholeFile);
	const streamed = time(() => readJsonlRecords(file));
	expect(streamed).toBeLessThan(Math.max(base * 3, 50));
});
