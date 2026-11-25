import { createHash } from "node:crypto";
import type { LogFields } from "../log";
import { laneDeclared } from "./declared";
import {
	classifyLaneCompletion,
	type IntegrityRefusal,
	type LaneDiffRange,
	LaneDiffUnavailable,
	laneDiffUnavailableRefusal,
	laneDiffUnreadRefusal,
} from "./integrity";
import { collectLaneDiff } from "./lane-diff";
import { capRefusals } from "./refusal-cap";
import type { LaneClaim, LaneRow } from "./status";

/** The events by which the owner steps into a lane that has claimed done: a reply, a pause, a reopen. */
const OWNER_EVENTS = new Set(["owner_reply", "paused", "reopened"]);

/** How many times the owner stepped into the lane (history; a capped history can only lose some, never add). */
export const ownerEventCount = (lane: LaneRow): number => lane.history.filter((e) => OWNER_EVENTS.has(e.event)).length;

/**
 * Names one verdict: the sha256 of each refusal's `category` + NUL + `excerpt`, sorted and joined by SOH. A different
 * summary that classifies differently (another category or excerpt) is another verdict.
 */
export function refusalFingerprint(refusals: readonly IntegrityRefusal[]): string {
	const parts = refusals.map((r) => `${r.category}\u0000${r.excerpt}`).sort();
	return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

/** The owner approved this very verdict (same commit, same refusals) before: it is not asked about again. */
export function approvalCovers(lane: LaneRow, sha: string, refusals: readonly IntegrityRefusal[]): boolean {
	const approval = lane.meta.integrityApproval;
	return approval !== undefined && approval.sha === sha && approval.fingerprint === refusalFingerprint(refusals);
}

/**
 * The meta to record for an approval that arrived for `sha`: only while the lane still waits on a done claim and the
 * owner did not step in since the card went out (`ownerEvents` then); undefined otherwise.
 */
export function approvalRecord(
	current: LaneRow | undefined,
	ownerEvents: number,
	sha: string,
	refusals: readonly IntegrityRefusal[],
	at: number,
): NonNullable<LaneRow["meta"]["integrityApproval"]> | undefined {
	if (current?.status !== "done-claimed" || ownerEventCount(current) !== ownerEvents) return undefined;
	return { sha, fingerprint: refusalFingerprint(refusals), at };
}

/** What the integrity check needs of the manager: its seams. */
export interface IntegrityReaders {
	collectDiff?: (laneCwd: string, range: LaneDiffRange, sha: string) => ReturnType<typeof collectLaneDiff>;
	integrity?: typeof classifyLaneCompletion;
	/** The records repository (`recordsRepo`) the lane's plans are read from; undefined = the lane's worktree. */
	plansRoot: () => string | undefined;
	warn: (event: string, fields: LogFields) => void;
}

/**
 * Collects the lane's diff (from the merge-base with its base branch) and judges the claim text + diff. A base branch that cannot be read is a
 * refusal of its own, and so are code files too large to read (the rest is judged); any other unreadable diff
 * degrades to text-only.
 */
export async function integrityRefusalsOf(
	readers: IntegrityReaders,
	lane: LaneRow,
	claim: LaneClaim,
	sha: string,
): Promise<IntegrityRefusal[]> {
	const classify = readers.integrity ?? classifyLaneCompletion;
	const { baseSha, baseBranch } = lane.meta;
	const range: LaneDiffRange = { baseSha, baseBranch };
	let diff = "";
	let unread: string[] = [];
	if (baseSha !== undefined || baseBranch !== undefined) {
		try {
			({ diff, unread } = await (readers.collectDiff ?? collectLaneDiff)(lane.cwd, range, sha));
		} catch (error) {
			readers.warn("lane_diff_unavailable", { lane: lane.name, error: String(error) });
			if (error instanceof LaneDiffUnavailable) {
				return capRefusals([laneDiffUnavailableRefusal(error), ...classify({ summary: claim.summary, diff: "" })]);
			}
		}
	}
	const refusals = classify({ summary: claim.summary, diff, declared: await laneDeclared(lane, readers.plansRoot()) });
	const unreadRefusals = unread.length > 0 ? [laneDiffUnreadRefusal(unread)] : [];
	return capRefusals([...unreadRefusals, ...refusals]);
}
