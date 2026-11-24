import { createSubAgentCostCache } from "../ops/cost-cap";
import type { InboundRow } from "../store/db-rows";
import { LiveTurn } from "./live-turn";
import { turnPeerOf } from "./mailbox-notices";
import type { ActiveTurn, MailboxDeps } from "./mailbox-types";
import { createStuckDetector } from "./stuck";

/** The state of a turn at its start: nothing spent, seen or sent yet. */
export function newActiveTurn(
	clock: MailboxDeps["clock"],
	row: InboundRow,
	start: Pick<ActiveTurn, "opRef" | "entryCursor" | "undoBefore" | "headsBefore">,
): ActiveTurn {
	const { opRef, entryCursor, undoBefore, headsBefore } = start;
	return {
		opRef,
		threadRef: row.threadRef,
		peer: turnPeerOf(row),
		startedAt: clock.now(),
		costUsd: 0,
		subAgentUsd: 0,
		subAgentCache: createSubAgentCostCache(),
		subAgentSessionFile: undefined,
		costSoftSent: false,
		costStopReason: undefined,
		costRecorded: false,
		entryCursor,
		finalArrived: false,
		stallCount: 0,
		stallSilentMs: 0,
		stallShown: false,
		stallClearedAt: 0,
		stallEscalated: false,
		tailWaiting: false,
		providerLimitSeen: false,
		stuck: createStuckDetector(),
		progress: { tools: 0, recentTools: [], steers: 0, retries: 0 },
		live: new LiveTurn(clock, row.platformMessageId),
		interim: [],
		...(undoBefore === undefined ? {} : { undoBefore }),
		...(headsBefore === undefined ? {} : { headsBefore }),
		pendingAnswer: undefined,
		capDeferred: new Set(),
		lastInterimDeliveredAt: undefined,
	};
}
