// The send write-ahead of an inbound row: `sending` is recorded right before a prompt or steer, so a send whose outcome
// never reached the ledger (a restart cut, kill -9, a `request_timeout` the child may have read) is parked as
// `uncertain` instead of being sent twice. Missing one input beats running it twice.
import { OmpDriverError } from "../omp/driver";
import type { InboundRow } from "../store/db-rows";
import type { MailboxDeps } from "./mailbox-types";
import {
	notifyUncertainMissingNotice,
	notifyUncertainParked,
	parkUncertainNotified,
	UNCERTAIN_REASON_TEXT,
} from "./mailbox-uncertain";

export { UNCERTAIN_REASON_TEXT };

type SendDeps = Pick<MailboxDeps, "store" | "log" | "originKey">;

/** Op ref of a discarded row whose fresh-session first prompt `launchRefusal` refused (`refused:<id>`). */
export const REFUSED_OP_PREFIX = "refused:";

/** `sending` rows of `originKey` (every origin without it) -> `uncertain` (`send_interrupted`): never sent again. */
export function parkInterruptedSends(store: MailboxDeps["store"], log: MailboxDeps["log"], originKey?: string): void {
	for (const row of store.parkSending(originKey)) {
		notifyUncertainParked(store, row, "send_interrupted");
		log.warn("inbound_uncertain", { origin: row.originKey, id: row.platformMessageId, reason: "send_interrupted" });
	}
}

/**
 * Boot recovery of the rows a dead process left half way: a `sending` row may have reached its child, so it is parked
 * as `uncertain` (whether or not a cut record names its turn); a launch-refused row left `dispatched` closes without a
 * notice (it was told).
 */
export function settleDeadProcessRows(store: MailboxDeps["store"], log: MailboxDeps["log"]): void {
	parkInterruptedSends(store, log);
	for (const row of notifyUncertainMissingNotice(store)) {
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
 * How a turn start that threw left its row. `unsent`: nothing reached the child — the row never got to `sending`, or
 * the prompt answered `not_started` (the row goes back to pending) — so it may be tried again, writing `sending` anew.
 * `parked`: the prompt ended in `request_timeout` after the write-ahead, so the child may hold it: `uncertain`
 * (`prompt_timeout`), never sent again. `failed`: any other error; the row stays `sending` for the caller's failure
 * notice, which closes it without a resend.
 */
type FailedSend = "unsent" | "parked" | "failed";

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
		parkUncertainNotified(store, row, "prompt_timeout");
		log.warn("inbound_uncertain", { origin: originKey, id, reason: "prompt_timeout", error: String(error) });
	} catch (writeError) {
		// Left `sending`: the next resumePending or restart parks it; it is never sent again.
		log.warn("send_settle_failed", { origin: originKey, id, error: String(writeError) });
	}
	return "parked";
}
