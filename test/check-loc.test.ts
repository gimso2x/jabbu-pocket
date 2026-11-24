import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countLines, locViolations, lowerBaseline, NEW_FILE_MAX, scanLoc } from "../src/dev/check-loc";

const root = mkdtempSync(path.join(tmpdir(), "check-loc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("check-loc", () => {
	test("줄 수는 끝 개행을 한 줄로 세지 않는다", () => {
		expect([countLines(""), countLines("a"), countLines("a\n"), countLines("a\n\nb\n")]).toEqual([0, 1, 1, 3]);
	});

	test("기존 파일은 기준선을 넘으면 실패하고 같거나 줄면 통과한다", () => {
		expect(locViolations({ "src/a.ts": 301 }, { "src/a.ts": 300 })).toHaveLength(1);
		expect(locViolations({ "src/a.ts": 300 }, { "src/a.ts": 300 })).toEqual([]);
		expect(locViolations({ "src/a.ts": 10 }, { "src/a.ts": 300 })).toEqual([]);
	});

	test("기준선에 없는 새 파일은 400줄을 넘으면 실패한다", () => {
		expect(locViolations({ "src/new.ts": NEW_FILE_MAX }, {})).toEqual([]);
		expect(locViolations({ "src/new.ts": NEW_FILE_MAX + 1 }, {})).toHaveLength(1);
	});

	test("기준선 하향은 줄어든 파일만 낮추고 지운 파일은 빼며 새 파일은 넣지 않는다", () => {
		expect(
			lowerBaseline(
				{ "src/a.ts": 120, "src/b.ts": 50, "src/new.ts": 9 },
				{ "src/a.ts": 300, "src/b.ts": 40, "src/gone.ts": 7 },
			),
		).toEqual({ "src/a.ts": 120, "src/b.ts": 40 });
	});

	test("scanLoc는 src 아래 .ts만 줄 수를 센다", () => {
		mkdirSync(path.join(root, "src", "x"), { recursive: true });
		mkdirSync(path.join(root, "test"));
		writeFileSync(path.join(root, "src", "x", "a.ts"), "1\n2\n3\n");
		writeFileSync(path.join(root, "src", "b.json"), "{}\n");
		writeFileSync(path.join(root, "test", "c.ts"), "1\n");
		expect(scanLoc(root)).toEqual({ "src/x/a.ts": 3 });
	});

	test("저장소의 현재 src는 커밋된 기준선을 넘지 않는다", () => {
		const repo = path.join(import.meta.dir, "..");
		const baseline = JSON.parse(readFileSync(path.join(repo, "src/dev/loc-baseline.json"), "utf8"));
		expect(locViolations(scanLoc(repo), baseline)).toEqual([]);
	});
});
