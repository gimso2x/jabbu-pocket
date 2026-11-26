import type { ChannelBinding } from "../channel/adapter";
import type { JabbuConfig } from "../config";
import type { DriverFactory } from "../core/mailbox";
import type { MailboxClock } from "../core/types";
import type { ProcessRunner } from "../dispatch/omp";
import type { LandLane } from "../lanes/land";
import type { PrTools } from "../lanes/pr";
import type { PrLandSeams } from "../lanes/pr-land-steps";
import type { ClaimEvidence, VerifyResult } from "../lanes/verify";
import type { Logger } from "../log";
import type { AgyAccountPool, AgyAccountsStatus } from "../omp/agy-account-pool";
import type { BackupOptions, BackupResult } from "../ops/backup";
import type { HostLoadReader, StatfsReader } from "../ops/host-resources";
import type { TaskLandDeps, TaskLandResult } from "../tasks/land";
import type { TaskRow } from "../tasks/ledger";
import type { CrashPoint } from "./crash";
import type { RestartLauncherDeps } from "./restart";

export interface DaemonOptions {
	config: JabbuConfig;
	/** The config.json text `loadConfig` validated for this boot (`undefined` = unreadable); only it can become last-good at ready. Absent (tests) → read at `start()`. */
	bootConfigText?: string | undefined;
	/** The chat platforms, one binding each: its port carries the core's posts (redacted), its adapter the inbound path and delivery pump. */
	channels: readonly ChannelBinding[];
	/** Builds the raw driver for (origin, sessionDir); the daemon namespaces its opRefs. */
	driverFactory: DriverFactory;
	log: Logger;
	ompVersion: string;
	/** Id of this daemon boot (also written to the lock file). */
	bootId: string;
	clock?: MailboxClock;
	crash?: (point: CrashPoint) => void;
	sweepMs?: number;
	/** Gate sweep cadence (default 5 minutes); 0 disables gate reporting (test-only). */
	gateSweepMs?: number;
	/** Test seam for the `host_pressure` gate in sweeps and status (default this machine's readings). */
	hostLoad?: Partial<HostLoadReader>;
	/** Test seam for the `disk_low` gate in sweeps and status and for a [TASK] start's disk check (default `statfsSync`). */
	statfs?: StatfsReader;
	/** `start()` first-install backup runner; default {@link runBackup}. */
	bootBackup?: (options: BackupOptions) => BackupResult;
	/** [TASK] sweep cadence (default 1 minute); 0 disables it (tests call `sweepTasks()` directly). */
	taskSweepMs?: number;
	/** Sweep retry cadence for stranded pending rows (default {@link PENDING_RETRY_MS}); 0 disables it. */
	pendingRetryMs?: number;
	/** Approval buttons unanswered for this long count as denied (default 30 minutes). */
	approvalTimeoutMs?: number;
	/** Concurrent work lanes (default 4). */
	maxLanes?: number;
	/** How long stop() waits for running turns to settle before stopping children (default STOP_DRAIN_MS). */
	stopDrainMs?: number;
	/** Test seam: how long a turn waits for the thread read of its context (default 10s in the mailbox). */
	threadContextTimeoutMs?: number;
	/** Test seam for done-claim verification; default checks the real git repository. */
	verifyClaim?: (evidence: ClaimEvidence, cwd: string) => Promise<VerifyResult>;
	/**
	 * Test seam for landing a closed work lane or a reached local [TASK] (one lander, serialized per repository);
	 * default merges, pushes and cleans up with real git.
	 */
	landLane?: LandLane;
	/** Test seam for the core's [TASK] landing (`landTask` with the daemon's deps); default `landTask`. */
	taskLand?: (row: TaskRow, deps: TaskLandDeps) => Promise<TaskLandResult>;
	/** Test seam for a [TASK]'s PR landing (`lanes.land` pr): gh/git `tools` and `seams` (git, leak check, crash hook); default the real ones. */
	prLand?: { tools?: PrTools; seams?: PrLandSeams };
	/** Test seam for the lanes' independent review (`taskAutoLand.review`); default runs the real `omp -p`. */
	laneReviewRun?: ProcessRunner;
	/** Test seam for whether a `jabbu-pocket lanes attach` process lives; default signal 0 on this machine. */
	pidAlive?: (pid: number) => boolean;
	/** Test seam for the [TASK] sweep's herdr calls (remind, agent status, board pane); default runs the real herdr. */
	herdrRun?: ProcessRunner;
	/** Test seam for `!restart`: git/systemctl/systemd-run runner, bun lookup and lock-holder check. */
	restart?: Partial<Pick<RestartLauncherDeps, "run" | "isAlive" | "isExecutable" | "pathEnv" | "repoDir">>;
	/** Test seam for `!brief`'s chromium capture; default runs the real chromium. */
	briefingRun?: ProcessRunner;
	/** Test seam for `#ops` panel `전체 한도` command execution (`dashboard.usageLimits` / `omp usage`). */
	usageLimitsRun?: ProcessRunner;
	/** Live `agy` account pool status when `agent: "agy"` uses an account pool. */
	agyStatus?: () => AgyAccountsStatus | undefined;
	/** Shared `agy` account pool for `/usage-reset-jabbu` unblock actions. */
	agyPool?: AgyAccountPool | undefined;
}

export interface InjectRequest {
	origin: string;
	asOwner: boolean;
	text: string;
	quoted?: string | undefined;
	/** Thread root ts: the marker and the owner message become replies in that thread (exercises a thread reply). */
	thread?: string | undefined;
}

export interface InjectResult {
	nonce: string;
	threadRef: string;
}

/** Sweep-retry state of one origin with stranded pending rows (see `#sweepPendingDispatch`). */
export interface PendingRetryState {
	/** Clock time of the last retry attempt (the per-origin cadence gate). */
	at: number;
	/** Platform message id of the oldest stale pending row: progress is measured on it leaving pending. */
	oldestId: string;
	/** Failed retries in a row; progress clears the whole state. */
	failures: number;
	/** Last drain error text (the alert incident's sign); empty while no retry has rejected. */
	sign: string;
}
