import { dirname } from "node:path";
import { conversationSessionFiles, summarizeSessionFiles, type UsageTotals } from "../ops/usage";
import type { LaneRow } from "./status";

/**
 * Totals token and cost across every session JSONL of the lane's origin directory (all epochs and subagents).
 * Reads directly from disk using summarizeSessionFiles without modifying any ledger table.
 */
export async function laneCost(lane: Pick<LaneRow, "sessionDir">): Promise<UsageTotals> {
	if (!lane.sessionDir) {
		return {
			calls: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costTotal: 0,
			files: 0,
			badLines: 0,
		};
	}
	const originDir = dirname(lane.sessionDir);
	const files = conversationSessionFiles(originDir);
	return summarizeSessionFiles(files);
}
