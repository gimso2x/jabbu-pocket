import type { LaneRow } from "./status";

/** `repoMatchesCommonDir` or a test's stand-in: whether `path` is a work tree of one of `repos`. */
export type RepoMatcher = (path: string, repos: readonly string[]) => Promise<boolean>;

/** Whether two lane `meta.repo` top levels are one repository: a linked worktree shares the git common directory. */
export async function sameRepo(a: string, b: string, matches: RepoMatcher): Promise<boolean> {
	return a === b || (await matches(a, [b]));
}

/** The other open lanes of the repository `repo` (the first prompt's overlap list). */
export async function openLanesOfRepo(
	lanes: readonly LaneRow[],
	name: string,
	repo: string,
	matches: RepoMatcher,
): Promise<LaneRow[]> {
	const open = lanes.filter((lane) => lane.name !== name && lane.status !== "closed" && lane.meta.repo !== undefined);
	const same = await Promise.all(open.map((lane) => sameRepo(lane.meta.repo as string, repo, matches)));
	return open.filter((_, index) => same[index]);
}
