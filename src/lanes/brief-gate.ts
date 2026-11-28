import { gateHandoff } from "../dispatch/tool";
import { frozenMessage } from "../ops/freeze";
import type { BorrowThreadRequest } from "./borrow-thread";
import { LaneInputError } from "./manager-constants";
import type { LaneManagerDeps } from "./manager-types";

/**
 * The handoff risk scan of a lane brief, before the lane creates anything: the same gate a [TASK] handoff brief
 * passes (`gateHandoff`). A high-risk brief asks the owner on the lane's approval card; without an approver the
 * start is refused like `gateHandoff`'s `no_approver`. Returns the gate's reply suffix (advisory/approved, else "").
 */
export async function gateLaneBrief(
	deps: Pick<LaneManagerDeps, "requestApproval" | "frozen" | "log">,
	input: {
		brief?: string | undefined;
		channel: string;
		parentOrigin?: string;
		borrowThread?: BorrowThreadRequest | undefined;
	},
): Promise<string> {
	const ask = deps.requestApproval;
	const parentOrigin = input.parentOrigin;
	try {
		const gate = await gateHandoff(
			{
				originKey: parentOrigin ?? input.channel,
				approve:
					ask === undefined || parentOrigin === undefined
						? undefined
						: (summary, detail, signal = new AbortController().signal) =>
								ask({
									channel: input.channel,
									summary,
									detail,
									origin: {
										originKey: parentOrigin,
										channel: input.channel,
										...(input.borrowThread === undefined ? {} : { threadTs: input.borrowThread.threadId }),
									},
									signal,
								}),
				// An approval card can outlast a freeze: re-check before the start goes on.
				afterApproval: () => {
					const frozen = deps.frozen?.();
					if (frozen !== undefined) throw new LaneInputError(frozenMessage(frozen));
				},
				log: deps.log,
			},
			input.brief ?? "",
			new AbortController().signal,
		);
		return gate.suffix;
	} catch (error) {
		if (error instanceof LaneInputError) throw error;
		throw new LaneInputError(error instanceof Error ? error.message : String(error));
	}
}
