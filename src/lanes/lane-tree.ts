import { existsSync } from "node:fs";
import type { Store } from "../store/db";
import type { LaneLand, LaneRow } from "./status";
import type { GitRunner } from "./verify";

/** What is still on disk of a lane: its worktree and its branch, each named for a cleanup message. */
export async function laneTreeLeft(
	git: GitRunner,
	{ repo, worktree, branch }: { repo: string; worktree: string; branch: string },
): Promise<string[]> {
	const left: string[] = [];
	if (existsSync(worktree)) left.push(`worktree ${worktree}`);
	if ((await git(["-C", repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0) {
		left.push(`브랜치 ${branch}`);
	}
	return left;
}

/**
 * A `not-done` or unlanded lane whose worktree and branch someone already removed: nothing is left to land or accept,
 * so it closes as `discarded` instead of failing every external-land check.
 */
export function closeLaneTreeGone(store: Store, lane: LaneRow): LaneRow {
	const entry = { event: "discarded", detail: "worktree와 브랜치가 이미 없음 — 머지할 것 없이 폐기" };
	const land: LaneLand = {
		...lane.meta.land,
		state: "discarded",
		attempts: lane.meta.land?.attempts ?? 0,
		reason: entry.detail,
		requestedBy: undefined,
	};
	return lane.status === "closed"
		? store.patchLane(lane.name, entry, { land })
		: store.transitionLane(lane.name, "closed", entry, { land });
}
