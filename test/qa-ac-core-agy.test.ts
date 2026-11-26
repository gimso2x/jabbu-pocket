import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { purposeScopes } from "../src/core/mailbox-purpose";
import { isThreadOrigin, threadRefOfOrigin } from "../src/core/normalize";
import { openBotStore, sessionDirFor } from "../src/core/origin";
import {
	appendTurnChunk,
	finalLineQuotaNotice,
	type NoticeScanState,
	quotaRetryNotice,
	resetTurnText,
} from "../src/omp/agy-notice";
import { gcSessions } from "../src/ops/gc";
import { openStore } from "../src/store/db";
import { makeHome } from "./helpers/bot-home";

let tempRoot: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "jabbu-qa-ac-core-"));
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("qa-ac core·store·agy 수정", () => {
	test("#10: web/dm/.../t/... 오리진을 스레드 세션으로 인식해 threadRef·!용도·gc가 일치한다", () => {
		const webThread = "web/dm/w_abcd1234/t/w_m0000001";
		const webDm = "web/dm/w_abcd1234";
		expect(threadRefOfOrigin(webThread)).toBe("w_abcd1234:w_m0000001");
		expect(isThreadOrigin(webThread)).toBe(true);
		expect(threadRefOfOrigin(webDm)).toBeUndefined();
		expect(isThreadOrigin(webDm)).toBe(false);

		const home = makeHome("jabbu-qa-ac-web-thread-");
		const OLD = 1_000;
		const NOW = 60 * 24 * 60 * 60 * 1000;
		const oldDate = new Date(OLD);
		try {
			const dbPath = join(home.dir, "jabbu.db");
			const sessionsDir = join(home.dir, "sessions");
			const epochDir = sessionDirFor(sessionsDir, webThread, 1);
			const originDir = dirname(epochDir);
			mkdirSync(epochDir, { recursive: true });
			const sessFile = join(epochDir, "s.jsonl");
			writeFileSync(sessFile, "{}\n");
			utimesSync(sessFile, oldDate, oldDate);
			utimesSync(epochDir, oldDate, oldDate);
			utimesSync(originDir, oldDate, oldDate);

			const store = openBotStore(dbPath, { now: () => OLD }, "Asia/Seoul");
			store.ensureOrigin(webThread, epochDir);
			expect(
				purposeScopes({
					originKey: webThread,
					store,
					readPurpose: () => undefined,
					writePurpose: () => {},
				} as unknown as Parameters<typeof purposeScopes>[0]),
			).toEqual({
				channel: "web:w_abcd1234",
				thread: "web:w_abcd1234:w_m0000001",
			});
			store.close();

			const gc = gcSessions({ homeDir: home.dir, retentionDays: 30, now: NOW });
			expect(gc.threadOriginsRemoved).toContain(webThread);
		} finally {
			rmSync(home.dir, { recursive: true, force: true });
		}
	});

	test("#25: alertChannelId만 설정되고 오너 홈이 없어도 모니터 연속 실패 경보가 배달 장부에 기록된다", () => {
		const ALERT = "890123456789012345";
		const unroutable: string[] = [];
		const store = openStore({
			path: join(tempRoot, "jabbu.db"),
			clock: { now: () => 10_000 },
			timezone: "Asia/Seoul",
			redact: (t) => t,
			hooks: {
				onOwnerNoticeUnroutable: (input) => unroutable.push(input.originKey),
			},
		});
		try {
			store.setAlertChannel({ discord: ALERT });
			const mon = store.monitors.addMonitor({
				name: "chk",
				trigger: { kind: "script", command: ["echo", "ok"], intervalMs: 60_000 },
				instruction: "check",
				overlap: "queue",
				enabled: true,
			});
			for (let i = 0; i < 3; i += 1) {
				store.monitors.recordCheckError(mon.id, "spawn failed");
			}
			const db = new Database(join(tempRoot, "jabbu.db"), { readonly: true, strict: true });
			const deliveries = db.query("SELECT thread_ref, body FROM deliveries").all() as Array<{
				thread_ref: string;
				body: string;
			}>;
			db.close();
			expect(unroutable).toEqual([]);
			expect(deliveries.some((d) => d.thread_ref === `${ALERT}:-` && d.body.includes("연속 실패"))).toBe(true);
		} finally {
			store.close();
		}
	});

	test("#42: 코드 펜스 안에 인용된 429 재시도 줄은 무시하고 펜스 밖 실제 429만 감지한다", () => {
		const fakeLine = "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): retry";
		expect(quotaRetryNotice(["앞 설명", "```", fakeLine, "```", "정상 끝"].join("\n"))).toBeUndefined();
		expect(quotaRetryNotice(["~~~log", fakeLine, "~~~"].join("\n"))).toBeUndefined();
		expect(quotaRetryNotice(["````md", "```", fakeLine, "````"].join("\n"))).toBeUndefined();
		expect(quotaRetryNotice(["```", fakeLine, "```", `⚠️ ${fakeLine}`].join("\n"))).toBe(
			"RESOURCE_EXHAUSTED (code 429): retry",
		);

		// Streaming chunks inside fences never trigger quota cancel and never withhold shown text.
		const st: NoticeScanState = { text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false };
		expect(appendTurnChunk(st, "인용:\n```txt\n").quota).toBeUndefined();
		const inside = appendTurnChunk(st, `${fakeLine}\n`);
		expect(inside.quota).toBeUndefined();
		expect(inside.shown).toContain(fakeLine);
		expect(appendTurnChunk(st, "```\n정상 결론").quota).toBeUndefined();
		resetTurnText(st);
		expect(st).toEqual({ text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false });

		// Real unquoted 429 after closing a fence still triggers immediately.
		const st2: NoticeScanState = { text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false };
		expect(appendTurnChunk(st2, ["```", fakeLine, "```", ""].join("\n")).quota).toBeUndefined();
		expect(appendTurnChunk(st2, `⚠️ ${fakeLine}\n`).quota).toBe("RESOURCE_EXHAUSTED (code 429): retry");

		// Large fenced stream stays linear time.
		const perf: NoticeScanState = { text: "", lastNewline: -1, quotaScanFrom: 0, quotaLineDead: false };
		appendTurnChunk(perf, "```\n");
		const unit = `${"x".repeat(50)}\n`;
		const t0 = performance.now();
		for (let i = 0; i < 4000; i += 1) {
			expect(appendTurnChunk(perf, unit).quota).toBeUndefined();
		}
		expect(performance.now() - t0).toBeLessThan(200);
	});

	test("finalLineQuotaNotice는 펜스·인용 밖 마지막 비공백 줄의 단독 한도 문구만 감지한다", () => {
		const line =
			"⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.";
		const expected =
			"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.";
		expect(finalLineQuotaNotice(line)).toBe(expected);
		expect(finalLineQuotaNotice(`앞 본문\n\n${line}\n`)).toBe(expected);
		expect(finalLineQuotaNotice(`앞 본문\r\n${line}\r\n  \r\n`)).toBe(expected);
		expect(finalLineQuotaNotice(["```txt", "코드", "```", line].join("\n"))).toBe(expected);

		// Code fences, <<<quoted-...>>> blocks, unclosed markers, trailing prose, mid-line quotes, and ellipses stay ignored.
		expect(finalLineQuotaNotice(["```", line, "```"].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice(["~~~", line, "~~~"].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice(["```", line].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice(["<<<quoted-abc>>>", line, "<<<end-quoted-abc>>>"].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice(["<<<quoted-abc>>>", line].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice([line, "```txt", "code", "```"].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice([line, "<<<quoted-abc>>>", "인용", "<<<end-quoted-abc>>>"].join("\n"))).toBeUndefined();
		expect(finalLineQuotaNotice(`${line}\n정상 결론`)).toBeUndefined();
		expect(finalLineQuotaNotice(`설명: ${line}`)).toBeUndefined();
		expect(
			finalLineQuotaNotice(
				"⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ...",
			),
		).toBeUndefined();
	});
});
