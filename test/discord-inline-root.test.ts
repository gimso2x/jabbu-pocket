// The decision whether an owner line asks for its own thread (inline reply channels).
import { describe, expect, test } from "bun:test";
import { wantsThreadSplit } from "../src/discord/inline-root";

describe("wantsThreadSplit", () => {
	test.each([
		"이건 따로 빼줘",
		"이건 따로 빼줘.",
		"이건 따로 빼줘: 서버 로그 분석",
		"서버 로그 분석은 새 스레드에서 해줘",
		"배포 점검을 새 쓰레드에서 해줘",
		"이건 쓰레드로 빼줘",
		"새 스레드로 처리해줘",
		"split this into a new thread",
		"Please split this into a new thread.",
		"do the log review in a new thread",
	])("asks for a thread: %s", (line) => {
		expect(wantsThreadSplit(line)).toBe(true);
	});

	test.each([
		["a negated thread", "새 스레드 말고 본문에서 해줘"],
		["a negated thread (없이)", "스레드 없이 본문에서 따로 빼줘"],
		["a question", "새 스레드에서 해줄래?"],
		["a question on splitting", "따로 빼야 해?"],
		["a quoted example", '"이건 따로 빼줘"라고 하면 뭐가 돼?'],
		["a backticked example", "`이건 따로 빼줘`는 무슨 뜻이야"],
		["a multi-line message", "설명 먼저\n이건 따로 빼줘"],
		["an English negation", "don't split this into a new thread"],
		["an English question", "can you do this in a new thread?"],
		["plain text", "이 링크 뭐야"],
		["empty text", ""],
	])("does not: %s", (_name, line) => {
		expect(wantsThreadSplit(line)).toBe(false);
	});
});
