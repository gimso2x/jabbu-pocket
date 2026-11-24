/** Where a PR landing stands; each step is saved right after it is done and a re-run continues from it. */
export type PrStep = "leak-checked" | "pushed" | "pr-created" | "ci-green" | "merging" | "merged" | "synced";

/** What `meta.land.prLand` keeps of a lane's own-repository PR landing. */
export interface LanePrLand {
	number?: number;
	url?: string;
	/** `lane/<laneId>`: one PR per lane. */
	branch: string;
	/** `owner/name` of the remote the PR lives in. */
	slug?: string;
	/** The commit on the remote branch: the one that was leak-checked and the only one that may be merged. */
	pushedSha?: string;
	/** When the CI wait began (the push, or the owner's resume of a held landing). */
	pushedAt?: number;
	createdAt?: number;
	lastPolledAt?: number;
	ci?: { verdict: "success" | "failure" | "pending" | "none"; sha: string };
	/** Failed jobs (name and run id) the lane was last sent back for: the same failure is not sent twice. */
	failedSig?: string;
	/** Times the lane was sent back for a red CI. */
	bounces?: number;
	/** The squash commit on the remote base branch. */
	mergedSha?: string;
	/** The local base branch before the sync (how to undo it); saved before the sync so a re-run keeps it. */
	preSha?: string;
	/** Why the local base branch was not brought up to date (the merge itself stands). */
	syncNote?: string;
	step?: PrStep;
}

/** What one run of the PR landing ended with (`openPrLanding`, `pollPrLanding`). */
export type PrLandOutcome =
	/** PR open, CI to be waited for. */
	| { kind: "pr-open"; prLand: LanePrLand }
	/** Nothing was done; the owner has to look (`reason` in Korean). */
	| { kind: "blocked"; reason: string }
	/** The PR stays open and the core lets go of it; the owner decides. */
	| { kind: "held"; reason: string }
	/** The lane has to change something: `notice` goes to its thread; `prLand` is what was saved so far. */
	| { kind: "rework"; reason: string; notice: string; prLand: LanePrLand }
	/** Merged on the remote and the local base branch synced; `cleanup` = what is left to do by hand. */
	| { kind: "landed"; mergedSha: string; pushed: string; preSha: string; cleanup?: string }
	/** Nothing to do now (CI running, freeze, a failed read: `warn` says why, once per reason). */
	| { kind: "waiting"; warn?: string };
