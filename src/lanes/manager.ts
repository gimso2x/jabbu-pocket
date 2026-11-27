import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ActionButton, type MessageRef, renderMentions } from "../channel/port";
import { cutCodePointSafe, escapeMrkdwn, formatElapsed } from "../channel/text";
import { sessionToResume } from "../core/mailbox";
import { parseThreadRef, platformOfThreadRef, threadRefOf } from "../core/normalize";
import { pidAlive } from "../daemon/lock";
import type { OmpSessionDriver, TodoPhase } from "../omp/driver";
import { frozenMessage } from "../ops/freeze";
import { diskHeadroom } from "../ops/host-resources";
import { startCapacity } from "../ops/start-capacity";
import { redact } from "../redact";
import type { Store } from "../store/db";
import { typicalLaneDuration } from "../store/turn-duration";
import type { LaneQaPolicy } from "../tasks/auto-land-policy";
import { type TaskCheck, type TaskChecksRun, taskChecksOf } from "../tasks/checker";
import { oneLine, worktreePathOf } from "../tasks/docs";
import { runWorktreeChecks } from "../tasks/evaluate";
import { createTaskHostOps, type TaskHostOps } from "../tasks/host";
import { cardMessage } from "../tasks/notify";
import { repoMatchesCommonDir } from "../tasks/repo-match";
import { applyRiskFloor } from "../tasks/risk-floor";
import { CHECK_TIMEOUT_MS, type SignalCheck } from "../tasks/signals";
import { resolveWorkerTier } from "../tasks/worker-tier";
import { localDay } from "../time";
import { changedFilesSince, fileSize, headOf, sessionDelta } from "./attach";
import { claimBorrowedThread, failBorrowedStatus } from "./borrow-thread";
import { buildLaneOutcomeCard, type LaneCardView, laneSessionActionId } from "./card";
import { computeLaneChanges } from "./changes";
import { laneCost } from "./cost";
import { planLocations } from "./declared";
import type { IntegrityRefusal } from "./integrity";
import { approvalCovers, approvalRecord, integrityRefusalsOf, ownerEventCount } from "./integrity-approval";
import {
	CLAIM_SHA,
	confidentBand,
	coreRebase,
	createLaneLander,
	externallyLanded,
	type LandLane,
	type LandResult,
	laneLandBlockers,
	laneQaRisk,
	pushedOutside,
	receiptNowOf,
	receiptStaleOf,
} from "./land";
import { closeLaneTreeGone, laneTreeLeft } from "./lane-tree";
import {
	AUTO_LAND_OFF,
	CHECK_DETAIL_MAX,
	CLAIM_GRACE_MS,
	CLOSED_LANE_REPLY,
	DEFAULT_MAX_LANES,
	DEFERRED_REPLY,
	EXPIRY_UNANNOUNCED,
	INCONCLUSIVE_RUNS_MAX,
	LAND_ATTEMPTS_MAX,
	LAND_ERRORS_MAX,
	LaneCapError,
	LaneInputError,
	MAX_BRIEF_CHARS,
	MAX_LANE_EVIDENCE,
	MAX_MILESTONE_CHARS,
	MAX_TITLE_CHARS,
	OVERLAP_REPLY,
	PAUSED_LANE_REPLY,
	PR_CUT_BY_RESTART,
	PR_CUT_BY_STOP,
	REVIEW_FILE_SUFFIXES,
	STATE_TEXT,
	STOPPED_REPLY,
} from "./manager-constants";
import { PrLandHost } from "./manager-pr-land";
import { PrWatchRunner } from "./manager-pr-watch";
import { detachSummary, failedChecksOf, pauseButton, slugify, splitModelThinking } from "./manager-text";
import type {
	LaneAttachOutcome,
	LaneCoreRebase,
	LaneManagerDeps,
	LaneRequestOutcome,
	SettleOutcome,
} from "./manager-types";
import { laneRowIdsReportingOrphans } from "./orphans";
import { type LaneProgressOptions, ownerQuestionOf, tickOwnerSilence } from "./owner-silence";
import {
	defaultPrTools,
	type ExternalPrInput,
	firstLineOf,
	planPr,
	publishPr,
	readPrBody,
	resolveExternalPr,
	resolvePushTarget,
} from "./pr";
import { PR_LAND_POLL_MS } from "./pr-land-steps";
import { preserveFileEvidence, verifyProgressEvidence } from "./progress-evidence";
import { cleanQaWorktrees, createGateSlot, type GateSlot, qaDepsOf, runLaneQa, untilAborted } from "./qa";
import { refusalCardLines } from "./refusal-cap";
import {
	blockerMessage,
	blockerSignature,
	buildReservationReadyMessage,
	expiredNotice,
	judgeAfter,
	type LaneReservation,
	RESERVATION_AFTER_MAX,
	RESERVATION_TTL_MS,
} from "./reservations";
import { formatConfidence, reviewLane } from "./review";
import { currentRuntime, primeGateChanges } from "./runtime";
import { openLanesOfRepo, type RepoMatcher, sameRepo } from "./same-repo";
import { appendFollowups, checkLaneScope, parseLaneLeftovers } from "./scope";
import { parseStartArgs } from "./start-args";
import {
	INCONCLUSIVE_APPROVED,
	INTEGRITY_APPROVED,
	isCoreSteerId,
	type LaneAttach,
	type LaneChanges,
	type LaneChecksInconclusive,
	type LaneClaim,
	type LaneExternalPr,
	type LaneLand,
	type LaneMeta,
	type LanePr,
	type LaneQa,
	type LaneReview,
	type LaneRow,
	type LaneStatus,
	laneOriginKey,
	OWNER_ACCEPTED,
	OWNER_PAUSE_HELD,
} from "./status";
import { closedDrawn, syncLane } from "./sync";
import {
	buildLanePrompt,
	buildLaneTodos,
	buildNotDonePrompt,
	buildRebasePrompt,
	classifyClosedLaneMessage,
} from "./trigger";
import { type ClaimEvidence, defaultGit, resolveBaseSha, type VerifyResult, verifyClaim } from "./verify";
import { advertisedWorkflow, isUlwWorkflow } from "./workflow";
import { DEFAULT_LANE_RISK, laneBranchOf, laneIdsOnBranches, nextLaneId, resolveLaneRepo } from "./worktree";

/** Work lanes: one omp session per long task with its own thread, registry row and verified end. */
export class LaneManager {
	readonly #deps: LaneManagerDeps;
	readonly #max: number;
	#starting = 0;
	/** Lane ids of starts that picked an id but have no registry row yet (two starts never take the same id). */
	readonly #reservedLaneIds = new Set<string>();
	/** Lanes whose terminal hand-over is running (the orphan check and a second attach leave them alone). */
	readonly #attaching = new Set<string>();
	/** Lane names a start picked before its row exists (the status message is posted in between). */
	readonly #reservedNames = new Set<string>();
	/** Reservations whose ▶ is inside `start` in this process: a `started` row without a lane is not an orphan yet. */
	readonly #startingReservations = new Set<number>();
	/** Keys (parentOrigin, title, cwd) of the starts in flight: a second start of the same key is refused. */
	readonly #startingKeys = new Set<string>();
	/** Conversation threads (`<channel>:<threadId>`) a start in flight is borrowing: a second start opens a sibling. */
	readonly #borrowingThreads = new Set<string>();
	readonly #settling = new Set<string>();
	/** Lanes that claimed again while their verdict ran: judged again as soon as it ends. */
	readonly #resettle = new Set<string>();
	/** Verdicts started without awaiting them (by the tick, or a claim that overlapped a verdict). */
	readonly #settlesInBackground = new Set<Promise<void>>();
	/** A tick verdict that was deferred judges the same claim (`claimedAt`) again only from `at` (memory only). */
	readonly #nextSettleAt = new Map<string, { claimedAt: number; at: number }>();
	/** One `[check: …]` run at a time across all lanes: the tail of the queue for the check slot. */
	#checkSlotTail: Promise<void> = Promise.resolve();
	/** The running checks' abort switches (`stop()` pulls them). */
	readonly #checkAborts = new Set<AbortController>();
	#stopped = false;
	readonly #ops: TaskHostOps;
	readonly #land: LandLane;
	/** Lanes whose merge or discard is running in this process: a second request (a double click) does nothing. */
	readonly #landing = new Set<string>();
	/** Lanes whose Outcome card is being posted (a close and a tick never post two). */
	readonly #announcing = new Set<string>();
	/** Work started without awaiting it (the card and auto-merge after a close); `idle()` waits for it. */
	readonly #background = new Set<Promise<void>>();
	/** Lanes whose independent review is running (in the background: a tick never waits for one). */
	readonly #reviewing = new Set<string>();
	/**
	 * Lanes whose run QA is running: its abort switch and when its run (not the announce after it) has ended. A landing,
	 * discard or `!reopen` aborts it first.
	 */
	readonly #qaRunning = new Map<string, { abort: AbortController; ended: Promise<void> }>();
	/** One review or QA at a time across all lanes (and the [TASK] gate when the daemon shares its slot). */
	readonly #reviewSlot: GateSlot;
	/** Lanes whose channel was found unregistered by a draw: the skip is logged once per lane per process. */
	readonly #unroutableWarned = new Set<string>();
	/** Origins whose lane worktree the core is rebasing: their mailbox holds its rows (`isCoreRebasing`). */
	readonly #coreRebasing = new Set<string>();
	/** External PR publishes running in this process (also in `#landing`): `stop()` aborts them. */
	readonly #publishing = new Map<string, AbortController>();
	/** Reads the published external PRs (pr-watch) and the PRs of `land: "pr"` lanes: both run in the background. */
	readonly #prWatch: PrWatchRunner;
	readonly #prLand: PrLandHost;

	constructor(deps: LaneManagerDeps) {
		this.#deps = deps;
		this.#max = deps.maxLanes ?? DEFAULT_MAX_LANES;
		this.#reviewSlot = deps.gateSlot ?? createGateSlot();
		this.#ops = deps.hostOps ?? createTaskHostOps();
		const ops = this.#ops;
		this.#land = deps.land ?? createLaneLander({ removeWorktree: (input) => ops.removeWorktree(input) });
		this.#prWatch = new PrWatchRunner({
			deps,
			patchPr: (name, patch, entry) => this.#patchPr(name, patch, entry),
			spawn: (lane, work) => this.#spawn(lane, work),
		});
		this.#prLand = new PrLandHost({
			deps,
			removeWorktree: (input) => ops.removeWorktree(input),
			patchLand: (name, patch, entry) => this.#patchLand(name, patch, entry),
			preserve: (name, worktree) => this.#preserveArtifacts(name, worktree),
			sync: (row) => this.#sync(row, "transition"),
			showResult: (row, fresh) => this.#showResult(row, fresh),
			editCard: (row, cardTs, view) => this.#editCard(row, cardTs, view),
			post: (lane, text) => this.#postInThread(lane, text),
			send: (name, kind, text) => this.#send(name, kind, text),
		});
		// QA copies a stop or crash left behind go at start, in the review slot so no QA starts before they are gone.
		const qaDir = deps.qaWorktreesDir;
		if (qaDir !== undefined) {
			this.#spawn("qa-worktrees", async () => {
				const free = await this.#reviewSlot();
				try {
					await cleanQaWorktrees(qaDir, deps.reviewer?.git, deps.log);
				} finally {
					free();
				}
			});
		}
	}

	/** Resolves once the background work started so far (Outcome cards, auto-merges) has finished. */
	async idle(): Promise<void> {
		while (this.#background.size > 0) await Promise.all([...this.#background]);
	}

	/**
	 * Whether the core is rebasing the worktree of this origin's lane right now: the origin's mailbox holds its rows so
	 * no lane turn runs in the worktree meanwhile (the daemon's `isHeld`).
	 */
	isCoreRebasing(originKey: string): boolean {
		return this.#coreRebasing.has(originKey);
	}

	/** Tests only: resolves once the verdicts running in the background (and those they started) have ended. */
	async settledInBackground(): Promise<void> {
		while (this.#settlesInBackground.size > 0) await Promise.all([...this.#settlesInBackground]);
	}

	/**
	 * The core is stopping: running checks and reviews are killed (their results are not recorded) and no new one starts. The
	 * verdicts themselves are not awaited — the claim stays in the registry and the tick after the restart judges it.
	 */
	stop(): void {
		this.#stopped = true;
		for (const abort of this.#checkAborts) abort.abort();
		// A publish waiting for its approval (or pushing) is cut: nothing more goes out, the lane is held for the owner.
		for (const [name, abort] of this.#publishing) {
			abort.abort();
			const row = this.#patchPr(
				name,
				{ state: "held", reason: PR_CUT_BY_STOP },
				{ event: "pr_held", detail: PR_CUT_BY_STOP },
			);
			this.#landing.delete(name);
			this.#spawn(name, () => this.#redrawCard(row));
		}
		this.#publishing.clear();
		// The PR reads are read-only: aborting them loses nothing (the write steps of a PR landing resume from `step`).
		this.#prWatch.stop();
		this.#prLand.stop();
	}

	/**
	 * Starts `#settle` without awaiting it. A tick verdict that ended deferred on the same claim is not started by the
	 * tick again before `CLAIM_GRACE_MS`; a throw is logged, never left unhandled.
	 */
	#settleInBackground(name: string, fromTick: boolean): void {
		const { store, clock, log } = this.#deps;
		const claimedAt = store.getLane(name)?.meta.claim?.claimedAt;
		const run: Promise<void> = this.#settle(name, fromTick)
			.then((outcome) => {
				if (!fromTick || outcome.text !== DEFERRED_REPLY || claimedAt === undefined) return;
				const lane = store.getLane(name);
				if (lane?.status === "done-claimed" && lane.meta.claim?.claimedAt === claimedAt) {
					this.#nextSettleAt.set(name, { claimedAt, at: clock.now() + CLAIM_GRACE_MS });
				}
			})
			.catch((error: unknown) => log.error("lane_tick_failed", { lane: name, error: String(error) }))
			.finally(() => this.#settlesInBackground.delete(run));
		this.#settlesInBackground.add(run);
	}

	/** Waits for the check slot (one check run at a time across lanes); the returned function frees it. */
	async #checkSlot(): Promise<() => void> {
		const previous = this.#checkSlotTail;
		const freed = Promise.withResolvers<void>();
		this.#checkSlotTail = previous.then(() => freed.promise);
		await previous;
		return freed.resolve;
	}

	/** The claim `lane` was read with is no longer the lane's pending claim (the owner answered, or it claimed again). */
	#claimSuperseded(lane: LaneRow): SettleOutcome | undefined {
		const current = this.#deps.store.getLane(lane.name);
		if (current?.status === "done-claimed" && current.meta.claim?.claimedAt === lane.meta.claim?.claimedAt) {
			return undefined;
		}
		return { text: "claim superseded by the owner" };
	}

	/** `claimedAt` for a new or renewed claim of `lane`: now, but later than any claim the lane had (`lastClaimedAt`). */
	#claimStamp(lane: LaneRow): number {
		const last = Math.max(lane.meta.lastClaimedAt ?? 0, lane.meta.claim?.claimedAt ?? 0);
		return Math.max(this.#deps.clock.now(), last + 1);
	}

	#spawn(lane: string, work: () => Promise<void>): void {
		const run: Promise<void> = work()
			.catch((error: unknown) => this.#deps.log.error("lane_background_failed", { lane, error: String(error) }))
			.finally(() => this.#background.delete(run));
		this.#background.add(run);
	}

	get store(): Store {
		return this.#deps.store;
	}

	/**
	 * Creates the lane's worktree and branch, the thread, the registry row and starts the lane's first turn. The lane
	 * works in `<repo>-l-yyyymmdd-nn` on `lane/L-YYYYMMDD-NN`, at the same sub path `cwd` had in its repository; the
	 * repository's own checkout is never touched, so several lanes can run on one repository. `acceptance` and `risk`
	 * arrive as the tool received them and are validated here. Throws `LaneInputError` for a refusal (nothing created).
	 */
	async start(input: {
		title: string;
		cwd: string;
		brief?: string | undefined;
		channel: string;
		acceptance?: unknown;
		risk?: unknown;
		/** Repository-relative globs the claim's changes must stay inside (`parseLaneScope`); absent: no check. */
		scope?: unknown;
		/** A `lanes.models` tier; absent: the bot's default model. */
		model?: unknown;
		/** One line on why that tier (masked, one line); blank or absent keeps the default wording. */
		tierReason?: unknown;
		/** The judge's confidence in the tier, 0..1; anything else is a refusal. */
		tierConfidence?: unknown;
		/** The conversation that started the lane (`meta.parentOrigin`, read by the request trace). */
		parentOrigin?: string;
		/** The lane's work goes out as a GitHub PR (`parseExternalPrInput`); absent: an ordinary lane. */
		externalPr?: unknown;
		/** The workflow the starter chose (`workflowChoice`); absent: no keyword line on the first prompt. */
		workflow?: unknown;
		/** The owner explicitly accepted a tight host: a capacity refusal passes (the load warning still shows). */
		force?: boolean;
		/** An open lane of the same conversation, title and path is returned (`reused`) instead of starting another. */
		reuseOpen?: boolean;
		/** `parentOrigin`'s own thread, borrowed instead of opening a sibling when free (`claimBorrowedThread`). */
		borrowThread?: { threadId: string };
	}): Promise<LaneRow & { startNote?: string; reused?: boolean }> {
		const { store, channels, clock, log } = this.#deps;
		const frozen = this.#deps.frozen?.();
		if (frozen !== undefined) {
			log.warn("lane_refused_frozen", { channel: input.channel });
			throw new LaneInputError(frozenMessage(frozen));
		}
		const title = cutCodePointSafe(redact(input.title.replace(/\s+/g, " ").trim()), MAX_TITLE_CHARS);
		if (title === "") throw new LaneInputError("작업 제목이 비어 있습니다.");
		const { risk, acceptance, scope, requestedTier, tierConfidence, tierReason, externalPrInput, workflow } =
			parseStartArgs(input, this.#deps.laneModels?.());
		const givenReason = tierReason === undefined ? "" : redact(oneLine(tierReason));
		// Kept for the independent review: the spec it reads first. A cut one says so inside, so the review knows the
		// rest is missing; the lane itself gets the whole brief.
		const fullBrief = redact(input.brief?.trim() ?? "");
		const briefCut = fullBrief.length > MAX_BRIEF_CHARS;
		const brief = briefCut
			? `${cutCodePointSafe(fullBrief, MAX_BRIEF_CHARS)}\n[브리프 ${fullBrief.length}자 중 앞 ${MAX_BRIEF_CHARS}자만 남김: 뒷부분은 이 리뷰에 없다]`
			: fullBrief;
		// Topic keywords put a floor under the class (raise only); `startNote` tells the starter.
		const floored = applyRiskFloor(risk, [title, brief]);
		// The tier follows the final risk (floor applied; a lane nobody rated counts as DEFAULT_LANE_RISK).
		const worker = resolveWorkerTier(
			floored.risk,
			{
				tier: requestedTier,
				tierReason:
					givenReason !== "" ? givenReason : requestedTier === undefined ? `위험 ${floored.risk} 기본` : "요청",
			},
			this.#deps.laneModels?.(),
		);
		const model = splitModelThinking(worker.model);
		if (!isAbsolute(input.cwd)) throw new LaneInputError(`프로젝트 경로는 절대경로여야 합니다: ${input.cwd}`);
		let cwd: string;
		try {
			cwd = realpathSync(input.cwd);
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new LaneInputError(`프로젝트 경로가 디렉터리가 아니거나 없습니다: ${input.cwd}`);
		}
		// Both checks run before the first await: a concurrent start of the same key sees the registration.
		if (input.reuseOpen === true && input.parentOrigin !== undefined) {
			const open = store
				.listLanes()
				.find(
					(row) =>
						row.status !== "closed" &&
						row.meta.parentOrigin === input.parentOrigin &&
						row.title === title &&
						row.meta.requestedCwd === cwd,
				);
			if (open !== undefined) {
				log.info("lane_start_reused", { lane: open.name, parentOrigin: input.parentOrigin });
				return {
					...open,
					reused: true,
					startNote: `이미 같은 요청의 레인이 열려 있어 새로 만들지 않았습니다: ${open.name}`,
				};
			}
		}
		// A start without a conversation (no `parentOrigin`) has nothing to be the same request of: its key is its own.
		const startKey = `${input.parentOrigin ?? crypto.randomUUID()}\0${title}\0${cwd}`;
		if (this.#startingKeys.has(startKey)) throw new LaneInputError("같은 레인을 시작하는 중입니다");
		this.#startingKeys.add(startKey);
		const borrowed = claimBorrowedThread(input, this.#borrowingThreads, this.#deps.store);
		try {
			const found = await resolveLaneRepo(cwd);
			if (!found.ok) throw new LaneInputError(found.problem);
			const { repo, baseBranch, sub } = found.value;
			const disks = [diskHeadroom(repo, this.#deps.statfs)];
			const capacity = startCapacity(this.#deps.hostLoad, disks, this.#deps.hostSessions);
			const quotaHold = this.#deps.quotaRefusal?.(model?.model);
			const refusals = quotaHold === undefined ? capacity.refusals : [...capacity.refusals, quotaHold];
			if (refusals.length > 0 && input.force !== true) {
				log.warn("lane_start_refused_capacity", { channel: input.channel, repo, refusals: [...refusals] });
				throw new LaneInputError(`시작 거부: ${refusals.join(", ")}`);
			}
			if (refusals.length > 0) log.info("lane_start_forced", { channel: input.channel, repo });
			const branchIds = await laneIdsOnBranches(repo);
			if (store.countOpenLanes() + this.#starting >= this.#max) throw new LaneCapError(this.#max);
			// No await between picking the id and reserving it: a concurrent start sees the reservation.
			const rowIds = laneRowIdsReportingOrphans(store, repo, branchIds, log);
			const laneId = nextLaneId(
				localDay(clock.now(), this.#deps.timezone),
				(id) =>
					rowIds.has(id) || branchIds.has(id) || this.#reservedLaneIds.has(id) || existsSync(worktreePathOf(repo, id)),
				this.#deps.idStart?.() ?? 1,
			);
			const worktree = worktreePathOf(repo, laneId);
			const branch = laneBranchOf(laneId);
			// Root and status are mrkdwn: the model's title must not mention anyone (`<!channel>` stays text).
			const shown = escapeMrkdwn(title);
			this.#starting += 1;
			this.#reservedLaneIds.add(laneId);
			let created = false;
			let reservedName: string | undefined;
			// Set once the root is up: a later failure turns it into ❌ so no 🔄 root is left behind.
			let rootRef: MessageRef | undefined;
			let threadOpened = false;
			let statusRef: MessageRef | undefined;
			let lane: LaneRow | undefined;
			let externalPr: LaneExternalPr | undefined;
			try {
				if (externalPrInput !== undefined) {
					const resolved = await resolveExternalPr(
						externalPrInput,
						{ repoDir: repo, baseBranch, title, laneId },
						(this.#deps.prTools ?? defaultPrTools).git,
					);
					if (!resolved.ok) throw new LaneInputError(resolved.problem);
					externalPr = resolved.value;
				}
				const made = await this.#ops.createWorktree({ repo, worktree, branch });
				if (!made.ok) throw new LaneInputError(`레인 worktree를 만들지 못했습니다: ${made.error}`);
				created = true;
				const baseSha = await resolveBaseSha(worktree);
				if (baseSha === undefined) throw new Error(`cannot read HEAD of the new worktree ${worktree}`);
				const laneCwd = sub === "" ? worktree : join(worktree, sub);
				// An untracked sub directory of the repository is not in the worktree; an empty one changes no git status.
				mkdirSync(laneCwd, { recursive: true });
				const port = channels.portFor(input.channel);
				// A borrowed thread is the conversation itself: no root, no new thread; its first message is the owner's.
				let threadId: string;
				if (borrowed !== undefined) threadId = borrowed.threadId;
				else {
					const root = await port.post({ conversationId: input.channel }, { text: `🔄 ${shown}` });
					rootRef = { platform: port.platform, conversationId: input.channel, messageId: root.messageId };
					// Discord: the lane thread is started from the root (its id is the root's), so the status goes inside it.
					if (port.openThread !== undefined) {
						await port.openThread(rootRef, title);
						threadOpened = true;
					}
					threadId = root.messageId;
				}
				// No await between picking the name and reserving it (like the lane id above).
				const name = this.#uniqueName(slugify(title));
				this.#reservedNames.add(name);
				reservedName = name;
				// The status message carries the ⏸ button from the very first draw; `#sync` keeps it on every edit.
				const status = await port.post(
					{ conversationId: input.channel, threadId },
					{ text: `⏳ ${shown} · ${formatElapsed(0)}`, buttons: [pauseButton(name)] },
				);
				statusRef = { platform: port.platform, conversationId: input.channel, messageId: status.messageId, threadId };
				const originKey = laneOriginKey(name);
				const now = clock.now();
				lane = store.insertLane({
					name,
					title,
					threadRef: threadRefOf(input.channel, threadId),
					originKey,
					cwd: laneCwd,
					sessionDir: this.#deps.sessionDirFor(originKey),
					meta: {
						statusTs: status.messageId,
						startedAt: now,
						lastProgressAt: now,
						...(borrowed === undefined ? { renderedRoot: `🔄 ${shown}` } : { borrowedThread: true }),
						renderedStatus: `⏳ ${shown} · ${formatElapsed(0)}`,
						steerSeq: 0,
						baseSha,
						laneId,
						...(input.parentOrigin === undefined ? {} : { parentOrigin: input.parentOrigin }),
						requestedCwd: cwd,
						repo,
						worktree,
						branch,
						baseBranch,
						// A lane nobody rated (and no keyword raised) keeps no risk: it counts as DEFAULT_LANE_RISK, and the
						// confident band (`taskAutoLand.review.confident`) is for explicit risks only.
						...(input.risk === undefined && floored.risk === risk ? {} : { risk: floored.risk }),
						tier: worker.tier,
						tierReason: worker.tierReason,
						...(tierConfidence === undefined ? {} : { tierConfidence }),
						...(worker.model === null ? {} : { workerModel: worker.model }),
						acceptance,
						...(scope.length === 0 ? {} : { scope }),
						...(brief === "" ? {} : { brief }),
						...(externalPr === undefined ? {} : { externalPr }),
						...(workflow === undefined ? {} : { workflow }),
					},
				});
				if (model !== undefined) {
					store.ensureOrigin(lane.originKey, lane.sessionDir);
					store.setOriginSettings(lane.originKey, model);
				}
				log.info("lane_started", {
					lane: lane.name,
					origin: lane.originKey,
					cwd: lane.cwd,
					branch,
					model: model?.model,
					tier: worker.tier,
				});
				if (floored.note !== undefined)
					log.info("lane_risk_floor_raised", { lane: lane.name, from: risk, to: floored.risk });
				this.#send(
					lane.name,
					"start",
					buildLanePrompt({
						name: lane.name,
						title,
						cwd: lane.cwd,
						brief: input.brief,
						branch,
						baseBranch,
						acceptance,
						externalPr,
						workflow,
						sameRepoLanes: await openLanesOfRepo(store.listLanes(), lane.name, repo, this.#matcher),
					}) + planLocations(input.brief, this.#deps.recordsRepo?.()),
				);
			} catch (error) {
				if (lane !== undefined) {
					await this.failLaunch(lane.originKey, cutCodePointSafe(oneLine(String(error)), 200)).catch(() => undefined);
					throw error;
				}
				// The borrowed thread is the conversation: its status (when it was posted) says ❌, nothing is archived.
				if (borrowed !== undefined && statusRef !== undefined)
					await failBorrowedStatus(channels.portFor(statusRef.conversationId), log, statusRef, shown);
				// The root stays in the channel and says the lane never started.
				if (rootRef !== undefined) {
					await channels
						.portFor(input.channel)
						.edit(rootRef, { text: `❌ ${shown}` })
						.catch((editError: unknown) =>
							log.warn("lane_root_edit_failed", { channel: input.channel, error: String(editError) }),
						);
					if (threadOpened) await this.#archiveThreadOf(rootRef, "start");
				}
				// A refused or failed start leaves no worktree and no branch behind.
				if (created) await this.#ops.removeWorktree({ repo, worktree, branch });
				throw error;
			} finally {
				this.#starting -= 1;
				this.#reservedLaneIds.delete(laneId);
				if (reservedName !== undefined) this.#reservedNames.delete(reservedName);
			}
			if (briefCut) log.warn("lane_brief_cut", { lane: lane.name, chars: fullBrief.length, kept: MAX_BRIEF_CHARS });
			const notes = [
				...(floored.note === undefined ? [] : [floored.note]),
				...(worker.note === undefined ? [] : [worker.note]),
				...(capacity.warning === undefined ? [] : [capacity.warning]),
				...(briefCut
					? [
							`브리프 ${fullBrief.length}자 중 앞 ${MAX_BRIEF_CHARS}자만 독립 리뷰에 남겼습니다. 긴 스펙은 파일로 두고 브리프에는 경로를 적으세요.`,
						]
					: []),
			];
			return notes.length === 0 ? lane : { ...lane, startNote: notes.join("\n") };
		} finally {
			this.#startingKeys.delete(startKey);
			if (borrowed !== undefined) this.#borrowingThreads.delete(borrowed.threadRef);
		}
	}

	#uniqueName(base: string): string {
		let name = base;
		for (let n = 2; this.#deps.store.getLane(name) || this.#reservedNames.has(name); n += 1) name = `${base}-${n}`;
		return name;
	}

	/**
	 * Feeds a core-authored message (first prompt, not-done reasons) into the lane's mailbox; most callers do not await
	 * it. Resolves true once the mailbox took the message, false when it was held or the route failed (logged).
	 */
	#send(name: string, kind: string, text: string): Promise<boolean> {
		const lane = this.#deps.store.getLane(name);
		if (!lane) return Promise.resolve(false);
		// Held: nothing is steered into a paused lane (the resume word goes after the transition back).
		if (lane.status === "paused") {
			this.#deps.log.warn("lane_send_held_paused", { lane: name, kind });
			return Promise.resolve(false);
		}
		const seq = lane.meta.steerSeq + 1;
		this.#deps.store.patchLane(name, undefined, { steerSeq: seq });
		return this.#deps
			.route({
				platformMessageId: `lane:${name}:${kind}:${seq}`,
				originKey: lane.originKey,
				ownerVerified: true,
				text,
				threadRef: lane.threadRef,
			})
			.then(
				() => true,
				(error: unknown) => {
					this.#deps.log.error("lane_send_failed", { lane: name, kind, error: String(error) });
					return false;
				},
			);
	}

	/**
	 * The owner wrote in the lane's thread. On a closed lane only `!reopen` reopens it (same recorded session, root 🔄
	 * again); a question is answered by the lane session while the lane stays closed — an answer-only turn makes no
	 * commit, so a reopened lane could never leave `working` again — and a control command (`!model`, `!new`…) is
	 * neither. A pending claim is answered by the message, so it no longer auto-closes.
	 */
	onOwnerMessage(lane: LaneRow, text = ""): void {
		const { store, clock } = this.#deps;
		if (lane.meta.ownerQuestion !== undefined) store.patchLane(lane.name, undefined, { ownerQuestion: undefined });
		const closedAs = lane.status === "closed" ? classifyClosedLaneMessage(text, lane.meta.land?.state) : undefined;
		// `머지해`/`폐기해` are settled by the caller (`requestLand`, `discard`), and a lane whose worktree is gone
		// (`reopenRefusal`) cannot be reopened: neither changes the lane here.
		if (closedAs === "land" || closedAs === "discard" || closedAs === "pr") return;
		if (closedAs === "question") {
			store.patchLane(lane.name, { event: "owner_question" }, {});
		} else if (closedAs === "reopen") {
			if (this.reopenRefusal(lane) !== undefined) return;
			const now = clock.now();
			const reopened = store.transitionLane(
				lane.name,
				"working",
				{ event: "reopened" },
				{
					startedAt: now,
					lastProgressAt: now,
					milestone: undefined,
					milestoneEvidence: undefined,
					claim: undefined,
					integrityApproval: undefined,
					sha: undefined,
					baseSha: lane.meta.sha ?? lane.meta.baseSha,
					land: undefined,
					// Only a PR that exists is kept: the next close asks `PR 갱신` for the same PR.
					pr: lane.meta.pr?.url === undefined ? undefined : { ...lane.meta.pr, state: "published", reason: undefined },
					review: undefined,
					qa: undefined,
					changes: undefined,
					scopeViolations: undefined,
					scopeError: undefined,
					leftovers: undefined,
				},
			);
			this.#deps.log.info("lane_reopened", { lane: lane.name });
			// A running QA stops; its receipt would not be written anyway (the lane has no claim commit now).
			void this.#stopQa(lane.name);
			this.#dropReviewFiles(reopened);
			void this.#sync(reopened, "transition");
			const cardTs = lane.meta.land?.cardTs;
			if (cardTs !== undefined) {
				this.#spawn(lane.name, () =>
					this.#editCard(reopened, cardTs, { kind: "rework", reason: "오너가 레인을 다시 열었습니다." }),
				);
			}
		} else if (lane.status === "done-claimed") {
			store.transitionLane(lane.name, "working", { event: "owner_reply" }, { claim: undefined });
		}
	}

	/**
	 * The owner stops this one lane (`멈춰` in the thread or the ⏸ button). The registry goes to `paused` first —
	 * everything downstream (steers, verdicts, the mailbox's dispatch hold) reads the row, so a restart keeps it —
	 * then the running turn is aborted. The answer is written only from state re-read after the stop: registry
	 * `paused`, no turn, the driver settled; anything still off is named, and the owner asking again retries the stop.
	 */
	async pause(name: string, by: "owner-message" | "button"): Promise<LaneRequestOutcome> {
		const { store, clock, log } = this.#deps;
		const lane = store.getLane(name);
		if (lane === undefined) return { handled: false, text: `레인을 찾지 못했습니다: ${name}` };
		// A closed lane has no turn to stop: only its auto-merge is held; `머지해` and the buttons keep working.
		if (lane.status === "closed") {
			const land = lane.meta.land;
			if (land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
				return { handled: false, text: "이 레인은 이미 완료(closed)되어 멈출 턴이 없습니다." };
			}
			if (this.#landing.has(name)) {
				return { handled: false, text: "머지가 이미 진행 중이라 보류하지 못했습니다." };
			}
			// An auto-merge that already began and waits for the lane's turn is withdrawn with it: the card asks again.
			const withdrawn = land.requestedBy === "auto";
			if (land.autoLandHeld === undefined || withdrawn) {
				const held = this.#patchLand(
					name,
					{ autoLandHeld: land.autoLandHeld ?? OWNER_PAUSE_HELD, ...(withdrawn ? { requestedBy: undefined } : {}) },
					{ event: "auto_land_held", detail: OWNER_PAUSE_HELD },
				);
				const cardTs = held.meta.land?.cardTs;
				if (withdrawn && cardTs !== undefined) {
					await this.#editCard(held, cardTs, {
						kind: "ask",
						ownerUserId: this.#ownerOf(held),
						skipped: [OWNER_PAUSE_HELD],
					});
				}
			}
			return {
				handled: true,
				text: "⏸ 레인이 이미 완료되어 멈출 턴이 없습니다. 자동 머지만 보류합니다 — `머지해`·`머지` 버튼은 계속 동작합니다.",
			};
		}
		if (lane.status !== "paused") {
			const paused = store.transitionLane(
				name,
				"paused",
				{ event: "paused", detail: by },
				{ pausedFrom: lane.status, pausedAt: clock.now(), pausedBy: by },
			);
			log.info("lane_paused", { lane: name, from: lane.status, by });
			await this.#sync(paused, "transition");
		}
		// An owner asking again retries the stop itself: a first abort may not have taken.
		const check = await this.#deps.pauseTurn(lane.originKey);
		const wrong: string[] = [];
		if (store.getLane(name)?.status !== "paused") wrong.push("레인 paused 아님");
		if (check.busy) wrong.push("턴이 아직 있음");
		if (!check.settled) wrong.push("omp settled 아님");
		if (wrong.length > 0) {
			log.warn("lane_pause_unconfirmed", { lane: name, wrong: wrong.join(",") });
			return {
				handled: true,
				text: `⚠️ 멈추지 못했습니다: ${wrong.join(" · ")} — 레인은 paused로 두었습니다. 다시 말하면 다시 끊습니다.`,
			};
		}
		return { handled: true, text: "⏸ 멈췄습니다 (확인: 레인 paused · 턴 없음 · omp settled)" };
	}

	/**
	 * The owner gives the lane back (`계속` or the ▶ button) — the only path out of `paused`. The lane returns to
	 * where it was (`not-done` as `working`), a resumed claim gets its grace anew, what piled up while held is
	 * dispatched now, and the answer rests only on the re-read registry.
	 */
	async resume(name: string, by: "owner-message" | "button" | "attach"): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		if (lane?.status !== "paused") {
			return { handled: false, text: `멈춘 레인이 아닙니다 (${lane?.status ?? "레인 없음"}).` };
		}
		// A terminal omp writes the session now: a child started beside it would tangle the file.
		if (lane.meta.attach !== undefined) {
			return {
				handled: false,
				text: `터미널 omp가 이 레인 세션을 쓰는 중입니다 (pid ${lane.meta.attach.pid}) — 터미널을 끝내면 돌아옵니다.`,
			};
		}
		// An owner message held under the pause answers a pending claim exactly like one sent while it was pending
		// (`onOwnerMessage`): the lane comes back working and the claim no longer closes it.
		const answered = store
			.listInbound({ originKey: lane.originKey, state: "pending" })
			.some((row) => !isCoreSteerId(row.platformMessageId));
		const back: LaneStatus = lane.meta.pausedFrom === "done-claimed" && !answered ? "done-claimed" : "working";
		const patch: Partial<LaneMeta> = {
			pausedFrom: undefined,
			pausedAt: undefined,
			pausedBy: undefined,
			sessionChoices: undefined,
		};
		// The time held by a pause is not the owner's silence: the question's window starts again at the resume.
		const asked = lane.meta.ownerQuestion;
		if (asked && asked.fallbackAt === undefined) patch.ownerQuestion = { ...asked, askedAt: this.#deps.clock.now() };
		if (back === "done-claimed" && lane.meta.claim !== undefined) {
			const claimedAt = this.#claimStamp(lane);
			patch.claim = { ...lane.meta.claim, claimedAt };
			patch.lastClaimedAt = claimedAt;
		} else if (lane.meta.pausedFrom === "done-claimed") {
			patch.claim = undefined;
		}
		const resumed = store.transitionLane(name, back, { event: "resumed", detail: by }, patch);
		log.info("lane_resumed", { lane: name, to: back, by });
		await this.#sync(resumed, "transition");
		await this.#deps.resumePending(lane.originKey);
		// The resume word itself follows the held messages; a freeze holds it like any other steer. A terminal hand-back
		// sends none: the owner's terminal turns are already in the session, and the next message starts the next turn.
		// Neither does a pending claim: the lane said it was done, and a nudge there would start a turn the verdict
		// does not need.
		const frozen = this.#deps.frozen?.() !== undefined;
		if (frozen) log.warn("lane_send_held_frozen", { lane: name });
		else if (by !== "attach" && back !== "done-claimed") {
			this.#send(name, "resume", "[jabbu] 오너가 재개했습니다. 멈추기 전 작업을 이어 하세요.");
		}
		if (store.getLane(name)?.status === "paused") {
			return { handled: true, text: "⚠️ 재개하지 못했습니다: 레인이 여전히 paused입니다." };
		}
		return {
			handled: true,
			text: `▶ 재개했습니다${frozen ? " — 동결 중이라 재개 안내는 보내지 않았습니다. 동결이 풀린 뒤 이 스레드에 지시를 쓰세요" : ""}`,
		};
	}

	/**
	 * `jabbu-pocket lanes attach`: hands the lane's session to a terminal omp. The file is read first — the one the running
	 * child has open, else the one the next child would resume — then the lane is held (`paused`, registry `attach`, so no
	 * child starts and thread messages wait), its turn is aborted (`wait`: awaited instead) and the child stopped. The
	 * caller resumes exactly that file; `detach` (or the orphan check of `tick`) gives the lane back.
	 */
	async attach(name: string, request: { pid: number; wait: boolean; keepPaused: boolean }): Promise<LaneAttachOutcome> {
		const { store, clock, log, session } = this.#deps;
		const lane = store.getLane(name);
		if (lane === undefined) return { ok: false, error: `no lane named ${name}` };
		if (lane.status === "closed") return { ok: false, error: `lane ${name} is closed; nothing runs to hand over` };
		if (lane.meta.attach !== undefined || this.#attaching.has(name)) {
			return { ok: false, error: `lane ${name} is already attached (pid ${lane.meta.attach?.pid ?? "?"})` };
		}
		// Marked before the first await: a second attach arriving meanwhile is refused by the check above.
		this.#attaching.add(name);
		try {
			const origin = store.getOrigin(lane.originKey);
			const sessionFile =
				(await session.openFile(lane.originKey)) ?? (origin === undefined ? undefined : sessionToResume(origin));
			if (sessionFile === undefined) return { ok: false, error: `lane ${name} has no session file yet` };
			const head = await headOf(this.#deps.changesGit ?? defaultGit, lane.cwd);
			const now = clock.now();
			const attach: LaneAttach = {
				pid: request.pid,
				at: now,
				sessionFile,
				size: fileSize(sessionFile),
				...(head === undefined ? {} : { head }),
				wasPaused: lane.status === "paused",
				keepPaused: request.keepPaused,
			};
			// Held before the child stops: a message arriving in between waits, and no child starts for a command.
			const held =
				lane.status === "paused"
					? store.patchLane(
							name,
							{ event: "attached", detail: String(request.pid) },
							{ attach, sessionChoices: undefined },
						)
					: store.transitionLane(
							name,
							"paused",
							{ event: "attached", detail: String(request.pid) },
							{ pausedFrom: lane.status, pausedAt: now, pausedBy: "attach", attach, sessionChoices: undefined },
						);
			if (request.wait) await session.whenTurnEnds(lane.originKey);
			else await this.#deps.pauseTurn(lane.originKey);
			await session.release(lane.originKey);
			if (session.childRunning(lane.originKey)) {
				log.warn("lane_attach_child_running", { lane: name });
				return {
					ok: false,
					error: `lane ${name}'s omp child did not stop; the core takes the lane back within a minute`,
				};
			}
			// What the stopped turn still wrote belongs to the lane, not to the terminal's summary.
			store.patchLane(name, undefined, { attach: { ...attach, size: fileSize(sessionFile) } });
			log.info("lane_attached", { lane: name, pid: request.pid, wait: request.wait, file: sessionFile });
			await this.#sync(store.getLane(name) ?? held, "transition");
			await this.#postInThread(
				held,
				"🖥 오너가 터미널 omp에서 이 레인을 넘겨받았습니다 — 이 스레드 메시지는 터미널을 끝낸 뒤 전달합니다.",
			);
			return { ok: true, sessionFile, cwd: lane.cwd, sessionDir: lane.sessionDir };
		} finally {
			this.#attaching.delete(name);
		}
	}

	/**
	 * The terminal omp ended (`by: "cli"`) or its `jabbu-pocket lanes attach` process is gone (`"orphan"`): the attached file is
	 * pinned as the file the next child resumes — no new epoch, no child started here (the next message starts it
	 * through the mailbox) — and the lane is resumed unless it was paused before, `--keep-paused` was given, or the
	 * terminal left new session files (`newFiles`, listed by the CLI): then it stays paused and the owner picks the file.
	 */
	async detach(
		name: string,
		request: { sessionFile: string; newFiles: readonly string[]; by: "cli" | "orphan" },
	): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const attach = lane?.meta.attach;
		if (lane === undefined || attach === undefined) return { handled: false, text: `lane ${name} is not attached` };
		if (this.#attaching.has(name)) return { handled: false, text: `lane ${name} is still being handed over` };
		if (request.sessionFile !== attach.sessionFile) {
			return {
				handled: false,
				text: `lane ${name} was handed over as ${attach.sessionFile}, not ${request.sessionFile}`,
			};
		}
		store.pinSessionFile(lane.originKey, attach.sessionFile);
		const newFiles = request.newFiles.filter((file) => file !== attach.sessionFile);
		const stay = newFiles.length > 0 || attach.keepPaused || attach.wasPaused;
		const choices =
			newFiles.length > 0
				? { files: [attach.sessionFile, ...newFiles], resume: !attach.keepPaused && !attach.wasPaused }
				: undefined;
		const back = store.patchLane(
			name,
			{ event: "detached", detail: request.by },
			{ attach: undefined, ...(choices === undefined ? {} : { sessionChoices: choices }) },
		);
		log.info("lane_detached", { lane: name, by: request.by, newFiles: newFiles.length, stay });
		const delta = sessionDelta(attach.sessionFile, attach.size);
		const changed = await changedFilesSince(this.#deps.changesGit ?? defaultGit, lane.cwd, attach.head);
		let cost: { usd: number; calls: number } | undefined;
		try {
			const totals = await laneCost(lane);
			cost = { usd: totals.costTotal, calls: totals.calls };
		} catch (error) {
			log.warn("lane_cost_failed", { lane: name, error: String(error) });
		}
		const summary = detachSummary(delta.turns, changed, delta.costUsd, request.by === "orphan", cost);
		if (choices !== undefined) {
			await this.#sync(back, "transition");
			const buttons = choices.files.map((_file, index) => ({
				actionId: laneSessionActionId(name, index),
				label: index === 0 ? "원래 파일" : `새 파일 ${index}`,
				value: name,
			}));
			const list = choices.files
				.map((file, index) => `${index === 0 ? "원래" : `새 ${index}`}: \`${file}\``)
				.join("\n");
			await this.#postInThreadWith(back, {
				text: `${summary}\n터미널에서 새 세션 파일이 생겼습니다. 레인은 멈춘 채 원래 파일에 고정했습니다 — 이어 쓸 파일을 고르세요.\n${list}`,
				buttons,
			});
			return { handled: true, text: summary };
		}
		if (stay) {
			await this.#sync(back, "transition");
			await this.#postInThread(back, `${summary}\n레인은 멈춘 채로 두었습니다 — \`계속\`이나 ▶ 재개로 다시 맡깁니다.`);
			return { handled: true, text: summary };
		}
		const resumed = await this.resume(name, "attach");
		await this.#postInThread(back, `${summary}\n${resumed.text} — 다음 메시지부터 같은 세션 파일을 이어 씁니다.`);
		return { handled: true, text: summary };
	}

	/** The owner picked the session file a lane continues after a terminal hand-back that left new files. */
	async pickSession(name: string, index: number): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const choices = lane?.meta.sessionChoices;
		const file = choices?.files[index];
		if (lane === undefined || choices === undefined || file === undefined) {
			return { handled: false, text: "고를 세션 파일이 없습니다 (이미 골랐거나 재개됨)." };
		}
		store.pinSessionFile(lane.originKey, file);
		store.patchLane(name, { event: "session_picked", detail: file }, { sessionChoices: undefined });
		log.info("lane_session_picked", { lane: name, file });
		if (!choices.resume)
			return { handled: true, text: `이어 쓸 파일을 \`${file}\`로 정했습니다 — 레인은 멈춘 채입니다.` };
		const resumed = await this.resume(name, "attach");
		return { handled: true, text: `이어 쓸 파일을 \`${file}\`로 정했습니다. ${resumed.text}` };
	}

	/**
	 * The mailbox reports a held lane's driver working on its own (a queued message omp started without a turn).
	 * The thread is warned once per pause (`pausedAt` is the key, so a restart stays quiet too) and the stop is
	 * retried once more.
	 */
	onHeldWork(originKey: string): void {
		const { store, clock, log } = this.#deps;
		const lane = store.getLaneByOrigin(originKey);
		if (lane?.status !== "paused") return;
		const key = `lane_paused_work:${lane.name}:${lane.meta.pausedAt ?? 0}`;
		const warned = store.getCursor(key) !== undefined;
		if (!warned) store.setCursor(key, String(clock.now()));
		log.warn("lane_paused_working", { lane: lane.name, warned });
		this.#spawn(lane.name, async () => {
			if (!warned) await this.#postInThread(lane, "⚠️ 멈춘 레인이 다시 작업을 시작했습니다 — 다시 멈췄습니다");
			await this.pause(lane.name, "owner-message");
		});
	}

	/** The task list a fresh session of the lane starts with (its acceptance criteria, then the wrap-up). */
	initialTodos(originKey: string): TodoPhase[] | undefined {
		const lane = this.#deps.store.getLaneByOrigin(originKey);
		return lane === undefined ? undefined : buildLaneTodos(lane.meta.acceptance ?? []);
	}

	/**
	 * Why a lane's first prompt must not be sent: the model its tier chose (the origin's setting) is not in omp's model
	 * list or the list could not be read, or the ULW workflow its head chose is not loaded in this omp (or the
	 * command list could not be read). `undefined` = send it. A chosen `jevify` (omp's own notice) is not checked.
	 * Later turns and conversation sessions keep the old behavior: a model omp lacks is logged and the default runs.
	 */
	async launchRefusal(
		originKey: string,
		driver: Pick<OmpSessionDriver, "availableCommands" | "availableModels">,
	): Promise<string | undefined> {
		const model = this.#deps.store.getOrigin(originKey)?.model;
		if (model !== null && model !== undefined) {
			try {
				if (!(await driver.availableModels()).includes(model)) {
					return `레인 모델 \`${model}\`이 레인 omp의 모델 목록에 없습니다`;
				}
			} catch (error) {
				return `레인 모델 \`${model}\`을 확인하지 못했습니다: ${cutCodePointSafe(oneLine(String(error)), 200)}`;
			}
		}
		const workflow = this.#deps.store.getLaneByOrigin(originKey)?.meta.workflow;
		if (workflow === undefined || !isUlwWorkflow(workflow.name)) return undefined;
		try {
			if (advertisedWorkflow(await driver.availableCommands(), workflow.name)) return undefined;
		} catch (error) {
			return `워크플로 \`${workflow.name}\` 명령을 확인하지 못했습니다: ${cutCodePointSafe(oneLine(String(error)), 200)}`;
		}
		return `워크플로 \`${workflow.name}\` 명령이 레인 omp에 로드되어 있지 않습니다`;
	}

	/**
	 * The first prompt was refused (`launchRefusal`) and its child stopped: the lane closes as failed — ❌ root, the
	 * reason in the thread, its worktree and branch removed. The registry has no direct working → closed edge, so the
	 * row goes through `done-claimed` with the failure on both history entries; no claim, review or landing follows.
	 */
	async failLaunch(originKey: string, reason: string): Promise<void> {
		const { store, log } = this.#deps;
		const lane = store.getLaneByOrigin(originKey);
		if (lane === undefined || lane.status !== "working") return;
		const { repo, worktree, branch } = lane.meta;
		if (repo !== undefined && worktree !== undefined && branch !== undefined) {
			await this.#removeLaneWorktree(lane.name, { repo, worktree, branch });
		}
		store.transitionLane(lane.name, "done-claimed", { event: "launch_failed", detail: reason });
		const closed = store.transitionLane(
			lane.name,
			"closed",
			{ event: "closed", detail: `시작 실패: ${reason}` },
			{ launchFailed: reason, land: { state: "discarded", attempts: 0, reason } },
		);
		log.warn("lane_launch_failed", { lane: lane.name, reason });
		await this.#postInThread(
			closed,
			`❌ 레인을 시작하지 못했습니다: ${reason}. 첫 프롬프트를 보내지 않았고 worktree와 브랜치를 지웠습니다.`,
		);
		const synced = await this.#sync(closed, "transition");
		// Archive only a thread whose ❌ root and status were drawn: a failed edit would be retried inside an archived thread.
		// A borrowed thread is the conversation the lane started from: it stays open.
		const parsed = parseThreadRef(synced.threadRef);
		if (parsed !== undefined && synced.meta.borrowedThread !== true && closedDrawn(synced)) {
			const platform = this.#deps.channels.portFor(parsed.channel).platform;
			await this.#archiveThreadOf({ platform, conversationId: parsed.channel, messageId: parsed.threadTs }, lane.name);
		}
	}

	/** Archives the thread started from `ref` where the platform has such a state; a failure is logged, never thrown. */
	async #archiveThreadOf(ref: MessageRef, lane: string): Promise<void> {
		const { channels, log } = this.#deps;
		try {
			const port = channels.portFor(ref.conversationId);
			await port.archiveThread?.(ref);
		} catch (error) {
			log.warn("lane_thread_archive_failed", { lane, error: String(error) });
		}
	}

	/** A message with buttons in the lane's thread; a failure is logged, never thrown. */
	async #postInThreadWith(lane: LaneRow, message: { text: string; buttons: readonly ActionButton[] }): Promise<void> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		try {
			await route.port.post(route.target, message);
		} catch (error) {
			this.#deps.log.warn("lane_thread_post_failed", { lane: lane.name, error: String(error) });
		}
	}

	/** One plain line in the lane's thread (warnings); a failure is logged, never thrown. */
	/**
	 * The one way a lane's worktree goes (landing, discard, a refused launch, a merge made outside): its recorded file
	 * evidence is kept first (`#preserveArtifacts`), then the worktree and branch are removed.
	 */
	async #removeLaneWorktree(name: string, input: { repo: string; worktree: string; branch: string }): Promise<void> {
		await this.#preserveArtifacts(name, input.worktree);
		await this.#ops.removeWorktree(input);
	}

	/**
	 * Copies the lane's recorded file evidence to `<artifactsDir>/<lane>/artifacts/<sha256>` before its worktree is
	 * removed. A file that changed is a warning in the lane's history (`artifact_drift`), a copy that failed too
	 * (`artifact_copy_failed`); neither stops the removal — nothing would ever clean the worktree up again. Never throws.
	 */
	async #preserveArtifacts(name: string, worktree: string): Promise<void> {
		const { store, log, lanesDir } = this.#deps;
		const lane = store.getLane(name);
		const files = lane?.meta.evidence?.filter((entry) => "file" in entry) ?? [];
		if (lane === undefined || lanesDir === undefined || files.length === 0) return;
		try {
			const kept = await preserveFileEvidence(worktree, join(lanesDir, name, "artifacts"), lane.meta.evidence ?? []);
			for (const problem of kept.problems) {
				log.warn(problem.event, { lane: name, detail: problem.detail });
				store.patchLane(name, { event: problem.event, detail: problem.detail }, {});
			}
			store.patchLane(name, undefined, { evidence: kept.evidence });
		} catch (error) {
			log.warn("artifact_copy_failed", { lane: name, error: String(error) });
			store.patchLane(name, { event: "artifact_copy_failed", detail: String(error) }, {});
		}
	}

	async #postInThread(lane: LaneRow, text: string): Promise<void> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		try {
			await route.port.post(route.target, { text });
		} catch (error) {
			this.#deps.log.warn("lane_thread_post_failed", { lane: lane.name, error: String(error) });
		}
	}

	/**
	 * Milestone report from the lane (`jabbu_lane_progress`): recorded and shown in the status message at once. It
	 * needs evidence: a regular file inside the lane's worktree or a tool call the lane session finished, whose sha256
	 * the core records with the milestone. A
	 * report that asks the owner to decide (`needsOwner`) is a question, not a claim, and is taken without evidence
	 * (a valid file is still recorded). Without usable evidence nothing is recorded.
	 */
	async progress(originKey: string, text: string, options: LaneProgressOptions = {}): Promise<string> {
		const lane = this.#requireLane(originKey);
		if (lane.status === "closed") return `lane ${lane.name} ${CLOSED_LANE_REPLY}`;
		if (lane.status === "paused") return `lane ${lane.name} ${PAUSED_LANE_REPLY}`;
		const needsOwner = options.needsOwner === true;
		const milestone = cutCodePointSafe(redact(text.replace(/\s+/g, " ").trim()), MAX_MILESTONE_CHARS);
		if (milestone === "") throw new Error("text is required");
		const origin = this.#deps.store.getOrigin(lane.originKey);
		const sessionFile =
			(await this.#deps.session.openFile(lane.originKey)) ??
			(origin === undefined ? undefined : sessionToResume(origin));
		const evidence = await verifyProgressEvidence(lane.meta.worktree ?? lane.cwd, options.evidence, sessionFile);
		if (!evidence.ok && !needsOwner) return `progress not recorded: ${evidence.reason}`;
		const recorded = evidence.ok
			? [...(lane.meta.evidence ?? []), evidence.value].slice(-MAX_LANE_EVIDENCE)
			: lane.meta.evidence;
		const ownerQuestion = ownerQuestionOf(options, this.#deps.clock.now());
		const patched = this.#deps.store.patchLane(
			lane.name,
			{ event: needsOwner ? "needs_owner" : "progress", detail: milestone },
			{ milestone, milestoneEvidence: evidence.ok ? evidence.value : undefined, evidence: recorded, ownerQuestion },
		);
		await this.#sync(patched, "milestone");
		return "progress recorded";
	}

	/** The lane says it is done. The core decides with git, not with the lane's word. */
	async claimDone(originKey: string, evidence: ClaimEvidence & { leftovers?: unknown }): Promise<string> {
		const { store } = this.#deps;
		const lane = this.#requireLane(originKey);
		if (lane.status === "closed") return `lane ${lane.name} ${CLOSED_LANE_REPLY}`;
		if (lane.status === "paused") return `lane ${lane.name} ${PAUSED_LANE_REPLY}`;
		const { leftovers: rawLeftovers, ...claimed } = evidence;
		const leftovers = parseLaneLeftovers(rawLeftovers);
		if (!leftovers.ok) return `claim not recorded: ${leftovers.problem}`;
		const claimedAt = this.#claimStamp(lane);
		const claim = { ...claimed, claimedAt };
		const entry = { event: "claim", detail: `${evidence.repo}@${evidence.commit}: ${evidence.summary}` };
		// A new claim is judged afresh: the last close's scope result and the last claim's leftovers go with it.
		const patch = {
			claim,
			lastClaimedAt: claimedAt,
			leftovers: leftovers.value.length === 0 ? undefined : leftovers.value,
			scopeViolations: undefined,
			scopeError: undefined,
		};
		if (lane.status === "done-claimed") store.patchLane(lane.name, entry, patch);
		else store.transitionLane(lane.name, "done-claimed", entry, patch);
		return (await this.#settle(lane.name)).text;
	}

	/**
	 * Verifies the pending claim. Closed when git agrees, `not-done` with reasons when not, still pending when git cannot
	 * run. `fromTick`: the core's own deferred verdict — when a freeze began while it ran, a not-done stays pending
	 * (could not be steered now) so the first tick after unfreeze judges it again. A claim made while the lane's verdict
	 * runs is judged right after that verdict ends (not after the grace).
	 */
	async #settle(name: string, fromTick = false): Promise<SettleOutcome> {
		const { store, log } = this.#deps;
		if (this.#settling.has(name)) {
			this.#resettle.add(name);
			return { text: OVERLAP_REPLY };
		}
		const lane = store.getLane(name);
		const claim = lane?.meta.claim;
		this.#settling.add(name);
		try {
			if (lane?.status !== "done-claimed" || !claim) return { text: "no pending claim" };
			let result: VerifyResult;
			try {
				result = await (this.#deps.verify ?? verifyClaim)(claim, lane.cwd, lane.meta.baseSha, lane.meta.baseBranch);
			} catch (error) {
				log.warn("lane_verify_unavailable", { lane: name, error: String(error) });
				store.patchLane(name, { event: "verify_unavailable", detail: String(error) }, {});
				return { text: DEFERRED_REPLY };
			}
			// The owner may have answered (back to working) or the lane claimed again while git ran: that claim is void,
			// and a newer claim is judged by the `finally` below.
			const superseded = this.#claimSuperseded(lane);
			if (superseded !== undefined) return superseded;
			if (!result.ok) return this.#heldByFreeze(name, fromTick) ?? (await this.#notDone(lane, result.reasons));
			// Git proved the commit; the claim's own text and diff still have to read as finished work.
			const refusals = await this.#integrityRefusals(lane, claim, result.sha);
			// Awaited here: the `finally` must not clear `#settling` while the checks or the approval card still run.
			if (refusals.length === 0) return await this.#closeIfChecksPass(lane, result.sha, fromTick, false);
			if (approvalCovers(lane, result.sha, refusals)) {
				log.info("lane_integrity_approval_reused", { lane: name, sha: result.sha });
				return await this.#closeIfChecksPass(lane, result.sha, fromTick, true);
			}
			return await this.#refusedByIntegrity(lane, result.sha, refusals, fromTick);
		} finally {
			this.#settling.delete(name);
			if (this.#resettle.delete(name)) {
				const current = store.getLane(name);
				if (current?.status === "done-claimed" && current.meta.claim?.claimedAt !== claim?.claimedAt) {
					this.#settleInBackground(name, false);
				}
			}
		}
	}

	/** The integrity check's readers: the manager's seams plus the lane repository's commit-email policy. */
	#integrityRefusals(lane: LaneRow, claim: LaneClaim, sha: string): Promise<IntegrityRefusal[]> {
		const { log } = this.#deps;
		return integrityRefusalsOf(
			{
				...this.#deps,
				plansRoot: () => this.#deps.recordsRepo?.(),
				warn: (e, f) => log.warn(e, f),
			},
			lane,
			claim,
			sha,
		);
	}

	/**
	 * The claim reads unfinished: ask the owner (the final judge) with an approve button. Approved closes the lane
	 * anyway; denied, timed out, or no approval surface steers the remedies back as not-done.
	 */
	async #refusedByIntegrity(
		lane: LaneRow,
		sha: string,
		refusals: IntegrityRefusal[],
		fromTick: boolean,
	): Promise<SettleOutcome> {
		const { log, approvals } = this.#deps;
		const lines = refusalCardLines(refusals);
		const channel = parseThreadRef(lane.threadRef)?.channel;
		let verdict: "approved" | "denied" | "timeout" = "timeout";
		const ownerEvents = ownerEventCount(lane);
		if (approvals !== undefined && channel !== undefined) {
			try {
				verdict = await approvals.request(
					channel,
					`레인 ${lane.name} 완료 무결성 거부 — 승인하면 그대로 닫습니다.\n${lines.join("\n")}`,
				);
			} catch (error) {
				log.warn("lane_integrity_approval_failed", { lane: lane.name, error: String(error) });
			}
		}
		// An approval is kept before the claim is judged superseded or the checks run: the same verdict is not asked again.
		const { store, clock } = this.#deps;
		const approval =
			verdict === "approved"
				? approvalRecord(store.getLane(lane.name), ownerEvents, sha, refusals, clock.now())
				: undefined;
		if (approval !== undefined) store.patchLane(lane.name, undefined, { integrityApproval: approval });
		// The owner may have paused the lane, answered (back to working) or it claimed again while the card waited.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (verdict === "approved") {
			log.warn("lane_integrity_overridden", { lane: lane.name, sha, refusals: refusals.length });
			return this.#closeIfChecksPass(lane, sha, fromTick, true);
		}
		log.info("lane_integrity_refused", { lane: lane.name, categories: refusals.map((r) => r.category).join(",") });
		const held = this.#heldByFreeze(lane.name, fromTick);
		if (held !== undefined) return held;
		return this.#notDone(
			lane,
			refusals.map((r) => `${r.category}: ${r.remedy}`),
		);
	}

	/**
	 * The last gate before `closed`: the `[check: …]` signals of the lane's acceptance run in its worktree, one at a
	 * time — and one lane's checks at a time across all lanes (the check slot) — at the claimed commit only (HEAD must
	 * be it, the tree clean). A failed check is not-done; a host that
	 * cannot run them leaves the claim pending for the tick after the grace. The results are recorded per HEAD, so the
	 * same commit is never checked twice — except a timed-out (inconclusive) one, which `#inconclusive` handles: run
	 * again once after the grace, then the owner decides. Lanes without a worktree (older rows) or without checks close
	 * on git alone.
	 */
	async #closeIfChecksPass(
		lane: LaneRow,
		sha: string,
		fromTick: boolean,
		integrityApproved: boolean,
	): Promise<SettleOutcome> {
		const { store, log, clock } = this.#deps;
		const held = integrityApproved ? INTEGRITY_APPROVED : undefined;
		const worktree = lane.meta.worktree;
		const requests = worktree === undefined ? [] : taskChecksOf(lane.meta.acceptance ?? []);
		if (worktree === undefined || requests.length === 0) return this.#close(lane, sha, held);
		const reasons: string[] = [];
		let inconclusive: TaskCheck[] = [];
		let tries: LaneChecksInconclusive | undefined;
		let capped = false;
		const abort = new AbortController();
		const notClaimedHead = (head: string) =>
			`HEAD가 클레임 커밋이 아님: worktree HEAD ${head}, 클레임 ${sha} — 클레임 커밋을 HEAD로 두고 다시 주장하세요`;
		try {
			const head = await this.#ops.headOf(worktree);
			if (head.sha !== sha) {
				reasons.push(notClaimedHead(head.sha));
			} else if (!head.clean) {
				reasons.push("미커밋 변경이 있어 check를 돌리지 않았습니다 — 모두 커밋한 뒤 다시 주장하세요");
			} else {
				const known = new Map<string, SignalCheck>();
				const recorded = lane.meta.checks;
				const prior = recorded?.inconclusive;
				// The HEAD whose timed-out checks had their last run: they are not run there again.
				const cappedAt = prior !== undefined && prior.runs >= INCONCLUSIVE_RUNS_MAX ? prior.head : undefined;
				// One check run at a time across lanes; git, the integrity read and approval cards stay outside the slot.
				const free = await this.#checkSlot();
				let run: TaskChecksRun;
				try {
					// The wait may have outlived the claim, a freeze may have begun, or the core may be stopping.
					const skip = this.#stopped
						? { text: STOPPED_REPLY }
						: (this.#claimSuperseded(lane) ?? this.#heldByFreeze(lane.name, fromTick));
					if (skip !== undefined) return skip;
					this.#checkAborts.add(abort);
					run = await runWorktreeChecks(
						this.#ops,
						worktree,
						(at) => {
							if (recorded?.head === at) {
								for (const r of recorded.results) {
									if (r.inconclusive && cappedAt !== at) continue;
									known.set(r.signal, {
										signal: r.signal,
										ok: r.ok,
										detail: r.detail,
										...(r.inconclusive ? { inconclusive: true as const } : {}),
									});
								}
							}
							return known;
						},
						requests,
						abort.signal,
					);
				} finally {
					this.#checkAborts.delete(abort);
					free();
				}
				if (abort.signal.aborted) return { text: STOPPED_REPLY };
				if ("deferred" in run) {
					reasons.push(run.deferred);
				} else {
					const failed = run.results.filter((result) => !result.ok && !result.inconclusive);
					inconclusive = run.results.filter((result) => result.inconclusive === true);
					capped = cappedAt === run.head;
					if (inconclusive.length > 0) {
						tries =
							capped && prior !== undefined
								? prior
								: { head: run.head, runs: (prior?.head === run.head ? prior.runs : 0) + 1, lastAt: clock.now() };
					}
					const passed = run.results.length - failed.length - inconclusive.length;
					store.patchLane(
						lane.name,
						{
							event: "checks",
							detail: `${passed}/${run.results.length} 통과${inconclusive.length > 0 ? ` · ${inconclusive.length} 확인 불가` : ""}`,
							sha: run.head,
						},
						{
							checks: {
								head: run.head,
								results: run.results,
								...(tries === undefined ? {} : { inconclusive: tries }),
								runtime: { ...currentRuntime(), head: run.head },
							},
						},
					);
					// A commit that landed between the two HEAD reads was checked instead of the claim: the claim is unproven.
					if (run.head !== sha) reasons.push(notClaimedHead(run.head));
					for (const check of failed) {
						reasons.push(`check ${check.id} 실패: ${cutCodePointSafe(check.detail, CHECK_DETAIL_MAX)}`);
					}
				}
			}
		} catch (error) {
			// A check killed by `stop()` is no host failure: nothing is recorded.
			if (abort.signal.aborted) return { text: STOPPED_REPLY };
			log.warn("lane_checks_unavailable", { lane: lane.name, error: String(error) });
			store.patchLane(lane.name, { event: "checks_unavailable", detail: String(error) }, {});
			return { text: DEFERRED_REPLY };
		}
		// The owner may have answered (back to working) while the checks ran, and the lane may even have claimed again:
		// either way this claim is void.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (reasons.length > 0) return this.#heldByFreeze(lane.name, fromTick) ?? (await this.#notDone(lane, reasons));
		if (tries !== undefined) return this.#inconclusive(lane, sha, inconclusive, tries.runs, capped, fromTick, held);
		return this.#close(lane, sha, held);
	}

	/**
	 * Only timed-out checks stand between the claim and `closed` (no violation): nothing is steered into the lane, which
	 * has nothing to fix. After the first such judgement at a HEAD the claim stays `done-claimed` and the tick runs the
	 * timed-out checks again after `CLAIM_GRACE_MS`; after the second the owner decides once with an approve button
	 * (as for an integrity refusal) — approved closes the lane, held from auto-merge; denied, timed out, or no approval
	 * surface is not-done. A HEAD whose card was already asked (`capped`) is not-done without asking again.
	 */
	async #inconclusive(
		lane: LaneRow,
		sha: string,
		checks: TaskCheck[],
		runs: number,
		capped: boolean,
		fromTick: boolean,
		held: string | undefined,
	): Promise<SettleOutcome> {
		const { log, approvals } = this.#deps;
		const limit = `${CHECK_TIMEOUT_MS / 1000}초 초과`;
		const refused = () =>
			this.#heldByFreeze(lane.name, fromTick) ??
			this.#notDone(
				lane,
				checks.map(
					(check) =>
						`check ${check.id} ${limit} ${INCONCLUSIVE_RUNS_MAX}회 — 오너가 닫지 않음. 검사를 빠르게 할 수 있으면 고쳐 새 커밋으로 다시 주장`,
				),
			);
		if (capped) return refused();
		const ids = checks.map((check) => check.id).join(", ");
		if (runs < INCONCLUSIVE_RUNS_MAX) {
			log.info("lane_checks_inconclusive", { lane: lane.name, sha, runs, checks: ids });
			return {
				text: `재실행 검사 확인 불가(${limit}): ${ids} — 위반은 없습니다. 코어가 ${CLAIM_GRACE_MS / 60_000}분 뒤 이 검사만 다시 돌립니다(같은 커밋에서 최대 ${INCONCLUSIVE_RUNS_MAX}회).`,
			};
		}
		const channel = parseThreadRef(lane.threadRef)?.channel;
		let verdict: "approved" | "denied" | "timeout" = "timeout";
		if (approvals !== undefined && channel !== undefined) {
			try {
				verdict = await approvals.request(
					channel,
					`레인 ${lane.name} 재실행 검사 확인 불가(${limit} ${INCONCLUSIVE_RUNS_MAX}회) — 승인하면 이 검사 없이 닫습니다.\n${checks
						.map((check) => `- check ${check.id}: ${check.signal}`)
						.join("\n")}`,
				);
			} catch (error) {
				log.warn("lane_inconclusive_approval_failed", { lane: lane.name, error: String(error) });
			}
		}
		// The owner may have answered (back to working) or the lane claimed again while the card waited.
		const superseded = this.#claimSuperseded(lane);
		if (superseded !== undefined) return superseded;
		if (verdict === "approved") {
			log.warn("lane_inconclusive_approved", { lane: lane.name, sha, checks: ids });
			return this.#close(lane, sha, held ?? INCONCLUSIVE_APPROVED);
		}
		log.info("lane_inconclusive_refused", { lane: lane.name, verdict, checks: ids });
		return refused();
	}

	/**
	 * `closed`: the claim is proven (`held`: the owner let it through, `INTEGRITY_APPROVED`, `INCONCLUSIVE_APPROVED`
	 * or `OWNER_ACCEPTED`). A worktree lane now waits for its merge (`meta.land` pending): the Outcome card goes up in
	 * the background and, when `taskAutoLand` has no objection, the core lands it. A lane without a worktree (an older
	 * row) is simply done.
	 */
	async #close(
		lane: LaneRow,
		sha: string,
		held: string | undefined,
		expected: { status: "done-claimed" | "not-done"; detail?: string } = { status: "done-claimed" },
	): Promise<SettleOutcome> {
		const { repo, worktree, branch, baseBranch } = lane.meta;
		const lands = repo !== undefined && worktree !== undefined && branch !== undefined && baseBranch !== undefined;
		const before = this.#deps.store.getLane(lane.name)?.meta.land;
		const land: LaneLand = {
			state: "pending",
			// Refusals survive the trip back to `working`: the second not-ff landing goes to the owner.
			attempts: before?.attempts ?? 0,
			// So does the PR a landing sent back for a red CI left: the lane's next commits go to the same PR.
			...(before?.prLand === undefined ? {} : { mode: before.mode, prLand: before.prLand }),
			...(held === undefined ? {} : { autoLandHeld: held }),
		};
		// Every file the claim changed against `scope` (not the card's top five); a git failure holds the merge.
		const scope = lands ? await checkLaneScope(lane, sha, this.#deps.changesGit) : {};
		if (scope.scopeError !== undefined) {
			this.#deps.log.warn("lane_scope_check_failed", { lane: lane.name, error: scope.scopeError });
		}
		// The owner may have paused or answered, or the lane claimed again, while git ran.
		if (expected.status === "not-done") {
			const current = this.#deps.store.getLane(lane.name);
			if (current?.status !== "not-done") {
				return { text: `닫을 상태가 아닙니다 (${current?.status ?? "레인 없음"}).` };
			}
			if (current.meta.checks?.head !== sha || failedChecksOf(current).length === 0) {
				return { text: "그사이 검사 상태가 바뀌어 닫지 않았습니다." };
			}
			if (this.#deps.laneBusy?.(current.originKey) === true) {
				return { text: '레인이 아직 작업 중입니다. 끝난 뒤 다시 "닫아"라고 해 주세요.' };
			}
		} else {
			const superseded = lands ? this.#claimSuperseded(lane) : undefined;
			if (superseded !== undefined) return superseded;
		}
		const closed = this.#deps.store.transitionLane(
			lane.name,
			"closed",
			{ event: "closed", sha, ...(expected.detail === undefined ? {} : { detail: expected.detail }) },
			{
				sha,
				milestone: undefined,
				milestoneEvidence: undefined,
				integrityApproval: undefined,
				...(lands ? { land, ...scope } : {}),
			},
		);
		this.#deps.log.info("lane_closed", { lane: lane.name, sha });
		const rendered = await this.#sync(closed, "transition");
		// The turn that made the claim still delivers its closing report before the child stops.
		void this.#deps
			.stopWhenIdle(lane.originKey)
			.catch((error: unknown) => this.#deps.log.error("lane_stop_failed", { lane: lane.name, error: String(error) }));
		if (lands) this.#spawn(lane.name, () => this.#announce(lane.name));
		const prefix = held === OWNER_ACCEPTED ? `오너 수락으로 닫았습니다: 커밋 ${sha}.` : `검증 통과: 커밋 ${sha}.`;
		return {
			text: `${prefix} 레인 ${lane.name}을 닫았습니다.${lands ? ` ${branch}를 ${baseBranch}에 합치는 일은 코어와 오너가 합니다(스레드의 Outcome 카드).` : ""}`,
			row: rendered,
		};
	}

	/** `[reason]` while an apply code rollback holds auto-merge (`autoland.hold`, logged `task_autoland_held`); `[]` otherwise. */
	#autoLandHeld(name: string): string[] {
		const hold = this.#deps.autoLandHold?.();
		if (hold === undefined) return [];
		this.#deps.log.info("task_autoland_held", { lane: name, reason: hold });
		return [`autoland.hold: ${hold}`];
	}

	/**
	 * The Outcome card of a closed lane whose landing nobody asked for yet. With `taskAutoLand` and no blocker the card
	 * is news and the core lands the lane at once; otherwise the card asks (`머지`·`폐기`), naming why it was not
	 * merged unasked. A card that could not be posted leaves the lane as it is: the next tick tries again, so nothing
	 * is merged under an announcement the owner never saw.
	 */
	async #announce(name: string): Promise<void> {
		const { store, log } = this.#deps;
		// A running review or QA announces the lane itself when it ends.
		if (
			this.#announcing.has(name) ||
			this.#landing.has(name) ||
			this.#reviewing.has(name) ||
			this.#qaRunning.has(name)
		) {
			return;
		}
		this.#announcing.add(name);
		try {
			const lane = store.getLane(name);
			const waiting = (row: LaneRow | undefined): row is LaneRow =>
				row?.status === "closed" &&
				row.meta.land?.state === "pending" &&
				row.meta.land.cardTs === undefined &&
				row.meta.land.requestedBy === undefined;
			if (!waiting(lane)) return;
			const policy = this.#deps.autoLandPolicy?.();
			let skipped: string[] | undefined;
			if (policy !== undefined) {
				await primeGateChanges(lane.meta);
				const now = receiptNowOf(policy);
				const reviewStale = receiptStaleOf("review", lane.meta.review, now);
				const qaStale = receiptStaleOf("qa", lane.meta.qa, now);
				const matched = await this.#repoMatches(lane.meta.repo ?? lane.cwd, policy.repos);
				const frozen = this.#deps.frozen?.() !== undefined;
				const held = this.#autoLandHeld(name);
				// The review is judged without both receipts (a QA reason would hold it forever: the QA waits for the review),
				// the QA without its own only — so the order is review → CLEAR → QA → merge.
				const { review, qa, ...withoutReceipts } = policy;
				// A lane in the confident band is held back by its risk only until its review: judge it at that band's top.
				const band = confidentBand(lane.meta.risk, policy);
				const gate = band === undefined ? withoutReceipts : { ...withoutReceipts, maxRisk: band.maxRisk };
				// Only a lane the review alone holds back is reviewed, and one commit only once (a restart keeps the receipt).
				if (
					review !== undefined &&
					held.length === 0 &&
					(lane.meta.review?.sha !== lane.meta.sha || reviewStale !== undefined) &&
					laneLandBlockers(lane, gate, matched, frozen, now).length === 0
				) {
					// Up to 30 minutes: in the background, so the tick that announces never waits for it.
					this.#reviewing.add(name);
					if (reviewStale !== undefined) log.info("receipt_stale", { lane: name, kind: "review", reason: reviewStale });
					this.#spawn(name, () => this.#review(name, review, reviewStale));
					return;
				}
				// Only a lane the QA alone holds back is run (an unreviewable one never is), one commit only once.
				const withoutQa = review === undefined ? withoutReceipts : { ...withoutReceipts, review };
				if (
					qa !== undefined &&
					held.length === 0 &&
					(lane.meta.qa?.sha !== lane.meta.sha || qaStale !== undefined) &&
					laneQaRisk(lane.meta.risk ?? DEFAULT_LANE_RISK, policy) &&
					laneLandBlockers(lane, withoutQa, matched, frozen, now).length === 0
				) {
					if (qaStale !== undefined) log.info("receipt_stale", { lane: name, kind: "qa", reason: qaStale });
					this.#startQa(name, qa, qaStale);
					return;
				}
				skipped = [...held, ...laneLandBlockers(lane, policy, matched, frozen, now)];
			}
			const auto = skipped !== undefined && skipped.length === 0;
			// The card says what the merge does, so a `lanes.land` mode `pr` is recorded before it goes up (see `#runLanding`).
			const decided =
				lane.meta.land?.mode !== undefined ||
				lane.meta.externalPr !== undefined ||
				(await this.#deps.landMode?.(lane.meta.repo ?? lane.cwd))?.config.mode !== "pr"
					? lane
					: this.#patchLand(name, { mode: "pr" });
			// Once per claim commit (a restart keeps it): the row returned by the patch is what the first card shows.
			const shown = decided.meta.changes?.sha === decided.meta.sha ? decided : await this.#recordChanges(decided);
			const cardTs = await this.#postCard(
				shown,
				auto ? { kind: "auto" } : { kind: "ask", ownerUserId: this.#ownerOf(lane), skipped },
			);
			if (cardTs === undefined) return;
			// The owner may have reopened the lane while the card went up: then the card is already stale.
			const current = store.getLane(name);
			if (!waiting(current)) return;
			this.#patchLand(name, { cardTs });
			if (skipped !== undefined && !auto)
				log.info("lane_autoland_skipped", { lane: name, reasons: skipped.join(" | ") });
			if (!auto) return;
			// The owner's `멈춰` may have landed while the card went up: the merge then stays with the owner, and the
			// card that promised an auto-merge asks instead.
			const held = current.meta.land?.autoLandHeld;
			if (held === undefined) await this.requestLand(name, "auto");
			else await this.#editCard(current, cardTs, { kind: "ask", ownerUserId: this.#ownerOf(current), skipped: [held] });
		} finally {
			this.#announcing.delete(name);
		}
	}

	/**
	 * Records what the lane's claim commit changed and which unmerged lanes or base commits touched the same files, for
	 * the Outcome card only (nothing decides on it). A computation that throws is recorded as its `error`.
	 */
	async #recordChanges(lane: LaneRow): Promise<LaneRow> {
		const { store, log } = this.#deps;
		let changes: LaneChanges;
		try {
			changes = await computeLaneChanges(lane, store.listLanes(), this.#deps.changesGit);
		} catch (error) {
			changes = {
				sha: lane.meta.sha ?? "",
				files: 0,
				insertions: 0,
				deletions: 0,
				top: [],
				overlaps: [],
				baseDrift: [],
				error: cutCodePointSafe(String(error), 200),
			};
		}
		if (changes.error !== undefined) log.warn("lane_changes_failed", { lane: lane.name, error: changes.error });
		// The owner may have reopened the lane while git ran: a reopened lane keeps no changes of its old commit.
		if (store.getLane(lane.name)?.meta.sha !== lane.meta.sha) return lane;
		return store.patchLane(lane.name, undefined, { changes });
	}

	/**
	 * Runs the independent review of the closed lane's claim commit (one review at a time across lanes) and records
	 * its receipt, then announces the lane again with it. A review killed by `stop()` records nothing (the tick after
	 * the restart reviews again); one whose lane moved on meanwhile (reopened) is not recorded either.
	 */
	async #review(name: string, review: { model: string; timeoutMs: number }, staleReason?: string): Promise<void> {
		const { store, log, clock } = this.#deps;
		const abort = new AbortController();
		let recorded = false;
		try {
			let receipt: LaneReview;
			const free = await this.#reviewSlot();
			try {
				const lane = store.getLane(name);
				if (this.#stopped || lane?.status !== "closed" || lane.meta.sha === undefined) return;
				this.#checkAborts.add(abort);
				const reviewer = this.#deps.reviewer;
				log.info("lane_review_started", { lane: name, sha: lane.meta.sha, model: review.model });
				receipt =
					reviewer === undefined
						? {
								sha: lane.meta.sha,
								verdict: "inconclusive",
								model: review.model,
								at: clock.now(),
								notes: "",
								reason: "리뷰 실행기 없음",
							}
						: await reviewLane(
								{ lane, model: review.model, timeoutMs: review.timeoutMs, signal: abort.signal },
								{ ...reviewer, headOf: (worktree) => this.#ops.headOf(worktree), now: () => clock.now(), log },
							);
			} finally {
				this.#checkAborts.delete(abort);
				free();
			}
			if (abort.signal.aborted) {
				log.info("lane_review_stopped", { lane: name });
				return;
			}
			const current = store.getLane(name);
			if (current?.meta.sha !== receipt.sha) {
				log.info("lane_review_stale", { lane: name, sha: receipt.sha });
				if (current !== undefined) this.#dropReviewFiles(current);
				return;
			}
			const label = receipt.verdict === "inconclusive" ? "확인 불가" : receipt.verdict;
			const scored = receipt.confidence === undefined ? label : `${label} ${formatConfidence(receipt.confidence)}`;
			const row = store.patchLane(
				name,
				{
					event: "review",
					detail: `${scored} · ${receipt.model}${staleReason === undefined ? "" : ` · 재검사(${staleReason})`}`,
					sha: receipt.sha,
				},
				{ review: receipt },
			);
			log.info("lane_reviewed", {
				lane: name,
				sha: receipt.sha,
				verdict: receipt.verdict,
				reason: receipt.reason ?? "",
				...(receipt.confidence === undefined ? {} : { confidence: receipt.confidence }),
			});
			// The owner merged or discarded it while the review ran: that landing's cleanup may have come first.
			const state = row.meta.land?.state;
			if (state !== "pending" && state !== "blocked") this.#dropReviewFiles(row);
			recorded = true;
		} finally {
			this.#reviewing.delete(name);
		}
		if (recorded) await this.#announce(name);
	}

	/** Starts the run QA in the background, registered before any await (a landing or discard finds it at once). */
	#startQa(name: string, qa: LaneQaPolicy, staleReason?: string): void {
		const abort = new AbortController();
		const ended = Promise.withResolvers<void>();
		this.#qaRunning.set(name, { abort, ended: ended.promise });
		this.#spawn(name, () => this.#qa(name, qa, abort, ended.resolve, staleReason));
	}

	/**
	 * Runs the QA of the closed lane's claim commit (in the review slot: one review or QA at a time) and records its
	 * receipt, then announces the lane again with it. An aborted QA (a landing, a discard, `!reopen`, `stop()`) records
	 * nothing, and neither does one whose lane was landed or moved to another commit meanwhile: the lane is read again
	 * right before the write.
	 */
	async #qa(
		name: string,
		qa: LaneQaPolicy,
		abort: AbortController,
		end: () => void,
		staleReason?: string,
	): Promise<void> {
		const { store, log, clock } = this.#deps;
		let recorded = false;
		try {
			let receipt: LaneQa;
			const slot = this.#reviewSlot();
			const free = await untilAborted(slot, abort.signal);
			if (free === undefined) {
				// Aborted while waiting: the place in the queue is taken already, so it is given back when it comes.
				void slot.then((late) => late());
				log.info("lane_qa_stopped", { lane: name });
				return;
			}
			try {
				const lane = store.getLane(name);
				if (this.#stopped || abort.signal.aborted || lane?.status !== "closed" || lane.meta.sha === undefined) return;
				this.#checkAborts.add(abort);
				const reviewer = this.#deps.reviewer;
				const worktreesDir = this.#deps.qaWorktreesDir;
				log.info("lane_qa_started", { lane: name, sha: lane.meta.sha, model: qa.model });
				receipt =
					reviewer === undefined || worktreesDir === undefined
						? {
								sha: lane.meta.sha,
								verdict: "inconclusive",
								findings: [],
								model: qa.model,
								at: clock.now(),
								reason: "QA 실행기 없음",
							}
						: await runLaneQa(
								{ lane, policy: qa, signal: abort.signal },
								qaDepsOf(reviewer, worktreesDir, () => clock.now(), log),
							);
			} finally {
				this.#checkAborts.delete(abort);
				free();
			}
			if (abort.signal.aborted) {
				log.info("lane_qa_stopped", { lane: name });
				return;
			}
			const current = store.getLane(name);
			const land = current?.meta.land;
			if (
				current?.status !== "closed" ||
				current.meta.sha !== receipt.sha ||
				(land?.state !== "pending" && land?.state !== "blocked") ||
				land.requestedBy !== undefined
			) {
				log.info("lane_qa_stale", { lane: name, sha: receipt.sha });
				return;
			}
			const label = receipt.verdict === "inconclusive" ? `확인 불가(${receipt.reason ?? "?"})` : receipt.verdict;
			const redone = staleReason === undefined ? "" : ` · 재검사(${staleReason})`;
			store.patchLane(
				name,
				{ event: "qa", detail: `${label} · ${receipt.model}${redone}`, sha: receipt.sha },
				{ qa: receipt },
			);
			log.info("lane_qa_recorded", {
				lane: name,
				sha: receipt.sha,
				verdict: receipt.verdict,
				reason: receipt.reason ?? "",
			});
			recorded = true;
		} finally {
			// Before the announce: a landing that announce starts must not wait for this QA.
			this.#qaRunning.delete(name);
			end();
		}
		if (recorded) await this.#announce(name);
	}

	/** Aborts the lane's running QA and waits until its run ended (its copy removed); at once when none runs. */
	async #stopQa(name: string): Promise<void> {
		const running = this.#qaRunning.get(name);
		if (running === undefined) return;
		running.abort.abort();
		this.#deps.log.info("lane_qa_aborted", { lane: name });
		await running.ended;
	}

	/**
	 * A merged lane's non-blocking leftovers go to the follow-up ledger (`followupsFile`), each once per lane, commit and
	 * text (a landing run again adds none), and the thread gets one line when any was written. A write that fails is
	 * logged: the merge stands.
	 */
	async #recordFollowups(lane: LaneRow): Promise<void> {
		const file = this.#deps.followupsFile;
		if (file === undefined) return;
		let written: number;
		try {
			written = appendFollowups(file, lane, this.#deps.clock.now());
		} catch (error) {
			this.#deps.log.warn("lane_followups_failed", { lane: lane.name, error: cutCodePointSafe(String(error), 200) });
			return;
		}
		if (written === 0) return;
		this.#deps.log.info("lane_followups_recorded", { lane: lane.name, count: written });
		await this.#postInThread(lane, `후속 ${written}건을 장부에 남김`);
	}

	/**
	 * Removes the lane's review files (`<reviewsDir>/<laneId>-*.diff`, `-*.omp.yml` and the `-*.cwd` directories); a missing
	 * one is no error, a failure is logged.
	 */
	#dropReviewFiles(lane: LaneRow): void {
		const dir = this.#deps.reviewer?.reviewsDir;
		if (dir === undefined) return;
		const prefix = `${lane.meta.laneId ?? lane.name}-`;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.#deps.log.warn("lane_review_files_unreadable", { lane: lane.name, error: String(error) });
			}
			return;
		}
		for (const entry of entries) {
			if (!entry.startsWith(prefix) || !REVIEW_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
			try {
				rmSync(join(dir, entry), { force: true, recursive: true });
			} catch (error) {
				this.#deps.log.warn("lane_review_file_remove_failed", { lane: lane.name, file: entry, error: String(error) });
			}
		}
	}

	#repoMatches(path: string, repos: readonly string[]): Promise<boolean> {
		return (this.#deps.repoMatches ?? repoMatchesCommonDir)(path, repos);
	}

	readonly #matcher: RepoMatcher = (path, repos) => this.#repoMatches(path, repos);

	/** Merges `patch` into the lane's `meta.land` (one history entry when given); the row as written. */
	#patchLand(
		name: string,
		patch: Partial<LaneLand>,
		entry?: { event: string; detail?: string; sha?: string },
	): LaneRow {
		const { store } = this.#deps;
		const current = store.getLane(name)?.meta.land ?? { state: "pending", attempts: 0 };
		return store.patchLane(name, entry, { land: { ...current, ...patch } });
	}

	/**
	 * Why `!reopen` cannot reopen this closed lane; `undefined` = it can. A landed, pushed-or-not, or discarded lane
	 * has no worktree left to work in, and a landing that is running must not lose its lane.
	 */
	reopenRefusal(lane: LaneRow): string | undefined {
		const land = lane.meta.land;
		if (lane.status !== "closed" || land === undefined) return undefined;
		if (this.#landing.has(lane.name)) return "머지가 진행 중이라 다시 열 수 없습니다. 끝난 뒤 다시 시도하세요.";
		if (land.state === "pending" || land.state === "blocked") return undefined;
		if (land.state === "pr-open")
			return "PR이 열려 CI를 기다리는 중입니다. 코어가 머지하거나 레인으로 돌려보낸 뒤 다시 시도하세요.";
		const done = land.state === "discarded" ? "폐기" : "머지";
		return `이 레인은 이미 ${done}되어 worktree가 없습니다. 이어서 할 일은 새 레인(\`작업: <제목> @<경로>\`)으로 시작하세요.`;
	}

	/**
	 * Lands a closed lane: the owner's `머지` button or `머지해` (`owner`, allowed while frozen — a freeze holds only
	 * what the bot does on its own), or `taskAutoLand` (`auto`). Only a `pending` or `blocked` landing takes it, and
	 * one lane lands once at a time. The owner's request always pushes `origin/<baseBranch>`; an auto-merge pushes
	 * because it only happens inside `taskAutoLand.repos`.
	 */
	async requestLand(name: string, by: "owner" | "auto"): Promise<LaneRequestOutcome> {
		const { store } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		if (lane?.meta.externalPr !== undefined) {
			return { handled: false, text: "외부 PR 레인은 base에 머지하지 않습니다 — PR 게시를 쓰세요." };
		}
		if (lane?.status !== "closed" || land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
			return { handled: false, text: `머지할 상태가 아닙니다 (${land?.state ?? lane?.status ?? "레인 없음"}).` };
		}
		if (this.#landing.has(name)) return { handled: false, text: "이미 머지가 진행 중입니다." };
		this.#landing.add(name);
		try {
			// A running QA is aborted (its receipt is never written) and its copy removed before the landing.
			await this.#stopQa(name);
			// Recorded before any git runs: a restart finds the landing begun and the tick finishes it.
			this.#patchLand(
				name,
				{ state: "pending", requestedBy: by, reason: undefined },
				{ event: "land_requested", detail: by },
			);
			const queued = this.#deps.laneBusy?.(lane.originKey) === true;
			// The owner's click is answered on the card at once (the buttons go); an auto-merge card already says so.
			if (by === "owner" && land.cardTs !== undefined) {
				await this.#editCard(lane, land.cardTs, { kind: "merging", queued });
			}
			if (queued) {
				// The lane's own turn is still running in the worktree this landing removes: the tick lands it afterwards.
				this.#deps.log.info("lane_land_deferred", { lane: name, by, reason: "lane_turn_running" });
				return {
					handled: true,
					text: "⏳ 레인이 마무리 보고를 쓰는 중이라, 끝나는 대로 머지합니다. 결과는 이 스레드의 카드에 표시됩니다.",
				};
			}
			return { handled: true, text: await this.#runLanding(name, false) };
		} finally {
			this.#landing.delete(name);
		}
	}

	/**
	 * One run of a begun landing (`meta.land.requestedBy`), from the top: `landLane` skips what an earlier run already
	 * did. `resumed`: the tick picked it up after a restart or a failed run — nobody is watching the card, so a result
	 * that needs the owner goes up as a new card. Returns the owner-facing result line.
	 */
	async #runLanding(name: string, resumed: boolean): Promise<string> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		const { repo, worktree, branch, baseBranch, sha } = lane?.meta ?? {};
		if (
			lane === undefined ||
			land === undefined ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined ||
			baseBranch === undefined ||
			sha === undefined
		) {
			throw new Error(`lane ${name} has nothing to land`);
		}
		// Only a closed lane whose landing is still open is landed, whatever the caller read before.
		if (lane.status !== "closed" || (land.state !== "pending" && land.state !== "pr-open")) {
			return "이 레인은 머지 대기 상태가 아닙니다.";
		}
		const by = land.requestedBy ?? "owner";
		const policy = this.#deps.autoLandPolicy?.();
		const matched = policy !== undefined && (await this.#repoMatches(repo, policy.repos));
		// An auto-merge is judged once more right before git runs (the receipt, a hold or a freeze may have changed);
		// the owner's request is not — the owner is the reviewer then. `taskAutoLand` switched off since the landing was
		// booked withdraws it too.
		if (by === "auto") {
			await primeGateChanges(lane.meta);
			const blockers =
				policy === undefined
					? [AUTO_LAND_OFF]
					: [
							...this.#autoLandHeld(name),
							...laneLandBlockers(lane, policy, matched, this.#deps.frozen?.() !== undefined),
						];
			if (blockers.length > 0) {
				const row = this.#patchLand(
					name,
					{ requestedBy: undefined },
					{ event: "auto_land_withdrawn", detail: blockers.join(" | ") },
				);
				log.info("lane_autoland_skipped", { lane: name, reasons: blockers.join(" | ") });
				if (land.cardTs !== undefined) {
					await this.#editCard(row, land.cardTs, { kind: "ask", ownerUserId: this.#ownerOf(row), skipped: blockers });
				}
				return `자동 머지 안 함: ${blockers.join(" · ")}`;
			}
		}
		// `lanes.land` is read when the landing begins (`land.mode` keeps it for the rest): `pr` lands through a PR, never asks.
		const landMode = lane.meta.externalPr === undefined ? await this.#deps.landMode?.(repo) : undefined;
		const viaPr = land.mode === "pr" || landMode?.config.mode === "pr";
		const push = by === "owner" || matched;
		// An auto-merge speaks up when it fails (nobody clicked anything); so does a landing the tick resumed.
		const unattended = by === "auto" || resumed;
		// A `pr-open` lane comes back here on every CI read: only the landing's start is logged.
		if (land.state !== "pr-open") log.info("lane_land_started", { lane: name, by, push, resumed });
		// Before the landing removes the worktree and branch: the note's content is collected while they exist.
		await this.#deps.wikiNotes?.laneDraft(lane);
		let result: LandResult;
		try {
			// An idle child of this lane (it answered a question after closing) still has the worktree as its cwd.
			await this.#deps.stopWhenIdle(lane.originKey);
			if (viaPr) {
				const outcome = await this.#prLand.run(lane, landMode, { repo, worktree, branch, baseBranch, sha });
				const settled = await this.#prLand.settle(lane, outcome, unattended);
				if (typeof settled === "string") return settled;
				result = settled;
			} else {
				result = await this.#land(
					{ repo, baseBranch, branch, worktree, sha, push },
					{
						onMerged: (preSha) => void this.#patchLand(name, { preSha }),
						beforeCleanup: () => this.#preserveArtifacts(name, worktree),
					},
				);
			}
		} catch (error) {
			const errors = (store.getLane(name)?.meta.land?.errors ?? 0) + 1;
			log.warn("lane_land_unavailable", { lane: name, errors, error: String(error) });
			if (errors < LAND_ERRORS_MAX) {
				this.#patchLand(name, { errors }, { event: "land_unavailable", detail: cutCodePointSafe(String(error), 200) });
				return "⚠️ 머지를 끝내지 못했습니다(git 또는 호스트 오류). 코어가 곧 이어서 다시 시도합니다.";
			}
			result = { state: "blocked", reason: `머지를 ${errors}번 끝내지 못함: ${cutCodePointSafe(String(error), 200)}` };
		}
		const short = sha.slice(0, 12);
		if (result.state === "not-ff") {
			const attempts = land.attempts + 1;
			this.#deps.wikiNotes?.laneDropDraft(lane);
			if (attempts < LAND_ATTEMPTS_MAX) return this.#backToWork(lane, attempts, result.reason);
			result = {
				state: "blocked",
				reason: `${result.reason} — ${attempts}번째라 레인에 다시 맡기지 않았습니다. 직접 rebase하거나 \`!reopen\`·\`폐기\`로 정해 주세요.`,
			};
			this.#patchLand(name, { attempts });
		}
		if (result.state === "blocked") {
			this.#deps.wikiNotes?.laneDropDraft(lane);
			const row = this.#patchLand(
				name,
				{ state: "blocked", reason: result.reason, requestedBy: undefined, errors: undefined },
				{ event: "land_blocked", detail: result.reason },
			);
			log.warn("lane_land_blocked", { lane: name, reason: result.reason });
			await this.#showResult(await this.#sync(row, "transition"), unattended);
			return `🚧 머지하지 못했습니다: ${result.reason}`;
		}
		// Merged. `"unknown"` only means this run found the merge done: keep what the run that merged recorded.
		const recorded = store.getLane(name)?.meta.land?.preSha;
		const preSha = result.preSha === "unknown" ? (recorded ?? "unknown") : result.preSha;
		const { cleanup } = result;
		if (cleanup !== undefined) log.warn("lane_cleanup_failed", { lane: name, sha, cleanup });
		const cleaned = cleanup === undefined ? "worktree 정리" : `⚠️ ${cleanup}`;
		if (result.state === "merged-not-pushed") {
			const row = this.#patchLand(
				name,
				{ state: "merged-not-pushed", preSha, reason: result.reason, errors: undefined, cleanup },
				{ event: "merged_not_pushed", detail: result.reason, sha },
			);
			log.warn("lane_merged_not_pushed", { lane: name, sha, reason: result.reason });
			this.#dropReviewFiles(row);
			await this.#showResult(await this.#sync(row, "transition"), unattended);
			await this.#recordFollowups(row);
			return `⚠️ ${baseBranch}에 머지했지만 push origin/${baseBranch}는 되지 않았습니다: ${result.reason}${
				cleanup === undefined ? "" : ` · ${cleaned}`
			}`;
		}
		const row = this.#patchLand(
			name,
			{
				state: "landed",
				preSha,
				reason: undefined,
				errors: undefined,
				cleanup,
				...(result.pushed === undefined ? {} : { pushed: result.pushed }),
			},
			{ event: "landed", sha, ...(result.pushed === undefined ? {} : { detail: `push ${result.pushed}` }) },
		);
		log.info("lane_landed", { lane: name, sha, pushed: result.pushed ?? "none", by });
		await this.#deps.wikiNotes?.laneLanded(row);
		this.#dropReviewFiles(row);
		await this.#showResult(await this.#sync(row, "transition"), false);
		await this.#recordFollowups(row);
		return `✅ 머지했습니다: ${baseBranch} ← ${short} · ${result.pushed === undefined ? "push 없음(origin 원격 없음)" : `push ${result.pushed}`} · ${cleaned}`;
	}

	/**
	 * The base branch moved ahead of the claim. Unless frozen, the core rebases the lane's branch onto it first
	 * (`#coreRebase`): a clean rebase is the lane's new claim and the whole verdict (checks included) runs again without
	 * the lane. Otherwise — a conflict, a detached HEAD, a rebase that left nothing, a git failure, a running lane turn —
	 * the lane stays `working` with the rebase instruction, and its next claim runs the verdict again.
	 */
	async #backToWork(lane: LaneRow, attempts: number, reason: string): Promise<string> {
		const { store, clock, log } = this.#deps;
		const now = clock.now();
		const cardTs = lane.meta.land?.cardTs;
		const base = lane.meta.baseBranch ?? "";
		const working = store.transitionLane(
			lane.name,
			"working",
			{ event: "land_not_ff", detail: reason },
			{
				startedAt: now,
				lastProgressAt: now,
				milestone: undefined,
				milestoneEvidence: undefined,
				claim: undefined,
				sha: undefined,
				changes: undefined,
				land: { state: "pending", attempts },
			},
		);
		log.info("lane_land_not_ff", { lane: lane.name, attempts });
		// Frozen (only the owner's landing gets here then): no autonomous re-prompt into the lane, like resume.
		const frozen = this.#deps.frozen?.() !== undefined;
		const rebase = frozen ? undefined : await this.#coreRebase(lane);
		if (rebase?.state === "rebased") {
			const claimed = store.getLane(lane.name) ?? working;
			await this.#sync(claimed, "transition");
			if (cardTs !== undefined) {
				await this.#editCard(claimed, cardTs, {
					kind: "rework",
					reason: `${reason} — 코어가 \`${base}\` 위로 rebase해 검사를 다시 돌립니다.`,
				});
			}
			// Started after the claim is recorded; the landing that got here ends before the verdict can land it again.
			this.#settleInBackground(lane.name, false);
			return `🔄 머지하지 못했습니다: ${reason}. 코어가 \`${base}\` 위로 rebase해(${rebase.oldSha.slice(0, 12)}→${rebase.newSha.slice(0, 12)}) 검사를 다시 돌립니다 — 통과하면 Outcome 카드로 다시 알립니다.`;
		}
		if (rebase?.state === "superseded") {
			// Paused while git ran: no claim, no verdict, no rebase prompt; the lane picks the rebased branch up on resume.
			const held = await this.#sync(store.getLane(lane.name) ?? working, "transition");
			const moved = `${rebase.oldSha.slice(0, 12)}→${rebase.newSha.slice(0, 12)}`;
			const note = `코어가 \`${base}\` 위로 rebase했지만(${moved}) 그사이 레인이 ${rebase.status}가 되어 완료로 올리지 않았습니다`;
			if (cardTs !== undefined) await this.#editCard(held, cardTs, { kind: "rework", reason: `${reason} — ${note}.` });
			return `🔄 머지하지 못했습니다: ${reason}. ${note}.`;
		}
		await this.#sync(working, "transition");
		const missed =
			rebase === undefined
				? ""
				: ` (코어 rebase 안 함: ${rebase.why}${rebase.abortFailed === undefined ? "" : " — ⚠️ 되돌리기 실패, worktree가 rebase 중일 수 있습니다"})`;
		if (cardTs !== undefined) {
			await this.#editCard(working, cardTs, {
				kind: "rework",
				reason: frozen
					? `${reason} — 동결 중이라 레인에 rebase 안내를 보내지 않았습니다.`
					: `${reason} — 레인이 \`${base}\` 위로 rebase하고 있습니다${missed}.`,
			});
		}
		if (frozen) {
			log.warn("lane_send_held_frozen", { lane: lane.name });
			return `🔄 머지하지 못했습니다: ${reason}. 동결 중이라 rebase 안내는 보내지 않았습니다 — 동결이 풀린 뒤 이 스레드에 rebase를 지시하세요.`;
		}
		this.#send(lane.name, "rebase", buildRebasePrompt({ branch: lane.meta.branch ?? "", baseBranch: base }));
		return `🔄 머지하지 못했습니다: ${reason}${missed}. 레인이 rebase한 뒤 다시 완료를 주장합니다.`;
	}

	/**
	 * The core's own rebase of a not-ff lane (`lane` as it was before going back to `working`). While it runs the
	 * lane's mailbox holds its rows (`isCoreRebasing`), so no lane turn works in the worktree; they are dispatched
	 * after it, whatever happened. A clean rebase is recorded as the lane's claim (`done-claimed`) before that.
	 */
	async #coreRebase(lane: LaneRow): Promise<LaneCoreRebase> {
		const { store, log } = this.#deps;
		const { worktree = lane.cwd, branch = "", baseBranch = "" } = lane.meta;
		// The landing waited for the lane's turn, but a message may have started one since.
		if (this.#deps.laneBusy?.(lane.originKey) === true) {
			log.info("lane_core_rebase_skipped", { lane: lane.name, why: "lane_turn_running" });
			return { state: "missed", why: "레인 턴 진행 중", detail: "lane turn running" };
		}
		this.#coreRebasing.add(lane.originKey);
		try {
			const result = await coreRebase(this.#deps.rebaseGit ?? defaultGit, { worktree, branch, baseBranch });
			if (result.state === "missed") {
				log.info("lane_core_rebase_missed", { lane: lane.name, why: result.why, detail: result.detail });
				if (result.abortFailed !== undefined) {
					log.warn("lane_core_rebase_abort_failed", { lane: lane.name, worktree, error: result.abortFailed });
				}
				return result;
			}
			const moved = `${result.oldSha.slice(0, 12)}→${result.newSha.slice(0, 12)}`;
			const current = store.patchLane(lane.name, { event: "core_rebased", detail: moved, sha: result.newSha }, {});
			// The owner may have paused the lane (or it moved on) while git ran: the rebase stays on the branch, but it is
			// no claim — `paused → done-claimed` (meant for resume) would close and merge a held lane.
			if (current.status !== "working") {
				log.warn("lane_core_rebase_superseded", { lane: lane.name, status: current.status, to: result.newSha });
				return { state: "superseded", status: current.status, oldSha: result.oldSha, newSha: result.newSha };
			}
			const previous = lane.meta.claim;
			const claim: LaneClaim = {
				repo: previous?.repo ?? worktree,
				commit: result.newSha,
				summary: `${previous?.summary ?? lane.title} (코어 rebase ${moved})`,
				claimedAt: this.#claimStamp(current),
			};
			store.transitionLane(
				lane.name,
				"done-claimed",
				{ event: "claim", detail: `${claim.repo}@${claim.commit}: ${claim.summary}` },
				{ claim, lastClaimedAt: claim.claimedAt },
			);
			log.info("lane_core_rebased", { lane: lane.name, from: result.oldSha, to: result.newSha });
			return result;
		} finally {
			this.#coreRebasing.delete(lane.originKey);
			await this.#deps
				.resumePending(lane.originKey)
				.catch((error: unknown) => log.error("lane_resume_failed", { lane: lane.name, error: String(error) }));
		}
	}

	/**
	 * Discards a closed lane unmerged (the owner's `폐기` button or `폐기해`): its worktree and branch go, the claim
	 * commit stays in the repository's object store until git prunes it. Only a `pending` or `blocked` landing takes it.
	 */
	async discard(name: string): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const land = lane?.meta.land;
		const { repo, worktree, branch } = lane?.meta ?? {};
		if (
			lane?.status !== "closed" ||
			land === undefined ||
			(land.state !== "pending" && land.state !== "blocked") ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined
		) {
			return { handled: false, text: `폐기할 상태가 아닙니다 (${land?.state ?? lane?.status ?? "레인 없음"}).` };
		}
		if (this.#landing.has(name)) return { handled: false, text: "머지가 진행 중이라 폐기할 수 없습니다." };
		if (land.requestedBy !== undefined) return { handled: false, text: "머지가 예약돼 있어 폐기할 수 없습니다." };
		if (this.#deps.laneBusy?.(lane.originKey) === true) {
			return { handled: false, text: "레인이 아직 마무리 보고를 쓰는 중입니다. 끝난 뒤 다시 시도해 주세요." };
		}
		this.#landing.add(name);
		try {
			await this.#stopQa(name);
			// An idle child of this lane still has the worktree as its cwd.
			await this.#deps.stopWhenIdle(lane.originKey);
			await this.#removeLaneWorktree(name, { repo, worktree, branch });
			if (existsSync(worktree)) {
				log.warn("lane_discard_failed", { lane: name, worktree });
				return { handled: false, text: `worktree를 지우지 못했습니다: ${worktree}` };
			}
			const row = this.#patchLand(
				name,
				{ state: "discarded", reason: undefined, requestedBy: undefined },
				{ event: "discarded", ...(lane.meta.sha === undefined ? {} : { sha: lane.meta.sha }) },
			);
			log.info("lane_discarded", { lane: name });
			this.#dropReviewFiles(row);
			await this.#showResult(await this.#sync(row, "transition"), false);
			return {
				handled: true,
				text: `🗑 폐기했습니다: worktree와 브랜치 ${branch}를 지웠습니다(머지하지 않음). 커밋 ${(lane.meta.sha ?? "").slice(0, 12)}는 reflog에 남습니다.${
					lane.meta.pr?.url === undefined ? "" : `\nPR ${lane.meta.pr.url}은 그대로입니다.`
				}`,
			};
		} finally {
			this.#landing.delete(name);
		}
	}

	/** Merges `patch` into the lane's `meta.pr` (the last PR's url and branch stay; `reason` only when given). */
	#patchPr(name: string, patch: LanePr, entry?: { event: string; detail?: string; sha?: string }): LaneRow {
		const { store } = this.#deps;
		const current = store.getLane(name)?.meta.pr;
		return store.patchLane(name, entry, { pr: { ...current, reason: undefined, ...patch } });
	}

	/** Redraws a closed lane's Outcome card where it is (an external PR lane's follows `meta.pr`); none posted: nothing. */
	async #redrawCard(lane: LaneRow): Promise<void> {
		const cardTs = lane.meta.land?.cardTs;
		if (cardTs !== undefined) await this.#editCard(lane, cardTs, { kind: "ask", ownerUserId: this.#ownerOf(lane) });
	}

	/** Why an external PR lane takes no `PR 게시`/`보류` now; `undefined` = it does. */
	#publishRefusal(lane: LaneRow | undefined): string | undefined {
		const land = lane?.meta.land;
		if (lane === undefined) return "레인을 찾을 수 없습니다.";
		if (lane.meta.externalPr === undefined) return "외부 PR 레인이 아닙니다 — `!pr`로 먼저 붙이세요.";
		if (lane.status !== "closed" || land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
			return `PR을 게시할 상태가 아닙니다 (${land?.state ?? lane.status}).`;
		}
		if (lane.meta.pr?.state === "asking" || this.#publishing.has(lane.name)) {
			return "이미 PR 게시 승인을 기다리고 있습니다.";
		}
		if (this.#landing.has(lane.name)) return "다른 처리가 진행 중입니다. 끝난 뒤 다시 시도하세요.";
		if (land.requestedBy !== undefined) return "머지가 예약돼 있어 PR을 게시할 수 없습니다.";
		return undefined;
	}

	/**
	 * `!pr` (설계 1): marks a closed lane's work as a GitHub PR — `repo` given, read from the PR, or from `origin` —
	 * and redraws its card. `prNumber` names the open PR the publish continues (`!pr <PR 주소|번호>`).
	 */
	async attachExternalPr(name: string, given: { repo?: string; prNumber?: number }): Promise<LaneRequestOutcome> {
		const lane = this.#deps.store.getLane(name);
		const land = lane?.meta.land;
		if (lane?.status !== "closed" || land === undefined || (land.state !== "pending" && land.state !== "blocked")) {
			return {
				handled: false,
				text: `외부 PR로 돌릴 상태가 아닙니다 (${land?.state ?? lane?.status ?? "레인 없음"}).`,
			};
		}
		const { repo, baseBranch, laneId } = lane.meta;
		if (repo === undefined || baseBranch === undefined || laneId === undefined) {
			return { handled: false, text: "worktree 레인이 아니라 외부 PR로 돌릴 수 없습니다." };
		}
		if (lane.meta.pr?.state === "asking" || this.#landing.has(name) || land.requestedBy !== undefined) {
			return { handled: false, text: "머지나 PR 게시가 진행 중이라 지금은 바꿀 수 없습니다." };
		}
		const current = lane.meta.externalPr;
		const input: ExternalPrInput & { prNumber?: number } = {
			...(current === undefined
				? {}
				: {
						base: current.base,
						bodyFile: current.bodyFile,
						title: current.title,
						branch: current.branch,
						...(current.pushRemote === undefined ? {} : { pushRemote: current.pushRemote }),
						...(given.repo === undefined ? { repo: current.repo } : {}),
						...(given.prNumber === undefined && current.prNumber !== undefined && given.repo === undefined
							? { prNumber: current.prNumber }
							: {}),
					}),
			...given,
		};
		const resolved = await resolveExternalPr(
			input,
			{ repoDir: repo, baseBranch, title: lane.title, laneId },
			(this.#deps.prTools ?? defaultPrTools).git,
		);
		if (!resolved.ok) return { handled: false, text: resolved.problem };
		const external = resolved.value;
		const row = this.#deps.store.patchLane(
			name,
			{
				event: "external_pr",
				detail: `${external.repo}${external.prNumber === undefined ? "" : `#${external.prNumber}`}`,
			},
			{ externalPr: external },
		);
		this.#deps.log.info("lane_external_pr", { lane: name, repo: external.repo, pr: external.prNumber });
		await this.#redrawCard(row);
		await this.#sync(row, "transition");
		const pr = external.prNumber === undefined ? "" : ` · 기존 PR #${external.prNumber} 이어받기`;
		return {
			handled: true,
			text: `📤 외부 PR 레인으로 바꿨습니다: ${external.repo}:${external.base}${pr}, 본문 ${external.bodyFile}. 카드의 \`PR 게시\`로 올립니다.`,
		};
	}

	/** `보류` (설계 5): the external PR waits for the owner; nothing goes out. */
	async hold(name: string): Promise<LaneRequestOutcome> {
		const refusal = this.#publishRefusal(this.#deps.store.getLane(name));
		if (refusal !== undefined) return { handled: false, text: refusal };
		const row = this.#patchPr(name, { state: "held" }, { event: "pr_held", detail: "오너 보류" });
		await this.#redrawCard(row);
		await this.#sync(row, "transition");
		return { handled: true, text: "⏸ PR 게시를 보류했습니다." };
	}

	/**
	 * `PR 게시` (설계 3): checks what needs no network first (worktree at the claim and clean, the body file), records
	 * `asking`, then — in the background, so the click is answered at once — decides the push target and the PR to
	 * continue, asks for approval and publishes. A stopping core aborts it (`stop()`).
	 */
	async requestPublish(name: string): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const refusal = this.#publishRefusal(lane);
		if (refusal !== undefined || lane === undefined) return { handled: false, text: refusal ?? "레인 없음" };
		const approve = this.#deps.requestApproval;
		const thread = parseThreadRef(lane.threadRef);
		const { worktree, sha, externalPr } = lane.meta;
		if (approve === undefined || thread === undefined || worktree === undefined || sha === undefined || !externalPr) {
			return { handled: false, text: "승인 경로나 worktree가 없어 PR을 게시할 수 없습니다." };
		}
		// Held from here: a second click finds the lane busy.
		this.#landing.add(name);
		let started = false;
		try {
			let head: { sha: string; clean: boolean };
			try {
				head = await this.#ops.headOf(worktree);
			} catch (error) {
				return { handled: false, text: `worktree를 읽지 못했습니다: ${cutCodePointSafe(String(error), 200)}` };
			}
			if (head.sha !== sha || !head.clean) {
				return {
					handled: false,
					text: "worktree가 완료 커밋과 다릅니다(HEAD 이동 또는 미커밋 변경). `!reopen <지시>`로 정리한 뒤 다시 닫으세요.",
				};
			}
			const body = readPrBody(worktree, externalPr.bodyFile);
			if (!body.ok) {
				log.warn("lane_pr_body_refused", { lane: name, reason: body.reason });
				return { handled: false, text: body.reason };
			}
			const firstLine = firstLineOf(body.text);
			if (firstLine === undefined) {
				return { handled: false, text: `본문 파일 없음: \`${externalPr.bodyFile}\`가 없거나 비어 있습니다.` };
			}
			const abort = new AbortController();
			this.#publishing.set(name, abort);
			started = true;
			const row = this.#patchPr(name, { state: "asking" }, { event: "pr_requested", sha });
			log.info("lane_pr_requested", { lane: name, repo: externalPr.repo });
			await this.#redrawCard(row);
			await this.#sync(row, "transition");
			this.#spawn(name, () =>
				this.#publish(name, abort, { firstLine, approve, channel: thread.channel, threadTs: thread.threadTs }),
			);
			return { handled: true, text: "📤 PR 게시 승인 카드를 올립니다. 결과는 이 스레드의 카드에 표시됩니다." };
		} finally {
			if (!started) this.#landing.delete(name);
		}
	}

	/** The background half of `requestPublish`; every step after an await first checks that `stop()` did not cut it. */
	async #publish(
		name: string,
		abort: AbortController,
		input: {
			firstLine: string;
			approve: NonNullable<LaneManagerDeps["requestApproval"]>;
			channel: string;
			threadTs: string;
		},
	): Promise<void> {
		const { store, log } = this.#deps;
		const { signal } = abort;
		const tools = this.#deps.prTools ?? defaultPrTools;
		const finish = async (patch: LanePr, entry: { event: string; detail?: string; sha?: string }) => {
			if (signal.aborted) return;
			const row = this.#patchPr(name, patch, entry);
			if (patch.state === "failed") log.warn("lane_pr_failed", { lane: name, reason: patch.reason });
			if (patch.state === "published") log.info("lane_pr_published", { lane: name, url: patch.url });
			this.#publishing.delete(name);
			this.#landing.delete(name);
			await this.#redrawCard(row);
			await this.#sync(row, "transition");
		};
		try {
			const lane = store.getLane(name);
			const { repo, worktree, sha, externalPr, leftovers, changes } = lane?.meta ?? {};
			if (lane === undefined || repo === undefined || worktree === undefined || sha === undefined || !externalPr) {
				return await finish({ state: "failed", reason: "레인 정보가 사라졌습니다." }, { event: "pr_failed" });
			}
			const fail = (reason: string) => finish({ state: "failed", reason }, { event: "pr_failed", detail: reason });
			const target = await resolvePushTarget(tools, { repoDir: repo, externalPr, signal });
			if (signal.aborted) return;
			if (!target.ok) return await fail(target.reason);
			const plan = await planPr(tools, { repoDir: repo, worktree, externalPr, target: target.value, sha, signal });
			if (signal.aborted) return;
			if (!plan.ok) return await fail(plan.reason);
			const published = (url: string, branch: string, detail: string) =>
				finish(
					{
						state: "published",
						url,
						branch,
						remote: target.value.remote,
						sha,
						at: this.#deps.clock.now(),
						// A publish (or a republish after `!reopen`) starts the pr-watch afresh: the first pass is a baseline,
						// and an earlier `!prwatch off` does not outlive it.
						watch: undefined,
						watchOff: undefined,
					},
					{ event: "pr_published", detail, sha },
				);
			if (plan.value.kind === "update") {
				// The PR's own head branch is where the lane's commit goes from now on.
				store.patchLane(name, undefined, {
					externalPr: { ...externalPr, branch: plan.value.pr.headRefName, prNumber: plan.value.pr.number },
				});
				// The lane commit is in the PR already: nothing goes out, so nothing to approve.
				if (!plan.value.push) {
					return await published(plan.value.pr.url, plan.value.pr.headRefName, `${plan.value.pr.url} (이미 반영됨)`);
				}
			}
			const branch = plan.value.kind === "update" ? plan.value.pr.headRefName : externalPr.branch;
			const what = plan.value.kind === "update" ? `기존 PR #${plan.value.pr.number} 갱신` : "새 PR";
			const blocking = (leftovers ?? []).filter((item) => item.blocking).map((item) => item.text);
			const changed =
				changes?.sha === sha && changes.error === undefined
					? `${changes.files}개 파일 +${changes.insertions} −${changes.deletions}`
					: "확인 안 됨";
			const summary = [
				`외부 PR 게시(${what}): ${externalPr.repo}:${externalPr.base} ← ${target.value.login}:${branch}`,
				`레인 ${lane.title} · 커밋 ${sha.slice(0, 12)} · 변경 ${changed}`,
				`push 대상: ${target.value.url}${target.value.fork && plan.value.kind === "new" ? " (포크를 새로 만듦)" : ""}`,
				`본문 ${externalPr.bodyFile} 첫 줄: ${cutCodePointSafe(input.firstLine, 200)}`,
				...(blocking.length === 0 ? [] : [`막는 남은 일: ${blocking.slice(0, 3).join(" · ")}`]),
			].join("\n");
			const result = await input.approve({
				channel: input.channel,
				summary,
				signal,
				origin: { originKey: lane.originKey, channel: input.channel, threadTs: input.threadTs },
				detail: {
					external: `github.com/${externalPr.repo} 공개 PR(누구나 봄)`,
					action: `git push ${target.value.remote} ${sha.slice(0, 12)}:refs/heads/${branch} (force 없음)${
						plan.value.kind === "new" ? ` → gh pr create --repo ${externalPr.repo} --base ${externalPr.base}` : ""
					}`,
					rollback: "gh pr close <url> + 원격 브랜치 삭제(이미 본 사람은 되돌릴 수 없음)",
				},
			});
			if (signal.aborted) return;
			if (result !== "approved") {
				const reason =
					result === "denied"
						? "승인 거부"
						: result === "timeout"
							? "승인 시간 초과"
							: `답장(승인 아님): ${cutCodePointSafe(oneLine(result.replied), 80)}`;
				return await finish({ state: "held", reason }, { event: "pr_held", detail: reason });
			}
			const done = await publishPr(tools, {
				repoDir: repo,
				worktree,
				externalPr,
				target: target.value,
				plan: plan.value,
				sha,
				signal,
			});
			if (signal.aborted) return;
			if (!done.ok) return await fail(done.reason);
			return await published(done.url, done.branch, done.url);
		} catch (error) {
			if (signal.aborted) return;
			await finish(
				{ state: "failed", reason: `게시 중 오류: ${cutCodePointSafe(String(error), 200)}` },
				{ event: "pr_failed", detail: cutCodePointSafe(String(error), 200) },
			);
		} finally {
			// `finish` released it on every recorded end; an abort was released by `stop()`.
			if (this.#publishing.get(name) === abort) {
				this.#publishing.delete(name);
				this.#landing.delete(name);
			}
		}
	}

	/** `!prwatch off <레인>`: the owner stops reading this lane's published PR (`PrWatchRunner.off`). */
	stopPrWatch(name: string): Promise<LaneRequestOutcome> {
		return this.#prWatch.off(name);
	}

	/**
	 * Closes a `not-done` lane whose `[check: …]` failed (e.g. a criterion deferred by plan) when the owner writes
	 * `닫아` in its thread: sets `autoLandHeld = OWNER_ACCEPTED` so auto-merge skips it and the owner decides `머지해` /
	 * `폐기해` on the Outcome card. Never accepts a lane whose HEAD moved past the checked commit or has dirty work.
	 */
	async acceptByOwner(name: string): Promise<LaneRequestOutcome> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		if (lane?.status !== "not-done") {
			return { handled: false, text: `닫을 상태가 아닙니다 (${lane?.status ?? "레인 없음"}).` };
		}
		const worktree = lane.meta.worktree;
		if (worktree === undefined) return { handled: false, text: "worktree가 없는 레인입니다." };
		const checksHead = lane.meta.checks?.head;
		const failed = failedChecksOf(lane);
		if (checksHead === undefined || checksHead === "" || failed.length === 0) {
			return { handled: false, text: "실패한 검사가 없습니다 — 닫을 이유가 검사 실패가 아닙니다." };
		}
		if (this.#settling.has(name)) {
			return { handled: false, text: "레인의 완료 검증이 진행 중입니다. 끝난 뒤 다시 시도해 주세요." };
		}
		if (this.#landing.has(name)) return { handled: false, text: "이미 닫기 또는 머지 처리가 진행 중입니다." };
		if (this.#coreRebasing.has(lane.originKey)) {
			return { handled: false, text: "코어 rebase가 진행 중입니다. 끝난 뒤 다시 시도해 주세요." };
		}
		if (this.#deps.laneBusy?.(lane.originKey) === true) {
			return { handled: false, text: '레인이 아직 작업 중입니다. 끝난 뒤 다시 "닫아"라고 해 주세요.' };
		}
		this.#landing.add(name);
		let closedLands = false;
		try {
			let head: { sha: string; clean: boolean };
			try {
				head = await this.#ops.headOf(worktree);
			} catch (error) {
				return {
					handled: false,
					text: `worktree 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (head.sha !== checksHead) {
				return { handled: false, text: "HEAD가 마지막 검사 커밋이 아닙니다 — 레인이 새 커밋을 냈습니다." };
			}
			if (!head.clean) {
				return {
					handled: false,
					text: "worktree에 커밋하지 않은 변경이 있습니다 — 모두 커밋한 뒤 다시 시도해 주세요.",
				};
			}
			const current = store.getLane(name);
			if (current?.status !== "not-done") {
				return { handled: false, text: `닫을 상태가 아닙니다 (${current?.status ?? "레인 없음"}).` };
			}
			const currentFailed = failedChecksOf(current);
			if (current.meta.checks?.head !== checksHead || currentFailed.length === 0) {
				return { handled: false, text: "그사이 검사 상태가 바뀌어 닫지 않았습니다." };
			}
			if (
				this.#settling.has(name) ||
				this.#coreRebasing.has(current.originKey) ||
				this.#deps.laneBusy?.(current.originKey) === true
			) {
				return { handled: false, text: '레인이 아직 작업 중입니다. 끝난 뒤 다시 "닫아"라고 해 주세요.' };
			}
			const failedIds = currentFailed.map((check) => check.id).join(", ");
			const outcome = await this.#close(current, checksHead, OWNER_ACCEPTED, {
				status: "not-done",
				detail: `오너 수락 · 실패 검사 ${failedIds}`,
			});
			if (outcome.row === undefined) return { handled: false, text: outcome.text };
			closedLands = outcome.row.meta.land !== undefined;
			log.warn("lane_owner_accepted", { lane: name, sha: checksHead, checks: failedIds });
			return { handled: true, text: outcome.text };
		} finally {
			this.#landing.delete(name);
			// `#close` spawned `#announce` while `#landing` held `name`, so it returned early; post the Outcome card now.
			if (closedLands) this.#spawn(name, () => this.#announce(name));
		}
	}

	/** The owner to mention on the lane's cards: the one configured for the platform of the lane's thread. */
	#ownerOf(lane: LaneRow): string | undefined {
		return this.#ownerOfThread(lane.threadRef);
	}

	#ownerOfThread(threadRef: string): string | undefined {
		const owner = this.#deps.ownerUserId;
		if (typeof owner !== "function") return owner;
		const platform = platformOfThreadRef(threadRef);
		return platform === undefined ? undefined : owner(platform);
	}

	/**
	 * `jabbu_work_start` with `after`: stores the start arguments instead of starting a lane. Refused (`LaneInputError`, nothing stored) for an argument `start` would refuse, for a
	 * prerequisite that is missing, in another repository, without a worktree (made before lanes had one) or already
	 * discarded, for a repeated one, one named like the lane itself, or more than
	 * `RESERVATION_AFTER_MAX`. `args` is `start`'s input without `parentOrigin` (that is `originKey`) or `force`
	 * (a reservation never freezes an override: ▶ is judged by the host at click time).
	 */
	async reserve(input: {
		/** No `borrowThread`: a reserved lane starts after the conversation moved on, always in a thread of its own. */
		args: Omit<Parameters<LaneManager["start"]>[0], "force" | "borrowThread">;
		after: unknown;
		originKey: string;
		threadRef: string | undefined;
	}): Promise<LaneReservation> {
		const { store, clock } = this.#deps;
		const { args } = input;
		const names = Array.isArray(input.after)
			? input.after.map((name) => (typeof name === "string" ? name.trim() : ""))
			: [];
		if (names.length < 1 || names.length > RESERVATION_AFTER_MAX || names.some((name) => name === "")) {
			throw new LaneInputError(`after는 선행 레인 이름 1~${RESERVATION_AFTER_MAX}개여야 합니다.`);
		}
		if (new Set(names).size !== names.length) throw new LaneInputError("after에 같은 레인이 두 번 들어 있습니다.");
		const title = cutCodePointSafe(redact(args.title.replace(/\s+/g, " ").trim()), MAX_TITLE_CHARS);
		if (title === "") throw new LaneInputError("작업 제목이 비어 있습니다.");
		parseStartArgs(args, this.#deps.laneModels?.());
		if (names.includes(slugify(title))) {
			throw new LaneInputError(
				`선행 레인 ${slugify(title)}은 이 예약의 레인과 같은 이름입니다 (순환): 제목을 바꾸세요.`,
			);
		}
		if (!isAbsolute(args.cwd)) throw new LaneInputError(`프로젝트 경로는 절대경로여야 합니다: ${args.cwd}`);
		let cwd: string;
		try {
			cwd = realpathSync(args.cwd);
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new LaneInputError(`프로젝트 경로가 디렉터리가 아니거나 없습니다: ${args.cwd}`);
		}
		const found = await resolveLaneRepo(cwd);
		if (!found.ok) throw new LaneInputError(found.problem);
		const { repo } = found.value;
		for (const name of names) {
			const lane = store.getLane(name);
			if (lane === undefined) throw new LaneInputError(`선행 레인을 찾을 수 없습니다: ${name}`);
			if (lane.meta.repo === undefined)
				throw new LaneInputError(`선행 레인 ${name}은 worktree 도입 전 레인이라 선행으로 쓸 수 없습니다.`);
			if (!(await sameRepo(lane.meta.repo, repo, this.#matcher)))
				throw new LaneInputError(`선행 레인 ${name}은 다른 저장소의 레인입니다.`);
			if (lane.meta.land?.state === "discarded") throw new LaneInputError(`선행 레인 ${name}은 이미 폐기됐습니다.`);
		}
		if (input.threadRef === undefined) throw new LaneInputError("예약을 올릴 대화를 찾지 못했습니다.");
		const frozen = this.#deps.frozen?.();
		if (frozen !== undefined) throw new LaneInputError(frozenMessage(frozen));
		const reservation = store.insertLaneReservation({
			originKey: input.originKey,
			threadRef: input.threadRef,
			repo,
			after: names,
			startArgs: {
				...args,
				title,
				...(args.brief === undefined ? {} : { brief: redact(args.brief) }),
				...(typeof args.tierReason === "string" ? { tierReason: redact(args.tierReason) } : {}),
			},
			expiresAt: clock.now() + RESERVATION_TTL_MS,
		});
		this.#deps.log.info("lane_reserved", { reservation: reservation.id, after: names.join(","), title });
		return reservation;
	}

	/** ▶ 시작: the prerequisites and the expiry are read again, then the frozen arguments go to `start`. */
	async startReservation(id: number): Promise<LaneRequestOutcome> {
		const { store, clock, log } = this.#deps;
		const reservation = store.getLaneReservation(id);
		if (reservation === undefined) return { handled: false, text: `예약 #${id}을 찾을 수 없습니다.` };
		if (reservation.state !== "ready") {
			return {
				handled: false,
				text:
					reservation.state === "waiting"
						? `예약 #${id}은 아직 선행이 착지하지 않았습니다.`
						: `예약 #${id}은 이미 ${STATE_TEXT[reservation.state]} 상태입니다.`,
			};
		}
		if (clock.now() >= reservation.expiresAt) {
			await this.#expireReservation(reservation);
			return { handled: false, text: `예약 #${id}은 만료됐습니다.` };
		}
		if (!judgeAfter(reservation.after, (name) => store.getLane(name)).ready) {
			store.moveLaneReservation(id, ["ready"], "waiting");
			return {
				handled: false,
				text: `예약 #${id}의 선행 ${reservation.after.join(", ")}이 더는 착지 상태가 아닙니다. 다시 기다립니다.`,
			};
		}
		// One click wins: a second one finds the reservation already `started`.
		if (!store.moveLaneReservation(id, ["ready"], "started"))
			return { handled: false, text: `예약 #${id}은 이미 시작 중입니다.` };
		this.#startingReservations.add(id);
		try {
			const lane = await this.start({
				...(reservation.startArgs as Parameters<LaneManager["start"]>[0]),
				parentOrigin: reservation.originKey,
			});
			store.moveLaneReservation(id, ["started"], "started", { laneName: lane.name });
			return { handled: true, text: `▶ 예약 #${id} 시작: 레인 \`${lane.name}\`` };
		} catch (error) {
			store.moveLaneReservation(id, ["started"], "ready");
			log.warn("lane_reservation_start_failed", { reservation: id, error: String(error) });
			return {
				handled: false,
				text: `예약 #${id}을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			this.#startingReservations.delete(id);
		}
	}

	/** ✖ 취소: a `waiting` or `ready` reservation is dropped. */
	cancelReservation(id: number): LaneRequestOutcome {
		const { store } = this.#deps;
		const reservation = store.getLaneReservation(id);
		if (reservation === undefined) return { handled: false, text: `예약 #${id}을 찾을 수 없습니다.` };
		if (!store.moveLaneReservation(id, ["waiting", "ready"], "cancelled")) {
			return { handled: false, text: `예약 #${id}은 이미 ${STATE_TEXT[reservation.state]} 상태입니다.` };
		}
		return { handled: true, text: `✖ 예약 #${id} 취소됨` };
	}

	/**
	 * Closes a `waiting` or `ready` reservation as `expired` and announces it. The notice stays owed (`notice`) until a
	 * post succeeds, so a failed post or an unresolved thread is tried again by the next tick (qa-x #71).
	 */
	async #expireReservation(reservation: LaneReservation): Promise<void> {
		const { store } = this.#deps;
		if (!store.moveLaneReservation(reservation.id, ["waiting", "ready"], "expired", { notice: EXPIRY_UNANNOUNCED }))
			return;
		await this.#announceExpiry(reservation);
	}

	async #announceExpiry(reservation: LaneReservation): Promise<void> {
		if (await this.#postReservation(reservation, { text: expiredNotice(reservation) }))
			this.#deps.store.moveLaneReservation(reservation.id, ["expired"], "expired", { notice: null });
	}

	/**
	 * A `started` reservation without its lane and not starting in this process was left by a process that died inside
	 * `start` (qa-x #70): the lane it opened, if its registry row exists, is recorded; otherwise it goes back to `ready`
	 * so the owner can click ▶ again or cancel. A start that died before its row leaves no lane the owner could use.
	 */
	#recoverStartedReservations(): void {
		const { store, log } = this.#deps;
		for (const reservation of store.listLaneReservations(["started"])) {
			if (reservation.laneName !== null || this.#startingReservations.has(reservation.id)) continue;
			const lane = store
				.listLanes()
				.find(
					(row) =>
						row.meta.parentOrigin === reservation.originKey &&
						row.meta.repo === reservation.repo &&
						row.title === reservation.startArgs.title &&
						row.meta.startedAt >= reservation.createdAt,
				);
			if (lane !== undefined) {
				store.moveLaneReservation(reservation.id, ["started"], "started", { laneName: lane.name });
				log.warn("lane_reservation_recovered", { reservation: reservation.id, lane: lane.name });
			} else if (store.moveLaneReservation(reservation.id, ["started"], "ready")) {
				log.warn("lane_reservation_recovered", { reservation: reservation.id, lane: "none" });
			}
		}
	}

	/** Posts into the reservation's thread; false when the post failed (logged), so the caller tries again next tick. */
	async #postReservation(
		reservation: LaneReservation,
		message: { text: string; buttons?: ReturnType<typeof buildReservationReadyMessage>["buttons"] },
	): Promise<boolean> {
		const route = this.#deps.channels.forThreadRef(reservation.threadRef);
		if (route === undefined) return false;
		try {
			await route.port.post(route.target, { ...message, text: renderMentions(message.text, route.port) });
			return true;
		} catch (error) {
			this.#deps.log.warn("lane_reservation_post_failed", { reservation: reservation.id, error: String(error) });
			return false;
		}
	}

	/**
	 * The tick's pass over `waiting` and `ready` reservations. Each one reads its prerequisites' registry rows again, so a
	 * landing, an outside merge and a lane without a worktree are judged by the same rule. Expired ones are closed and
	 * announced; `ready` ones wait for the owner's click.
	 */
	async #tickReservations(): Promise<void> {
		const { store, clock } = this.#deps;
		this.#recoverStartedReservations();
		for (const reservation of store.listLaneReservations(["expired"])) {
			if (reservation.notice === EXPIRY_UNANNOUNCED) await this.#announceExpiry(reservation);
		}
		for (const reservation of store.listLaneReservations(["waiting", "ready"])) {
			if (clock.now() >= reservation.expiresAt) {
				await this.#expireReservation(reservation);
				continue;
			}
			if (reservation.state !== "waiting") continue;
			const verdict = judgeAfter(reservation.after, (name) => store.getLane(name));
			if (verdict.ready) {
				// `ready` before the post: a click on the card must find the reservation startable; a failed post undoes it.
				if (!store.moveLaneReservation(reservation.id, ["waiting"], "ready", { notice: null })) continue;
				const card = buildReservationReadyMessage(reservation, this.#ownerOfThread(reservation.threadRef));
				if (!(await this.#postReservation(reservation, card))) {
					store.moveLaneReservation(reservation.id, ["ready"], "waiting");
				}
				continue;
			}
			const signature = blockerSignature(verdict.blockers);
			if (signature === (reservation.notice ?? "")) continue;
			if (signature === "") {
				store.moveLaneReservation(reservation.id, ["waiting"], "waiting", { notice: null });
			} else if (await this.#postReservation(reservation, blockerMessage(reservation, verdict.blockers))) {
				store.moveLaneReservation(reservation.id, ["waiting"], "waiting", { notice: signature });
			}
		}
	}

	/**
	 * Link to the lane's thread where it is not the conversation the lane was asked from (a platform whose threads are
	 * opened apart, Discord); `undefined` when the platform has none or when the lookup fails (logged).
	 */
	async threadLink(lane: LaneRow): Promise<string | undefined> {
		const parsed = parseThreadRef(lane.threadRef);
		const route = parsed === undefined ? undefined : this.#deps.channels.forConversation(parsed.channel);
		if (parsed === undefined || route?.port.openThread === undefined) return undefined;
		try {
			return await route.port.permalink({
				platform: route.port.platform,
				conversationId: parsed.channel,
				messageId: parsed.threadTs,
				threadId: parsed.threadTs,
			});
		} catch (error) {
			this.#deps.log.warn("lane_permalink_failed", { lane: lane.name, error: String(error) });
			return undefined;
		}
	}

	/** A rework card names how long lanes usually take (nothing under 10 closed lanes). */
	#withTypical(view: LaneCardView): LaneCardView {
		if (view.kind !== "rework") return view;
		const typical = typicalLaneDuration(this.#deps.store, this.#deps.log);
		return typical === undefined ? view : { ...view, typical };
	}

	/** Augments a card view with the lane worker session's cost totals; on failure leaves cost undefined and logs lane_cost_failed. */
	async #withCost(lane: LaneRow, view: LaneCardView): Promise<LaneCardView> {
		if (view.cost !== undefined) return view;
		try {
			const totals = await laneCost(lane);
			return { ...view, cost: { usd: totals.costTotal, calls: totals.calls } };
		} catch (error) {
			this.#deps.log.warn("lane_cost_failed", { lane: lane.name, error: String(error) });
			return view;
		}
	}

	/** Posts a card into the lane's thread; the message id, or `undefined` when the post failed (logged). */
	async #postCard(lane: LaneRow, view: LaneCardView): Promise<string | undefined> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return undefined;
		try {
			const withCost = await this.#withCost(lane, view);
			const card = buildLaneOutcomeCard(lane, this.#withTypical(withCost), this.#deps.boardUrl?.());
			return (await route.port.post(route.target, cardMessage(card, route.port))).messageId;
		} catch (error) {
			this.#deps.log.warn("lane_card_post_failed", { lane: lane.name, error: String(error) });
			return undefined;
		}
	}

	/** Redraws a posted card in place (an edit without buttons removes the ones it had). Failures are logged. */
	async #editCard(lane: LaneRow, cardTs: string, view: LaneCardView): Promise<void> {
		const route = this.#deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		try {
			const withCost = await this.#withCost(lane, view);
			const card = buildLaneOutcomeCard(lane, this.#withTypical(withCost), this.#deps.boardUrl?.());
			await route.port.edit(
				{
					platform: route.port.platform,
					conversationId: route.target.conversationId,
					messageId: cardTs,
					...(route.target.threadId === undefined ? {} : { threadId: route.target.threadId }),
				},
				cardMessage({ ...card, buttons: card.buttons ?? [] }, route.port),
			);
		} catch (error) {
			this.#deps.log.warn("lane_card_edit_failed", { lane: lane.name, error: String(error) });
		}
	}

	/**
	 * Shows how the landing ended (`meta.land`). In place on the lane's card when somebody is watching it; as a new
	 * card (a notification, with the owner mention) when `fresh` — the old card then only points to the new one.
	 */
	async #showResult(lane: LaneRow, fresh: boolean): Promise<void> {
		const view: LaneCardView = { kind: "result", ownerUserId: this.#ownerOf(lane) };
		const old = lane.meta.land?.cardTs;
		if (old !== undefined && !fresh) return this.#editCard(lane, old, view);
		const cardTs = await this.#postCard(lane, view);
		if (cardTs === undefined) {
			if (old !== undefined) await this.#editCard(lane, old, view);
			return;
		}
		this.#patchLand(lane.name, { cardTs });
		if (old !== undefined) await this.#editCard(lane, old, { kind: "superseded" });
	}

	/** A tick's not-done verdict reached while frozen: the claim stays `done-claimed` for the first tick after unfreeze. */
	#heldByFreeze(name: string, fromTick: boolean): SettleOutcome | undefined {
		if (!fromTick || this.#deps.frozen?.() === undefined) return undefined;
		this.#deps.log.warn("lane_verdict_held_frozen", { lane: name });
		return { text: "held while frozen" };
	}

	async #notDone(lane: LaneRow, reasons: string[]): Promise<SettleOutcome> {
		// The owner paused while the verdict ran: not-done cannot land now (paused takes no transition, no steer).
		if (this.#deps.store.getLane(lane.name)?.status === "paused") {
			this.#deps.log.warn("lane_notdone_held_paused", { lane: lane.name });
			return { text: "held while paused" };
		}
		const row = this.#deps.store.transitionLane(
			lane.name,
			"not-done",
			{ event: "not_done", detail: reasons.join(" | ") },
			{},
		);
		this.#deps.log.info("lane_not_done", { lane: lane.name, reasons: reasons.length });
		const rendered = await this.#sync(row, "transition");
		// Frozen: no autonomous re-prompt into a running lane. The lane stays not-done; the next verdict after unfreeze steers.
		if (this.#deps.frozen?.() !== undefined) this.#deps.log.warn("lane_send_held_frozen", { lane: lane.name });
		else this.#send(lane.name, "not-done", buildNotDonePrompt(reasons));
		return {
			text: `[not-done] 완료 주장이 검증을 통과하지 못했습니다:\n${reasons.map((r) => `- ${r}`).join("\n")}`,
			row: rendered,
		};
	}

	/**
	 * Periodic work: start the verdict of claims older than the grace period (not awaited — a check or an approval card
	 * of one lane never holds the others), then reconcile the messages of every lane not being judged. The rows
	 * `listLanes` parsed are reused for the reconcile, so one sweep parses each lane's history once. A lane being judged
	 * is left alone this tick: its verdict draws its own transition, and the next tick reconciles the rest.
	 */
	async tick(): Promise<void> {
		const frozen = this.#deps.frozen?.() !== undefined; // frozen: no orphan take-back, PR tracking, cleanup or reservation card
		if (!frozen) await this.#takeBackOrphans();
		const now = this.#deps.clock.now();
		for (const lane of this.#deps.store.listLanes()) {
			try {
				if (this.#settling.has(lane.name)) continue;
				const claim = lane.meta.claim;
				const next = this.#nextSettleAt.get(lane.name);
				if (next !== undefined && (lane.status !== "done-claimed" || claim?.claimedAt !== next.claimedAt)) {
					this.#nextSettleAt.delete(lane.name);
				}
				// Timed-out checks are run again only a grace after their last run (one 300 s run per tick would stall it).
				const timedOut = lane.meta.checks?.inconclusive;
				// Frozen: the deferred verdict waits. A not-done now could not be steered and would never be judged again.
				if (
					lane.status === "done-claimed" &&
					claim &&
					now - claim.claimedAt >= CLAIM_GRACE_MS &&
					(timedOut === undefined || now - timedOut.lastAt >= CLAIM_GRACE_MS) &&
					(this.#nextSettleAt.get(lane.name)?.at ?? now) <= now &&
					!frozen
				) {
					this.#nextSettleAt.delete(lane.name);
					this.#settleInBackground(lane.name, true);
					continue;
				}
				// An `asking` publish no process runs any more (a forced stop): held, so the owner can publish again.
				if (lane.meta.pr?.state === "asking" && !this.#landing.has(lane.name) && !this.#publishing.has(lane.name)) {
					const held = this.#patchPr(
						lane.name,
						{ state: "held", reason: PR_CUT_BY_RESTART },
						{ event: "pr_held", detail: PR_CUT_BY_RESTART },
					);
					await this.#redrawCard(held);
					await this.#sync(held, "tick");
					continue;
				}
				if (!frozen) this.#prWatch.tick(lane, now);
				this.#tickPrLand(lane, now);
				await tickOwnerSilence(this.#deps, lane, now, {
					send: (text) => this.#send(lane.name, "silence", text),
					post: (text) => this.#postInThread(lane, text),
				});
				await this.#sync(lane, "tick");
				await this.#tickLanding(lane);
				if (!frozen && (lane.status === "not-done" || this.#isUnlanded(lane)))
					await this.#closeIfLandedOutside(lane.name);
				if (lane.meta.land?.state === "merged-not-pushed") await this.#markPushedOutside(lane.name);
			} catch (error) {
				this.#deps.log.error("lane_tick_failed", { lane: lane.name, error: String(error) });
			}
		}
		try {
			if (!frozen) await this.#tickReservations();
		} catch (error) {
			this.#deps.log.error("lane_reservation_tick_failed", { error: String(error) });
		}
	}

	/** An attached lane whose `jabbu-pocket lanes attach` process is gone (killed terminal, restart of this host) is taken back. */
	async #takeBackOrphans(): Promise<void> {
		const alive = this.#deps.pidAlive ?? pidAlive;
		for (const lane of this.#deps.store.listLanes()) {
			const attach = lane.meta.attach;
			if (attach === undefined || this.#attaching.has(lane.name) || alive(attach.pid)) continue;
			try {
				this.#deps.log.warn("lane_attach_orphaned", { lane: lane.name, pid: attach.pid });
				await this.detach(lane.name, { sessionFile: attach.sessionFile, newFiles: [], by: "orphan" });
			} catch (error) {
				this.#deps.log.error("lane_attach_orphan_failed", { lane: lane.name, error: String(error) });
			}
		}
	}

	/**
	 * A closed lane whose landing is still `pending`: one that began (`requestedBy`) and is not running in this process
	 * was cut off or waited for the lane's turn to end — run it from the top; one without a card gets its card (the
	 * earlier post failed). A begun auto-merge waits while frozen; the owner's does not.
	 */
	async #tickLanding(listed: LaneRow): Promise<void> {
		// Read again: the tick's list is as old as the lanes settled before this one (an approval wait, a push), and the
		// owner may have landed, discarded or reopened the lane meanwhile.
		const lane = this.#deps.store.getLane(listed.name);
		const land = lane?.meta.land;
		if (lane?.status !== "closed" || land?.state !== "pending") return;
		if (land.requestedBy === undefined) {
			if (land.cardTs === undefined) await this.#announce(lane.name);
			return;
		}
		if (this.#landing.has(lane.name) || this.#deps.laneBusy?.(lane.originKey) === true) return;
		if (land.requestedBy === "auto" && this.#deps.frozen?.() !== undefined) return;
		this.#landing.add(lane.name);
		try {
			await this.#runLanding(lane.name, true);
		} finally {
			this.#landing.delete(lane.name);
		}
	}

	/**
	 * A lane whose PR is open (`pr-open`) is read every `PR_LAND_POLL_MS`, in the background and one at a time: the
	 * landing goes on from its saved step. A freeze does not stop the reads, only the merge (the run is told).
	 */
	#tickPrLand(lane: LaneRow, now: number): void {
		const land = lane.meta.land;
		if (lane.status !== "closed" || land?.state !== "pr-open" || this.#landing.has(lane.name)) return;
		if (now - (land.prLand?.lastPolledAt ?? 0) < PR_LAND_POLL_MS) return;
		this.#landing.add(lane.name);
		this.#spawn(lane.name, async () => {
			try {
				await this.#runLanding(lane.name, true);
			} finally {
				this.#landing.delete(lane.name);
			}
		});
	}

	/**
	 * A `not-done` worktree lane whose work someone merged into the base branch outside the lane: closed as `landed`, its worktree and branch removed. Only a lane whose last
	 * claim carries work made on the lane branch, whose work is in the base branch (`externallyLanded`), with a clean
	 * worktree and no running turn. A git call that fails changes nothing and is logged.
	 */
	#isUnlanded(lane: LaneRow): boolean {
		return lane.status === "closed" && (lane.meta.land?.state === "pending" || lane.meta.land?.state === "blocked");
	}

	async #closeIfLandedOutside(name: string): Promise<void> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const wasClosed = lane?.status === "closed";
		const claim = lane?.meta.claim;
		// A claim names its commit as given (`HEAD` is common); the resolved sha the lane recorded is the fallback.
		const commit =
			claim !== undefined && CLAIM_SHA.test(claim.commit) ? claim.commit : wasClosed ? lane?.meta.sha : undefined;
		const { repo, worktree, branch, baseBranch, baseSha } = lane?.meta ?? {};
		if (
			lane === undefined ||
			!(lane.status === "not-done" || this.#isUnlanded(lane)) ||
			commit === undefined ||
			repo === undefined ||
			worktree === undefined ||
			branch === undefined ||
			baseBranch === undefined ||
			baseSha === undefined ||
			this.#settling.has(name) ||
			this.#landing.has(name) ||
			this.#deps.laneBusy?.(lane.originKey) === true
		) {
			return;
		}
		if ((await laneTreeLeft(defaultGit, { repo, worktree, branch })).length === 0) {
			if (this.#landing.has(name)) return;
			log.warn("lane_tree_gone", { lane: name, worktree, branch });
			await this.#showResult(await this.#sync(closeLaneTreeGone(store, lane), "transition"), false);
			return;
		}
		let found: { sha: string; pushed: boolean } | undefined;
		try {
			found = await externallyLanded(defaultGit, { repo, worktree, branch, baseBranch, baseSha, claim: commit });
		} catch (error) {
			log.warn("lane_external_land_check_failed", { lane: name, error: cutCodePointSafe(String(error), 300) });
			return;
		}
		if (found === undefined) return;
		// Read again: the owner may have written in the thread (back to working) or the lane claimed again meanwhile.
		// A landing that started during the git checks holds the lane in #landing while its land state still reads
		// "pending", so the set is re-checked too — patching landed here would fight its merge and worktree removal.
		const current = store.getLane(name);
		if (
			current === undefined ||
			this.#landing.has(name) ||
			current.status !== lane.status ||
			(wasClosed
				? current.meta.land?.state !== lane.meta.land?.state
				: current.meta.claim?.claimedAt !== claim?.claimedAt)
		) {
			return;
		}
		if (this.#deps.laneBusy?.(lane.originKey) === true) return;
		const { sha, pushed } = found;
		const land: LaneLand = { state: "landed", attempts: 0, ...(pushed ? { pushed: `origin/${baseBranch}` } : {}) };
		const landedEntry = { event: "landed", sha, detail: `레인 밖에서 머지됨 · claim ${sha.slice(0, 12)}` };
		const landedMeta = { sha, milestone: undefined, milestoneEvidence: undefined, land };
		if (wasClosed) store.patchLane(name, landedEntry, landedMeta);
		else store.transitionLane(name, "closed", landedEntry, landedMeta);
		log.info("lane_landed_outside", { lane: name, sha, pushed: pushed ? `origin/${baseBranch}` : "none" });
		// Before the worktree and branch go.
		const landed = store.getLane(name);
		if (landed !== undefined) await this.#deps.wikiNotes?.laneLanded(landed);
		// An idle child of this lane still has the worktree as its cwd.
		await this.#deps.stopWhenIdle(lane.originKey);
		await this.#removeLaneWorktree(name, { repo, worktree, branch });
		const left = await laneTreeLeft(defaultGit, { repo, worktree, branch });
		const row =
			left.length === 0
				? store.getLane(name)
				: this.#patchLand(name, { cleanup: `worktree·브랜치 정리 실패: ${left.join(", ")} — 손으로 지우세요` });
		if (left.length > 0) log.warn("lane_external_land_cleanup_left", { lane: name, left: left.join(", ") });
		this.#dropReviewFiles(row ?? lane);
		if (row !== undefined) await this.#sync(row, "transition");
	}

	/**
	 * A `merged-not-pushed` lane whose merge reached `origin/<baseBranch>` afterwards (`pushedOutside`): becomes
	 * `landed` with `pushed`, so its root and card stop showing ⚠️. A git call that fails changes nothing and is logged.
	 */
	async #markPushedOutside(name: string): Promise<void> {
		const { store, log } = this.#deps;
		const lane = store.getLane(name);
		const { repo, baseBranch, sha } = lane?.meta ?? {};
		if (
			lane?.status !== "closed" ||
			lane.meta.land?.state !== "merged-not-pushed" ||
			repo === undefined ||
			baseBranch === undefined ||
			sha === undefined ||
			this.#landing.has(name)
		) {
			return;
		}
		let pushed: boolean;
		try {
			pushed = await pushedOutside(defaultGit, { repo, baseBranch, sha });
		} catch (error) {
			log.warn("lane_pushed_outside_check_failed", { lane: name, error: cutCodePointSafe(String(error), 300) });
			return;
		}
		if (!pushed) return;
		const row = this.#patchLand(
			name,
			{ state: "landed", reason: undefined, pushed: `origin/${baseBranch}` },
			{ event: "landed", sha, detail: `push origin/${baseBranch} · 레인 밖에서 push됨` },
		);
		log.info("lane_pushed_outside", { lane: name, sha, pushed: `origin/${baseBranch}` });
		await this.#deps.wikiNotes?.laneLanded(row);
		await this.#showResult(await this.#sync(row, "transition"), false);
	}

	#requireLane(originKey: string): LaneRow {
		const lane = this.#deps.store.getLaneByOrigin(originKey);
		if (!lane) throw new Error(`no work lane for origin ${originKey}`);
		return lane;
	}

	/** Brings the root and status messages to what the registry says (`syncLane`). */
	#sync(lane: LaneRow, reason: "transition" | "milestone" | "tick"): Promise<LaneRow> {
		return syncLane(this.#deps, this.#unroutableWarned, lane, reason);
	}
}
