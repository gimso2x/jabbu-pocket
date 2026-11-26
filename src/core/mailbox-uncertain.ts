// The owner notice of a parked (`uncertain`) inbound row. A park without it left the owner waiting on an answer
// that never comes: the row showed only in `/queue` or on the dashboard, and nothing said so in the thread. The
// notice is one delivery per row (op `uncertain:<id>`), so a repeated park cannot post it twice; its text mirrors
// the `/queue` section and carries the retry reply's double-answer warning, so the owner acts with full context.
import { isTaskOrigin } from "../lanes/status";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { LEDGER_RETENTION_DAYS } from "../ops/gc-ledger";
import { redact } from "../redact";
import type { Store } from "../store/db";

/** The store slice the uncertain notice needs (kept narrow so tests stub it cheaply). */
export type UncertainNoticeStore = Pick<Store, "markUncertain" | "recordAnswer">;

import type { InboundRow } from "../store/db-rows";
import type { UncertainReason } from "../store/transitions";
import { COMMAND_TEXT } from "./types";

/** Why an `uncertain` row was parked, in the owner's words (re-exported from `mailbox-sending` for `/queue`). */
export const UNCERTAIN_REASON_TEXT: Record<UncertainReason, string> = {
	steer_threw: "끼워넣기 전송 오류",
	turn_ended_after_steer: "전송 직후 턴 종료",
	dispatch_record_failed: "전송 후 장부 기록 실패",
	prompt_timeout: "전송 응답 시간 초과",
	send_interrupted: "전송 중 재시작·중단",
};

/** One masked line of the held request: secrets redacted, whitespace collapsed, cut to 80 chars. Kept local because
 * core must not import the dashboard's `previewLine` (the layer gate rejects the edge). */
const noticePreview = (text: string): string => {
	const line = redact(text).replace(/\s+/g, " ").trim();
	return [...line].slice(0, 80).join("");
};

/** What was held, why, and the `/queue` retry/close path (`recordAnswer` redacts and stores the body). */
export function uncertainNoticeText(row: InboundRow, reason: UncertainReason): string {
	return (
		`⚠️ 전달 불확실(${UNCERTAIN_REASON_TEXT[reason]}) — "${noticePreview(row.textRef)}"은(는) 이미 처리됐을 수 있어 ` +
		`자동으로 다시 보내지 않습니다. \`${COMMAND_TEXT.queue}\`에서 \`retry <번호>\`(한 번 다시 보내기 · 이미 처리됐다면 ` +
		`답이 두 번 나올 수 있습니다) 또는 \`close <번호>\`(다시 보내지 않고 닫기)를 고르세요.`
	);
}

/** The notice of an already-parked row. Monitor origins have no owner thread; [TASK] rows get no delivery (`recordAnswer`). */
export function notifyUncertainParked(
	store: UncertainNoticeStore,
	log: Logger,
	row: InboundRow,
	reason: UncertainReason,
): boolean {
	if (row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) || isTaskOrigin(row.originKey)) return false;
	try {
		store.recordAnswer({
			originKey: row.originKey,
			opRef: `uncertain:${row.platformMessageId}`,
			threadRef: row.threadRef,
			parts: [uncertainNoticeText(row, reason)],
		});
		return true;
	} catch (error) {
		log.warn("uncertain_notice_failed", {
			origin: row.originKey,
			id: row.platformMessageId,
			reason,
			error: String(error),
		});
		return false;
	}
}

/**
 * The boot sweep for rows a crash parked between the park and the notice (the two are not one transaction): every
 * `uncertain` row with no `uncertain:<id>` delivery yet is told — exactly once. Rows the owner already retried or
 * closed left `uncertain`, so they are not here; monitor and [TASK] origins get no owner thread notice. A row parked past
 * the ledger retention is NOT told: gc may already have removed its delivered notice (`uncertain` rows never leave the
 * ledger, confirmed deliveries do), and re-posting it would be a duplicate. Returns the rows told.
 */
export function notifyUncertainMissingNotice(
	store: UncertainNoticeStore & Pick<Store, "listInbound" | "listDeliveries">,
	log: Logger,
	now: number,
): InboundRow[] {
	const seenByOrigin = new Map<string, Set<string | null>>();
	const told: InboundRow[] = [];
	for (const row of store.listInbound({ state: "uncertain" })) {
		if (row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) || isTaskOrigin(row.originKey)) continue;
		if (row.uncertainAt !== null && now - row.uncertainAt >= LEDGER_RETENTION_DAYS * 86_400_000) continue;
		let seen = seenByOrigin.get(row.originKey);
		if (!seen) {
			seen = new Set(store.listDeliveries({ originKey: row.originKey }).map((delivery) => delivery.opRef));
			seenByOrigin.set(row.originKey, seen);
		}
		if (seen.has(`uncertain:${row.platformMessageId}`)) continue;
		if (notifyUncertainParked(store, log, row, row.uncertainReason ?? "send_interrupted")) told.push(row);
	}
	return told;
}

/** Parks the row and posts its notice: the only `uncertain` path an owner-facing origin should take. */
export function parkUncertainNotified(
	store: UncertainNoticeStore,
	log: Logger,
	row: InboundRow,
	reason: UncertainReason,
): void {
	store.markUncertain(row.platformMessageId, reason);
	notifyUncertainParked(store, log, row, reason);
}
