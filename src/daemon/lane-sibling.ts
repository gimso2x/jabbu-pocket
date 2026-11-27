import { inboundLane } from "../lanes/borrow-thread";
import type { LaneRow } from "../lanes/status";
import { type ClosedLaneMessage, type LaneTrigger, parseLaneTrigger } from "../lanes/trigger";
import { laneTriggerRefusal } from "../lanes/trigger-format";

/** A `작업:` first line: a trigger that names an absolute path, or the refusal for a `~` or relative path. */
export type LaneTriggerLine = { kind: "start"; trigger: LaneTrigger } | { kind: "refused"; text: string };

/** The `작업:` line of `text`; `undefined` for any other message. */
export function laneTriggerLine(text: string): LaneTriggerLine | undefined {
	const trigger = parseLaneTrigger(text);
	if (trigger !== undefined) return { kind: "start", trigger };
	const refusal = laneTriggerRefusal(text);
	return refusal === undefined ? undefined : { kind: "refused", text: refusal };
}

/** How the core routes an owner message written in a lane's thread. */
interface LaneInbound {
	lane: LaneRow | undefined;
	closedAs: ClosedLaneMessage | undefined;
	/** The `작업:` line of the message, when the lane would take it: it opens a sibling lane instead. */
	sibling: LaneTriggerLine | undefined;
}

/**
 * `inboundLane`, except for a `작업:` line the lane would take (`sibling`): it opens a sibling lane of that one,
 * whatever the lane's state. The core settles the row with the start's answer, so the line is no closed-lane question
 * (`closedAs` is undefined: the row keeps its text) and never reaches the lane's omp session.
 */
export function laneInbound(threadLane: LaneRow | undefined, text: string): LaneInbound {
	const routed = inboundLane(threadLane, text);
	const sibling = routed.lane === undefined ? undefined : laneTriggerLine(text);
	if (sibling === undefined) return { ...routed, sibling: undefined };
	return { lane: routed.lane, closedAs: undefined, sibling };
}
