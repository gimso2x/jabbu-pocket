import type { OmpbotConfig } from "../config";
import { redact } from "../redact";
import { repoMatchesCommonDir } from "../tasks/repo-match";
import type { LaneCardView } from "./card";
import type { LandResult } from "./land";
import type { LaneManagerDeps } from "./manager-types";
import { isPollStep, reworkedPrLand, runPrLanding } from "./pr-land";
import { prLandDeps } from "./pr-land-deps";
import { denylistOf } from "./pr-land-remote";
import type { LaneLandMode, PrLandDeps } from "./pr-land-steps";
import type { LanePrLand, PrLandOutcome } from "./pr-land-types";
import type { LaneLand, LaneRow } from "./status";

/** `lanes.land` entry of the repository `repo` (live config), matched like `taskAutoLand.repos`; `undefined` = none. */
export async function landModeOf(
	config: Pick<OmpbotConfig, "lanes" | "recordsRepo">,
	repo: string,
	matches: typeof repoMatchesCommonDir = repoMatchesCommonDir,
): Promise<LaneLandMode | undefined> {
	for (const [path, entry] of Object.entries(config.lanes?.land ?? {})) {
		if (!(await matches(repo, [path]))) continue;
		return { config: entry, ...denylistOf(config.recordsRepo) };
	}
	return undefined;
}

/** What the PR landing needs of its lane manager. */
export interface PrLandCtx {
	deps: LaneManagerDeps;
	removeWorktree: PrLandDeps["removeWorktree"];
	patchLand(name: string, patch: Partial<LaneLand>, entry?: { event: string; detail?: string }): LaneRow;
	preserve(name: string, worktree: string): Promise<void>;
	sync(row: LaneRow): Promise<LaneRow>;
	showResult(row: LaneRow, fresh: boolean): Promise<void>;
	editCard(row: LaneRow, cardTs: string, view: LaneCardView): Promise<void>;
	post(lane: LaneRow, text: string): Promise<void>;
	send(name: string, kind: string, text: string): Promise<boolean>;
}

/** Steered into a lane sent back to work: it stacks new commits on the same branch. */
const reworkPrompt = (branch: string, reason: string, notice: string): string =>
	[
		`[ompbot] PR 착지를 마치지 못했습니다: ${reason}. 레인을 다시 working으로 돌렸습니다.`,
		notice,
		`- 같은 브랜치 \`${branch}\`에 새 커밋을 쌓으세요. rebase·amend·force push는 하지 마세요(이미 올라간 커밋을 고쳐 쓰면 push가 거절됩니다).`,
		"- 머지·push는 코어가 합니다. 끝나면 `ompbot_claim_done`을 다시 호출하세요. 코어가 검사와 누출 검사를 다시 돌린 뒤 같은 PR에 올립니다.",
	].join("\n");

/** Runs and settles the PR landings (`land.mode` pr) of the lane manager. */
export class PrLandHost {
	readonly #ctx: PrLandCtx;
	readonly #abort = new AbortController();
	/** The last read failure posted per lane: the same reason is not repeated until a read succeeds. */
	readonly #warned = new Map<string, string>();

	constructor(ctx: PrLandCtx) {
		this.#ctx = ctx;
	}

	/** The reads of a poll are cut; the write steps are not aborted — a re-run continues from the saved step. */
	stop(): void {
		this.#abort.abort();
	}

	/** One run of the lane's PR landing from its saved step; rejects when git, gh or the host cannot run. */
	async run(
		lane: LaneRow,
		mode: LaneLandMode | undefined,
		at: { repo: string; worktree: string; branch: string; baseBranch: string; sha: string },
	): Promise<PrLandOutcome> {
		const { deps } = this.#ctx;
		const name = lane.name;
		const land = lane.meta.land;
		if (mode?.config.mode !== "pr")
			return { kind: "blocked", reason: "이 착지는 PR 모드로 시작했지만 lanes.land 설정이 pr이 아닙니다." };
		const now = deps.clock.now();
		let prLand = land?.prLand;
		// The owner's resume of a held landing starts its CI wait afresh.
		if (land?.requestedBy === "owner" && prLand !== undefined && isPollStep(prLand))
			prLand = { ...prLand, pushedAt: now };
		if (land?.mode !== "pr" || prLand !== land?.prLand) {
			this.#ctx.patchLand(name, { mode: "pr", ...(prLand === undefined ? {} : { prLand }) });
		}
		return runPrLanding(
			{
				...at,
				checksHead: lane.meta.checks?.head,
				title: lane.title,
				summary: redact(lane.meta.claim?.summary ?? lane.title),
				config: mode.config,
				denylistFile: mode.denylistFile,
				frozen: deps.frozen?.() !== undefined,
				prLand,
			},
			prLandDeps({
				seams: deps.prLandSeams,
				tools: deps.prTools,
				signal: this.#abort.signal,
				removeWorktree: this.#ctx.removeWorktree,
				beforeCleanup: () => this.#ctx.preserve(name, at.worktree),
				now: () => deps.clock.now(),
				save: (saved) => void this.#ctx.patchLand(name, { prLand: saved }),
			}),
		);
	}

	/**
	 * Records what a run ended with. `landed`, `blocked` and `held` come back as the `LandResult` the lane manager's own
	 * landing code finishes with; the others are settled here and answered with the owner-facing text.
	 */
	async settle(lane: LaneRow, outcome: PrLandOutcome, unattended: boolean): Promise<string | LandResult> {
		const { store, log, clock } = this.#ctx.deps;
		const name = lane.name;
		switch (outcome.kind) {
			case "landed":
				return {
					state: "landed",
					preSha: outcome.preSha,
					pushed: outcome.pushed,
					...(outcome.cleanup === undefined ? {} : { cleanup: outcome.cleanup }),
				};
			case "blocked":
			case "held":
				return { state: "blocked", reason: outcome.reason };
			case "waiting": {
				const saved = store.getLane(name)?.meta.land?.prLand;
				if (saved !== undefined) this.#ctx.patchLand(name, { prLand: { ...saved, lastPolledAt: clock.now() } });
				if (outcome.warn === undefined) this.#warned.delete(name);
				else if (this.#warned.get(name) !== outcome.warn) {
					this.#warned.set(name, outcome.warn);
					log.warn("lane_pr_land_read_failed", { lane: name, reason: outcome.warn });
					await this.#ctx.post(lane, `⚠️ PR 착지 읽기 실패 · ${outcome.warn}`);
				}
				return "⏳ PR의 CI를 기다리는 중입니다.";
			}
			case "pr-open": {
				const row = this.#ctx.patchLand(
					name,
					{
						state: "pr-open",
						requestedBy: undefined,
						errors: undefined,
						reason: undefined,
						mode: "pr",
						prLand: outcome.prLand,
					},
					{ event: "pr_land_open", detail: outcome.prLand.url ?? "" },
				);
				log.info("lane_pr_land_open", { lane: name, url: outcome.prLand.url ?? "" });
				await this.#ctx.showResult(await this.#ctx.sync(row), unattended);
				return `🔄 PR을 열었습니다 — CI가 초록이면 코어가 squash 머지합니다: ${outcome.prLand.url ?? ""}`;
			}
			case "rework":
				return this.#rework(lane, outcome.reason, outcome.notice, outcome.prLand);
		}
	}

	/** The lane works again on the same branch; its thread gets the failure once (`notice`), the lane a prompt. */
	async #rework(lane: LaneRow, reason: string, notice: string, saved: LanePrLand): Promise<string> {
		const { store, clock, log, frozen } = this.#ctx.deps;
		const name = lane.name;
		const now = clock.now();
		const cardTs = lane.meta.land?.cardTs;
		const branch = lane.meta.branch ?? "";
		const working = store.transitionLane(
			name,
			"working",
			{ event: "pr_land_rework", detail: reason },
			{
				startedAt: now,
				lastProgressAt: now,
				milestone: undefined,
				milestoneEvidence: undefined,
				claim: undefined,
				sha: undefined,
				changes: undefined,
				land: { state: "pending", attempts: lane.meta.land?.attempts ?? 0, mode: "pr", prLand: reworkedPrLand(saved) },
			},
		);
		log.info("lane_pr_land_rework", { lane: name, reason });
		await this.#ctx.sync(working);
		if (cardTs !== undefined) {
			await this.#ctx.editCard(working, cardTs, {
				kind: "rework",
				reason: `${reason} — 레인이 같은 브랜치 \`${branch}\`를 고칩니다.`,
			});
		}
		await this.#ctx.post(working, notice);
		if (frozen?.() !== undefined) {
			log.warn("lane_send_held_frozen", { lane: name });
			return `🔄 ${reason}. 동결 중이라 레인에 안내를 보내지 않았습니다 — 동결이 풀린 뒤 이 스레드에 지시하세요.`;
		}
		void this.#ctx.send(name, "pr-rework", reworkPrompt(branch, reason, notice));
		return `🔄 ${reason}. 레인이 같은 브랜치에 새 커밋을 쌓은 뒤 다시 완료를 주장합니다.`;
	}
}
