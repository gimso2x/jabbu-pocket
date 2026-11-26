// The owner notice of a parked (`uncertain`) inbound row. A park without it left the owner waiting on an answer
// that never comes: the row showed only in `/queue` or on the dashboard, and nothing said so in the thread. The
// notice is one delivery per row (op `uncertain:<id>`), so a repeated park cannot post it twice; its text mirrors
// the `/queue` section and carries the retry reply's double-answer warning, so the owner acts with full context.
import { previewLine } from "../dashboard/preview-line";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
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

/** What was held, why, and the `/queue` retry/close path (`recordAnswer` redacts and stores the body). */
export function uncertainNoticeText(row: InboundRow, reason: UncertainReason): string {
	return (
		`⚠️ 전달 불확실(${UNCERTAIN_REASON_TEXT[reason]}) — "${previewLine(row.textRef)}"은(는) 이미 처리됐을 수 있어 ` +
		`자동으로 다시 보내지 않습니다. \`${COMMAND_TEXT.queue}\`에서 \`retry <번호>\`(한 번 다시 보내기 · 이미 처리됐다면 ` +
		`답이 두 번 나올 수 있습니다) 또는 \`close <번호>\`(다시 보내지 않고 닫기)를 고르세요.`
	);
}

/** The notice of an already-parked row. Monitor origins have no owner thread; [TASK] rows get no delivery (`recordAnswer`). */
export function notifyUncertainParked(store: UncertainNoticeStore, row: InboundRow, reason: UncertainReason): void {
	if (row.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
	store.recordAnswer({
		originKey: row.originKey,
		opRef: `uncertain:${row.platformMessageId}`,
		threadRef: row.threadRef,
		parts: [uncertainNoticeText(row, reason)],
	});
}

/** Parks the row and posts its notice: the only `uncertain` path an owner-facing origin should take. */
export function parkUncertainNotified(store: UncertainNoticeStore, row: InboundRow, reason: UncertainReason): void {
	store.markUncertain(row.platformMessageId, reason);
	notifyUncertainParked(store, row, reason);
}
