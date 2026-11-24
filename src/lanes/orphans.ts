import { existsSync } from "node:fs";
import type { Logger } from "../log";
import type { Store } from "../store/db";
import { worktreePathOf } from "../tasks/docs";

/**
 * Lane ids that have a `lane/*` branch and a worktree directory in `repo` but no row in the registry: what a start
 * leaves when the process dies between creating the worktree and writing the row. Report only (nothing is deleted:
 * a branch can also be work somebody kept). `nextLaneId` already skips these ids, so a new lane never collides.
 */
export function orphanLaneIds(
	repo: string,
	branchIds: ReadonlySet<string>,
	rowIds: ReadonlySet<string>,
	hasWorktree: (path: string) => boolean = existsSync,
): string[] {
	return [...branchIds].filter((id) => !rowIds.has(id) && hasWorktree(worktreePathOf(repo, id))).sort();
}

/** The lane ids in the registry; logs one warning when `repo` holds orphans (see `orphanLaneIds`). */
export function laneRowIdsReportingOrphans(
	store: Pick<Store, "listLanes">,
	repo: string,
	branchIds: ReadonlySet<string>,
	log: Logger,
): Set<string> {
	const rowIds = new Set(
		store.listLanes().flatMap((lane) => (lane.meta.laneId === undefined ? [] : [lane.meta.laneId])),
	);
	const orphans = orphanLaneIds(repo, branchIds, rowIds);
	if (orphans.length > 0) {
		log.warn("lane_orphan_worktrees", {
			repo,
			lanes: orphans,
			hint: "worktree와 lane/* 브랜치는 있고 레지스트리 행이 없음(시작 중 크래시 잔여물일 수 있음). 삭제하지 않음: git worktree list로 확인 후 직접 정리",
		});
	}
	return rowIds;
}
