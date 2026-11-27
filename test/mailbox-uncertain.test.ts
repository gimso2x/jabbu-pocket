import { describe, expect, test } from "bun:test";
import { UNCERTAIN_REASON_TEXT, uncertainNoticeText } from "../src/core/mailbox-uncertain";
import type { InboundRow } from "../src/store/db-rows";
import type { UncertainReason } from "../src/store/transitions";

/** A parked inbound row; only the fields the notice reads are meaningful. */
function parkedRow(textRef: string): InboundRow {
	return {
		platformMessageId: "m1",
		originKey: "discord/dm/1",
		epoch: 1,
		textRef,
		state: "uncertain",
		createdAt: 0,
		dispatchedAt: null,
		opRef: null,
		entryCursor: null,
		threadRef: "1:2",
		peerUserId: null,
		uncertainReason: "prompt_timeout",
		uncertainAt: 0,
		injected: false,
	};
}

/** The quoted preview line of the notice. */
function previewOf(notice: string): string {
	return notice.split('"')[1] ?? "";
}

describe("the uncertain notice's preview line", () => {
	test("a secret in the held text never reaches the notice (it is posted to the thread and kept 90 days)", () => {
		const secret = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const notice = uncertainNoticeText(parkedRow(`배포해 줘 ${secret} 이 키로`), "prompt_timeout");
		expect(notice).not.toContain(secret);
		expect(notice).not.toContain("sk-ant-");
		expect(notice).toContain("전달 불확실");
	});

	test("newlines, tabs and runs of spaces collapse to one masked line", () => {
		const preview = previewOf(uncertainNoticeText(parkedRow("첫째\n둘째\t\t셋째   넷째"), "steer_threw"));
		expect(preview).not.toMatch(/[\n\t]/);
		expect(preview).toBe("첫째 둘째 셋째 넷째");
	});

	test("the preview is cut to 80 codepoints without breaking a surrogate pair", () => {
		const preview = previewOf(uncertainNoticeText(parkedRow(`${"가".repeat(78)}😀😀😀`), "send_interrupted"));
		expect([...preview].length).toBeLessThanOrEqual(80);
		for (const char of preview) {
			const codePoint = char.codePointAt(0) ?? 0;
			expect(codePoint >= 0xd800 && codePoint <= 0xdfff).toBe(false);
		}
	});

	test("every park reason has owner wording that shows in the notice", () => {
		const reasons: UncertainReason[] = [
			"steer_threw",
			"turn_ended_after_steer",
			"dispatch_record_failed",
			"prompt_timeout",
			"send_interrupted",
		];
		for (const reason of reasons) {
			expect(UNCERTAIN_REASON_TEXT[reason].length).toBeGreaterThan(0);
			expect(uncertainNoticeText(parkedRow("요청"), reason)).toContain(UNCERTAIN_REASON_TEXT[reason]);
		}
	});

	test("the notice carries the /queue retry/close path and the double-answer warning", () => {
		const notice = uncertainNoticeText(parkedRow("요청"), "prompt_timeout");
		expect(notice).toContain("retry <번호>");
		expect(notice).toContain("close <번호>");
		expect(notice).toContain("답이 두 번 나올 수 있습니다");
	});
});
