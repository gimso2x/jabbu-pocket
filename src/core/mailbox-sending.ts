// The send write-ahead of an inbound row: `sending` is recorded right before a prompt or steer, so a send whose outcome
// never reached the ledger (a restart cut, kill -9, a `request_timeout` the child may have read) is parked as
// `uncertain` instead of being sent twice. Missing one input beats running it twice.
import { OmpDriverError } from "../omp/driver";
import type { InboundRow } from "../store/db-rows";
import { type MailboxDeps, sessionToResume } from "./mailbox-types";
import {
	notifyUncertainMissingNotice,
	notifyUncertainParked,
	parkUncertainNotified,
	UNCERTAIN_REASON_TEXT,
} from "./mailbox-uncertain";
import { tryCloseToolFreeFromFile } from "./tool-free-recovery";

export { UNCERTAIN_REASON_TEXT };

type SendDeps = Pick<MailboxDeps, "store" | "log" | "originKey">;

/** Op ref of a discarded row whose fresh-session first prompt `launchRefusal` refused (`refused:<id>`). */
export const REFUSED_OP_PREFIX = "refused:";

/** `sending` rows of `originKey` (every origin without it) -> tool-free closure if proven, else `uncertain` (`send_interrupted`). */
export function parkInterruptedSends(store: MailboxDeps["store"], log: MailboxDeps["log"], originKey?: string): void {
	for (const row of store.listInbound({ originKey, state: "sending" })) {
		const origin = store.getOrigin(row.originKey);
		const sessionFile = origin === undefined ? undefined : sessionToResume(origin);
		tryCloseToolFreeFromFile(store, log, row, sessionFile, "boot_sending");
	}
	for (const row of store.parkSending(originKey)) {
		notifyUncertainParked(store, log, row, "send_interrupted");
		log.warn("inbound_uncertain", { origin: row.originKey, id: row.platformMessageId, reason: "send_interrupted" });
	}
}

/**
 * Boot recovery of the rows a dead process left half way: a `sending` row may have reached its child, so it is parked
 * as `uncertain` (whether or not a cut record names its turn); a launch-refused row left `dispatched` closes without a
 * notice (it was told).
 */
export function settleDeadProcessRows(store: MailboxDeps["store"], log: MailboxDeps["log"], now?: number): void {
	parkInterruptedSends(store, log);
	for (const row of notifyUncertainMissingNotice(store, log, now ?? Date.now())) {
		log.warn("inbound_uncertain_notice_late", { origin: row.originKey, id: row.platformMessageId });
	}
	for (const row of store.listInbound({ state: "dispatched" })) {
		if (!row.opRef?.startsWith(REFUSED_OP_PREFIX)) continue;
		store.discard(row.platformMessageId);
		log.info("recovery_discarded_refused", { origin: row.originKey, id: row.platformMessageId });
	}
}

/** pending -> sending right before a prompt or steer. False (logged): the write failed, so nothing may be sent. */
export function beginSend(deps: SendDeps, row: InboundRow, entryCursor: string | null): boolean {
	try {
		deps.store.markSending(row.platformMessageId, entryCursor);
		return true;
	} catch (error) {
		deps.log.warn("send_write_ahead_failed", {
			origin: deps.originKey,
			id: row.platformMessageId,
			error: String(error),
		});
		return false;
	}
}

/**
 * `unsent`: nothing reached the child (`not_started`). `timeout_sending`: `request_timeout` after write-ahead; caller
 * stops the driver and runs `settleTimedOutSend`. `parked`: write-ahead settle failed. `failed`: other error.
 */
type FailedSend = "unsent" | "timeout_sending" | "parked" | "failed";

export function settleFailedSend(deps: SendDeps, row: InboundRow, error: unknown): FailedSend {
	const { store, log, originKey } = deps;
	const id = row.platformMessageId;
	if (store.getInbound(id)?.state !== "sending") return "unsent";
	const code = error instanceof OmpDriverError ? error.code : undefined;
	try {
		if (code === "not_started") {
			store.releaseSending(id);
			return "unsent";
		}
		if (code !== "request_timeout") return "failed";
		return "timeout_sending";
	} catch (writeError) {
		// Left `sending`: the next resumePending or restart parks it; it is never sent again.
		log.warn("send_settle_failed", { origin: originKey, id, error: String(writeError) });
		return "parked";
	}
}

/** `request_timeout` 뒤 드라이버를 멈춘 상태에서 세션 저널을 확인해 도구 미호출 실패면 닫고, 아니면 `uncertain`으로 보류한다. */
export function settleTimedOutSend(
	deps: Pick<MailboxDeps, "store" | "log" | "originKey" | "onQuotaError">,
	row: InboundRow,
	error: unknown,
	sessionFile?: string,
	model?: string,
): void {
	const { store, log, originKey } = deps;
	const id = row.platformMessageId;
	const current = store.getInbound(id);
	if (current?.state !== "sending") return;
	const proof = tryCloseToolFreeFromFile(store, log, current, sessionFile, "send_timeout");
	if (proof !== undefined) {
		if (proof.failureKind === "provider_limit") {
			deps.onQuotaError?.({
				originKey,
				threadRef: current.threadRef,
				...(model === undefined ? {} : { model }),
				reason: proof.reason,
			});
		}
		return;
	}
	try {
		parkUncertainNotified(store, log, current, "prompt_timeout");
		log.warn("inbound_uncertain", { origin: originKey, id, reason: "prompt_timeout", error: String(error) });
	} catch (writeError) {
		log.warn("send_settle_failed", { origin: originKey, id, error: String(writeError) });
	}
}
