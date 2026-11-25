import type { ChannelRegistry } from "../channel/registry";
import type { JabbuConfig } from "../config";
import type { PauseCheck } from "../core/mailbox";
import type { ChatPlatform } from "../core/origin-key";
import type { InboundRecord, MailboxClock } from "../core/types";
import type { Logger } from "../log";
import type { LaneModelTiers } from "../model-tiers";
import type { FreezeState } from "../ops/freeze";
import type { HostLoadReader, StatfsReader } from "../ops/host-resources";
import type { SessionCeilingGate } from "../ops/host-sessions";
import type { LaneAttachOutcome, LaneSessionOps } from "./manager-session";

export type { LaneAttachOutcome, LaneSessionOps };

import type { ApprovalDetail, ApprovalOrigin, ApprovalResult } from "../safety/approval";
import type { Store } from "../store/db";
import type { AutoLandPolicy } from "../tasks/auto-land-policy";
import type { TaskHostOps } from "../tasks/host";
import type { WikiNotes } from "../wiki/notes";
import type { IntegrityInput, IntegrityRefusal, LaneDiffRange } from "./integrity";
import type { CoreRebaseResult, LandLane } from "./land";
import type { LaneDiff } from "./lane-diff";
import type { PrTools } from "./pr";
import type { LaneLandMode, PrLandSeams } from "./pr-land-steps";
import type { GateSlot } from "./qa";
import type { LaneReviewDeps } from "./review";
import type { LaneRow, LaneStatus } from "./status";
import type { ClaimEvidence, GitRunner, VerifyResult } from "./verify";

/** What settling a claim reports: the owner-facing text, plus the registry's row when the settle transitioned the lane. */
export interface SettleOutcome {
	text: string;
	/** The post-transition row; absent when the settle left the registry as it found it. */
	row?: LaneRow;
}

/** The core's rebase of a not-ff lane; `superseded`: it rebased, but the lane had left `working` (paused) meanwhile. */
export type LaneCoreRebase =
	| CoreRebaseResult
	| { state: "superseded"; status: LaneStatus; oldSha: string; newSha: string };

/** What a merge or discard request did: `handled` false = the lane was not in a state that takes it (nothing changed). */
export interface LaneRequestOutcome {
	handled: boolean;
	text: string;
}

export interface LaneManagerDeps {
	/** `recordsRepo` as of now (live config): the lane's `doc/plans/*.md` are read from there, read-only. */
	recordsRepo?(): string | undefined;
	/** `herdrBoard.url` as of now (live config); the owner-facing cards link the dashboard's diff view under it. */
	boardUrl?(): string | undefined;
	store: Store;
	channels: ChannelRegistry;
	clock: MailboxClock;
	/** The bot's zone (`config.timezone`): a lane id carries the date of this zone's calendar day. */
	timezone: string;
	log: Logger;
	sessionsRoot: string;
	/** Hands a record to the mailbox of `record.originKey`; resolves once it has been dispatched. */
	route(record: InboundRecord): Promise<void>;
	/** Stops the lane's omp child after its running turn (the lane is closed). */
	stopWhenIdle(originKey: string): Promise<void>;
	/** Stops the lane's running turn for a pause: aborts and settles it; resolves with the re-read state. */
	pauseTurn(originKey: string): Promise<PauseCheck>;
	/** Dispatches the rows that piled up while the lane was held (the owner resumed it). */
	resumePending(originKey: string): Promise<void>;
	/** The lane child as the terminal hand-over (`jabbu-pocket lanes attach`) needs it. */
	session: LaneSessionOps;
	/** Whether the attaching CLI process still lives (test seam; default signal 0 on this machine). */
	pidAlive?: (pid: number) => boolean;
	maxLanes?: number;
	/** Freeze switch (`<home>/FROZEN`): while it returns a state no lane starts. */
	frozen?: () => FreezeState | undefined;
	/** `<jabbu home>/lanes`: a closing lane's file evidence is copied to `<lanes>/<lane>/artifacts/<sha256>` before its worktree goes. */
	lanesDir?: string;
	/** Test seam; default checks the real git repository. */
	verify?: (evidence: ClaimEvidence, cwd: string, baseSha?: string, baseBranch?: string) => Promise<VerifyResult>;
	/** Test seam; default reads the lane's `git diff` from the merge-base with its base branch (`collectLaneDiff`). */
	collectDiff?: (laneCwd: string, range: LaneDiffRange, sha: string) => Promise<LaneDiff>;
	/** Test seam; default judges the claim's summary + diff (hermes completion_integrity). */
	integrity?: (input: IntegrityInput) => IntegrityRefusal[];
	/** Worktree creation and `[check: …]` runs on this machine (test seam; default `createTaskHostOps()`). */
	hostOps?: TaskHostOps;
	/** The approval card of an external PR publish (`ApprovalBroker.ask`, lane thread as `origin`). Absent: `PR 게시` is refused. */
	requestApproval?(request: {
		channel: string;
		summary: string;
		detail: ApprovalDetail;
		origin: ApprovalOrigin;
		signal: AbortSignal;
	}): Promise<ApprovalResult>;
	/** git and gh of an external PR publish (test seam; default the real programs). */
	prTools?: PrTools;
	/** `lanes.land` of the lane's repository and its denylist file (live config); absent or `ff`: the lane lands as always. */
	landMode?: (repo: string) => Promise<LaneLandMode | undefined>;
	/** Test seams of the PR landing (default: the real leak check, gitleaks and git). */
	prLandSeams?: PrLandSeams;
	/** Owner approval surface: an integrity refusal can be overridden by an explicit click. */
	approvals?: { request(channel: string, summary: string): Promise<"approved" | "denied" | "timeout"> };
	/** Joins `<sessionsRoot>/<origin>/e1` the way `sessionDirFor` does (injected to keep this module free of origin.ts). */
	sessionDirFor: (originKey: string) => string;
	/** `taskAutoLand`, read at each close (a live setting); `undefined` → every closed lane waits for the owner. */
	autoLandPolicy?: () => AutoLandPolicy | undefined;
	/** Why auto-merge is held after an apply code rollback (`<home>/autoland.hold`); undefined = not held. */
	autoLandHold?: () => string | undefined;
	/** Whether the repository at `path` is one of `repos` (test seam; default the git common-directory comparison). */
	repoMatches?: (path: string, repos: readonly string[]) => Promise<boolean>;
	/** Lands a closed lane (test seam; default `createLaneLander` over real git and `hostOps.removeWorktree`). */
	land?: LandLane;
	/** Mentioned on cards that need the owner's decision: one id, or the owner's id on the lane's platform. */
	ownerUserId?: string | ((platform: ChatPlatform) => string | undefined);
	/** Whether the lane's session is in a turn (the claiming one still writes its report); landing/discard waits for it. Default: never busy. */
	laneBusy?: (originKey: string) => boolean;
	/** How the independent review (`taskAutoLand.review`) runs `omp -p`: the omp binary, safety floors, `<jabbu home>/reviews`. Absent: `inconclusive`. */
	reviewer?: Omit<LaneReviewDeps, "headOf" | "now">;
	/** `<jabbu home>/qa-worktrees`: the run QA's copies (leftovers removed at start). Absent: a QA policy finds no runner (`inconclusive`). */
	qaWorktreesDir?: string;
	/** The one review-or-QA slot, shared with the [TASK] gate (default: a slot of the manager's own). */
	gateSlot?: GateSlot;
	/** Git for the Outcome card's change summary (test seam; default 10 seconds per call, `computeLaneChanges`). */
	changesGit?: GitRunner;
	/** `$JABBU_HOME/followups.jsonl`: a merged lane's non-blocking leftovers are appended there (`appendFollowups`); absent: none. */
	followupsFile?: string;
	/** The wiki result note of a landed lane (`src/wiki`): draft kept when a landing begins, written once `landed`. Absent: no note. */
	wikiNotes?: Pick<WikiNotes, "laneDraft" | "laneDropDraft" | "laneLanded">;
	/** Git for the core's rebase of a lane whose landing was not fast-forward (test seam; default `defaultGit`). */
	rebaseGit?: GitRunner;
	/** `lanes.models`, read at each start (a live setting): the tiers `start({model})` may pick. */
	laneModels?: () => LaneModelTiers | undefined;
	ownerSilenceConfig?: () => Pick<JabbuConfig, "ownerSilenceFallbackMinutes">;
	/** Test seam for the start-capacity gate's memory readers (default this machine's own); a refusal throws, `force` passes. */
	hostLoad?: Partial<HostLoadReader>;
	/** `statfs` for the start-capacity gate's disk floor (test seam; default the real one). */
	statfs?: StatfsReader;
	/** The host-wide omp session ceiling the start gate judges (`hostSessionCeiling`); absent → not judged. */
	hostSessions?: SessionCeilingGate;
}
