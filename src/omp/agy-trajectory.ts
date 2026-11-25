import type { OmpFinal } from "./driver";

/*
 * How one `session/prompt` reply of the agy ACP driver ends its turn, and the one reply it does not end the turn on: a
 * resumed session whose stored conversation agy cannot find (`trajectory not found` on the first prompt after a
 * `session/load` that worked), which the driver answers by opening a new session and sending the prompt once more.
 */

const TRAJECTORY_LOST = /trajectory not found/i;

const errorText = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** Whether the reply (a failure, or a result that did not end the turn) says agy lost the session's trajectory. */
export function isTrajectoryLoss(result: Record<string, unknown> | undefined, failure: unknown): boolean {
	if (failure !== undefined) return TRAJECTORY_LOST.test(errorText(failure));
	const stopReason = result?.stopReason;
	return stopReason !== "end_turn" && stopReason !== "cancelled" && TRAJECTORY_LOST.test(JSON.stringify(result ?? {}));
}

interface PromptReplyEnd {
	stopReason: string | undefined;
	failure: unknown;
	abortRequested: boolean;
	/** The quota error agy's retry notice set on the turn. */
	rateLimit?: string | undefined;
	/** Steered texts still held: named in the error, as they never reach agy. */
	dropped: number;
}

/** The final status and error of a turn its prompt reply ends. */
export function promptReplyEnd(reply: PromptReplyEnd): { status: OmpFinal["status"]; error?: string } {
	if (reply.rateLimit !== undefined) return withDropped("error", reply.rateLimit, reply.dropped);
	if (reply.abortRequested || reply.stopReason === "cancelled") {
		return withDropped("aborted", reply.failure === undefined ? "cancelled" : errorText(reply.failure), reply.dropped);
	}
	if (reply.stopReason === "end_turn") return { status: "completed" };
	const error =
		reply.failure === undefined
			? `agy turn ended with stopReason ${reply.stopReason ?? "none"}`
			: errorText(reply.failure);
	return withDropped("error", error, reply.dropped);
}

function withDropped(
	status: OmpFinal["status"],
	error: string,
	dropped: number,
): { status: OmpFinal["status"]; error: string } {
	return { status, error: dropped > 0 ? `${error} (steer ${dropped}건 미전달)` : error };
}
