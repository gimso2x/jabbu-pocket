import { createHash } from "node:crypto";
import type { LogFields } from "../log";
import { laneDeclared } from "./declared";
import {
	classifyLaneCompletion,
	collectLaneCommitIdentities,
	commitIdentityRefusals,
	type IntegrityRefusal,
	type LaneDiffRange,
	LaneDiffUnavailable,
	laneDiffUnavailableRefusal,
	laneDiffUnreadRefusal,
	MAX_REFUSALS,
} from "./integrity";
import { collectLaneDiff } from "./lane-diff";
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

/** What the integrity check needs of the manager: its seams and the lane's own commit-identity policy. */
export interface IntegrityReaders {
	collectDiff?: (laneCwd: string, range: LaneDiffRange, sha: string) => ReturnType<typeof collectLaneDiff>;
	integrity?: typeof classifyLaneCompletion;
	collectIdentities?: typeof collectLaneCommitIdentities;
	/** The allowed commit emails of the lane's repository; undefined = not checked. */
	allowedEmails: (lane: LaneRow) => Promise<string[] | undefined>;
	/** The records repository (`recordsRepo`) the lane's plans are read from; undefined = the lane's worktree. */
	plansRoot: () => string | undefined;
	warn: (event: string, fields: LogFields) => void;
}

/**
 * Collects the lane's diff (from the merge-base with its base branch) and judges the claim text + diff, then the
 * author/committer emails of its own commits when the repository lists them. A base branch that cannot be read is a
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
				return [laneDiffUnavailableRefusal(error), ...classify({ summary: claim.summary, diff: "" })];
			}
		}
	}
	const refusals = classify({ summary: claim.summary, diff, declared: await laneDeclared(lane, readers.plansRoot()) });
	const unreadRefusals = unread.length > 0 ? [laneDiffUnreadRefusal(unread)] : [];
	const identities = await commitIdentityRefusalsOf(readers, lane, range, sha);
	return [...unreadRefusals, ...refusals, ...identities].slice(0, MAX_REFUSALS);
}

/**
 * The refusals of the lane's commit identities: none when the repository is not in `taskAutoLand.commitEmails`, and a
 * `commit_identity_mismatch` for each commit whose author or committer email is not allowed.
 */
async function commitIdentityRefusalsOf(
	readers: IntegrityReaders,
	lane: LaneRow,
	range: LaneDiffRange,
	sha: string,
): Promise<IntegrityRefusal[]> {
	const allowed = await readers.allowedEmails(lane);
	if (allowed === undefined) return [];
	try {
		const identities = await (readers.collectIdentities ?? collectLaneCommitIdentities)(lane.cwd, range, sha);
		const refusals = commitIdentityRefusals(identities, allowed);
		if (refusals.length > 0)
			readers.warn("lane_commit_identity_refused", { lane: lane.name, refusals: refusals.length });
		return refusals;
	} catch (error) {
		// Like an unreadable diff: the claim is refused (`lane_diff_unavailable`), not passed on a read that did not run.
		readers.warn("lane_commit_identity_unavailable", { lane: lane.name, error: String(error) });
		return [
			laneDiffUnavailableRefusal(error instanceof LaneDiffUnavailable ? error : new LaneDiffUnavailable(String(error))),
		];
	}
}
