import type { OriginMailbox } from "../core/mailbox";
import { auditContext } from "../dispatch/audit";

/**
 * Runs one host tool call of `originKey`'s child. Inside the origin's mailbox (when it has one) the call rests stall
 * detection and counts as unfinished drain work. Every process call it makes, background ones it starts included, is
 * audited under the origin and the turn running now (`turn`, the opRef that turn's log lines carry).
 */
export function runHostTool<T>(
	mailbox: OriginMailbox | undefined,
	originKey: string,
	execute: () => Promise<T>,
): Promise<T> {
	const opRef = mailbox?.turnOpRef;
	const run = () => auditContext.run({ origin: originKey, ...(opRef === undefined ? {} : { turn: opRef }) }, execute);
	return mailbox ? mailbox.trackHostTool(run) : run();
}
