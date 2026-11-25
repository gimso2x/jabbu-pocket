import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadContextBlock } from "../src/core/mailbox-thread-context";
import { openBotStore } from "../src/core/origin";
import { promptImageBlocks } from "../src/omp/agy-images";
import { appendTurnChunk, type NoticeScanState, resetTurnText } from "../src/omp/agy-notice";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("qa-ab agy·스레드 맥락 수정", () => {
	test("#13: promptImageBlocks keeps a 4-backtick fence closed over inner ``` lines and finds notes after it", async () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa-ab-agy-img-"));
		tempDirs.push(root);
		const inbound = join(root, "media", "inbound");
		mkdirSync(join(inbound, "m1"), { recursive: true });
		const f1 = join(inbound, "m1", "a.png");
		const f2 = join(inbound, "m1", "b.png");
		writeFileSync(f1, PNG);
		writeFileSync(f2, PNG);
		const n1 = `[첨부: ${f1} (image/png)]`;
		const n2 = `[첨부: ${f2} (image/png)]`;
		const text = ["````md", "```", n1, "````", n2].join("\n");
		const blocks = await promptImageBlocks(text, inbound);
		expect(blocks).toHaveLength(1);
	});

	test("#15: threadContextBlock folds newlines in the thread root so an embedded attachment note is not standalone", async () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-qa-ab-thread-"));
		tempDirs.push(root);
		const inbound = join(root, "media", "inbound");
		mkdirSync(join(inbound, "m1"), { recursive: true });
		const img = join(inbound, "m1", "root.png");
		writeFileSync(img, PNG);
		const note = `[첨부: ${img} (image/png)]`;

		const store = openBotStore(join(root, "jabbu.db"), { now: () => 1000 }, "Asia/Seoul");
		const chOrigin = "discord/ch/111111111111111111";
		const thrOrigin = `${chOrigin}/t/700000000000000001`;
		const threadRef = "111111111111111111:700000000000000001";
		store.ensureOrigin(chOrigin, join(root, "s-ch"));
		store.ensureOrigin(thrOrigin, join(root, "s-thr"));
		store.recordInbound({
			platformMessageId: "111111111111111111:700000000000000001",
			originKey: chOrigin,
			textRef: `질문 본문\n${note}`,
			threadRef,
		});
		const replyRow = store.recordInbound({
			platformMessageId: "111111111111111111:700000000000000002",
			originKey: thrOrigin,
			textRef: "후속 질문",
			threadRef,
		});
		expect(replyRow.row).toBeDefined();
		const block = threadContextBlock(store, thrOrigin, replyRow.row);
		expect(block).not.toBeNull();
		expect(await promptImageBlocks(block ?? "", inbound)).toEqual([]);
		store.close();
	});

	test("#31: appendTurnChunk scans 300k chars of small chunks in linear time while still catching split retry notices", () => {
		const stream = (total: number, newlineEvery: number) => {
			const state: NoticeScanState = { text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false };
			const unit = "가".repeat(20);
			const t0 = performance.now();
			let chunks = 0;
			while (state.text.length < total) {
				const chunk = newlineEvery > 0 && chunks % newlineEvery === newlineEvery - 1 ? "\n" : unit;
				expect(appendTurnChunk(state, chunk).quota).toBeUndefined();
				chunks += 1;
			}
			return performance.now() - t0;
		};
		expect(stream(300_000, 0)).toBeLessThan(200);
		expect(stream(300_000, 40)).toBeLessThan(200);

		const state: NoticeScanState = { text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false };
		expect(appendTurnChunk(state, "앞 줄\n⚠️ API error (attempt 1): ")).toEqual({ shown: "앞 줄\n" });
		const second = appendTurnChunk(state, "RESOURCE_EXHAUSTED (code 429)\n");
		expect(second.quota).toBe("RESOURCE_EXHAUSTED (code 429)");
		resetTurnText(state);
		expect(state).toEqual({ text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false });
	});
});
