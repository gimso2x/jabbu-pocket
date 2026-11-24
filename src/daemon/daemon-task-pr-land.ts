import { defaultPrTools, type PrTools } from "../lanes/pr";
import { BOUNCES_MAX, isPollStep, openPrLanding, reworkedPrLand, runPrLanding } from "../lanes/pr-land";
import { prLandDeps } from "../lanes/pr-land-deps";
import type { RemoteLandMode } from "../lanes/pr-land-remote";
import { type LaneLandMode, PR_LAND_POLL_MS, type PrLandDeps, type PrLandInput } from "../lanes/pr-land-steps";
import type { LanePrLand, PrLandOutcome } from "../lanes/pr-land-types";
import { defaultGit, type GitRunner } from "../lanes/verify";
import { readAutoLandHold } from "../ops/apply";
import { resumeTask } from "../tasks/dispatch";
import { resolveTaskHost } from "../tasks/host";
import { clip, type TaskLandDeps, type TaskLandResult, taskLandHold } from "../tasks/land";
import {
	isRemoteMode,
	landModeOfRow,
	localRepoOf,
	prepareRemote,
	type RemoteLandEnv,
	remoteWorktree,
} from "../tasks/land-remote";
import type { TaskRow } from "../tasks/ledger";
import type { TaskLandRecord } from "../tasks/ledger-schema";
import { taskLandNote } from "../tasks/notify";
import { postPrLandStop, prLandNoticeKey } from "../tasks/pr-land-retry";
import { prepareLocal, reworkPrompt, summaryOf } from "../tasks/pr-land-task";
import { type DaemonContext, postThreadNotices } from "./daemon-context";
import { taskResumeDeps } from "./daemon-task-resume";

/** Consecutive failed runs (git or gh could not run) after which a landing is left to the owner (`blocked`). */
const ERRORS_MAX = 3;

/** The landing of a task on a host: its mode, the commit and base branch, and the PR's repository once it is pushed. */
type RemoteAt = { mode: RemoteLandMode; sha: string; baseBranch: string; slug?: string | undefined };
/** One landing's identity: who asked, the commit that was judged and the base branch it goes onto. */
type LandAt = { requestedBy: TaskLandRecord["requestedBy"]; sha: string; baseBranch: string };

/**
 * The PR landing of a reached [TASK] (local, or on a `dispatchHosts` host) in a `lanes.land` pr repository: the landing
 * call (`hook`), the sweep's CI poll (`poll`) and what a run comes to (`tasks.land_json`, thread lines, a worker sent
 * back). Shares `DaemonTaskLanding`'s lock: a landing, a click and a poll never overlap.
 */
export class DaemonTaskPrLand {
	readonly #ctx: DaemonContext;
	readonly #locks: Set<string>;
	readonly #afterDone: (row: TaskRow) => Promise<string[]>;
	/** Consecutive failed runs per task (in memory: a restart starts the count again). */
	readonly #errors = new Map<string, number>();
	/** The last read failure told per task: the same reason is not repeated until a read succeeds. */
	readonly #warned = new Map<string, string>();

	constructor(ctx: DaemonContext, locks: Set<string>, afterDone: (row: TaskRow) => Promise<string[]>) {
		this.#ctx = ctx;
		this.#locks = locks;
		this.#afterDone = afterDone;
	}

	/** The `TaskLandDeps.pr` of one core landing. */
	hook(mode: "auto" | "button", landMode: LaneLandMode | RemoteLandMode): NonNullable<TaskLandDeps["pr"]> {
		return (row, deps) => this.#land(row, deps, mode, landMode);
	}

	/** One poll of a review task's open pull request; a task that is not `active` is left alone. */
	async poll(row: TaskRow): Promise<void> {
		const { taskId } = row;
		if (this.#locks.has(taskId)) return;
		this.#locks.add(taskId);
		try {
			await this.#poll(taskId);
		} catch (error) {
			await this.#failed(taskId, error);
		} finally {
			this.#locks.delete(taskId);
		}
	}

	/** What a task on a `dispatchHosts` host is landed with. */
	#remoteEnv(git: GitRunner): RemoteLandEnv {
		const { options } = this.#ctx;
		return {
			config: options.config,
			run: options.herdrRun,
			tools: this.#tools(),
			git,
			address: options.prLand?.seams?.address,
		};
	}

	#tools(): PrTools {
		return this.#ctx.options.prLand?.tools ?? defaultPrTools;
	}

	/** `remote`: the landing of a task on a host (its worktree and base branch are cleaned up over ssh; `slug` = the PR's repository). */
	#depsOf(row: TaskRow, save: (prLand: LanePrLand) => void, remote?: RemoteAt): PrLandDeps {
		const { tools, seams } = this.#ctx.options.prLand ?? {};
		// The note's content is collected while the worktree still exists.
		const beforeCleanup = async () => {
			await this.#ctx.wikiNotes?.taskDraft(row);
		};
		return prLandDeps({
			seams,
			tools,
			signal: new AbortController().signal,
			removeWorktree: (input) => resolveTaskHost(null, undefined).removeWorktree(input),
			beforeCleanup,
			...(remote === undefined
				? {}
				: {
						worktree: remoteWorktree(this.#remoteEnv(seams?.git ?? defaultGit), row, remote.mode, {
							...remote,
							beforeCleanup,
						}),
					}),
			now: () => this.#ctx.clock.now(),
			save,
		});
	}

	#store() {
		const store = this.#ctx.store;
		if (store === undefined) throw new Error("daemon not started");
		return store.tasks;
	}

	/** The landing call: merge the base branch in, judge the fixed tip again, then open the PR (never a `handoff`). */
	async #land(
		row: TaskRow,
		deps: TaskLandDeps,
		mode: "auto" | "button",
		landMode: LaneLandMode | RemoteLandMode,
	): Promise<TaskLandResult> {
		const requestedBy = mode === "auto" ? "auto" : "owner";
		const tasks = this.#store();
		let latest: LanePrLand | undefined;
		const record = tasks.get(row.taskId)?.land ?? undefined;
		try {
			await deps.stopChecks?.(row.taskId);
			const prepared = isRemoteMode(landMode)
				? await prepareRemote(this.#remoteEnv(deps.git ?? defaultGit), row, landMode, deps)
				: await prepareLocal(row, deps, this.#tools(), landMode.config.remote ?? "origin", record?.prLand);
			if ("stop" in prepared) return this.#stopped(row, prepared.stop);
			const { sha, baseBranch } = prepared;
			if ("rework" in prepared) {
				return await this.#settle(row, { requestedBy, sha, baseBranch }, { kind: "rework", ...prepared.rework });
			}
			let saved = record?.prLand;
			const at: LandAt = { requestedBy, sha, baseBranch };
			// A new commit: the saved step is dropped and the landing starts at the gate again (the PR stays).
			const known = saved?.pushedSha ?? record?.sha;
			if (saved !== undefined && known !== undefined && known !== sha) saved = reworkedPrLand(saved);
			// The owner's resume of a held landing starts its CI wait afresh.
			if (mode === "button" && saved !== undefined && isPollStep(saved))
				saved = { ...saved, pushedAt: this.#ctx.clock.now() };
			latest = saved;
			const outcome = await openPrLanding(
				{
					repo: prepared.repo,
					worktree: row.worktree,
					branch: row.branch,
					baseBranch,
					sha,
					checksHead: sha,
					title: row.title,
					summary: summaryOf(row),
					config: landMode.config,
					denylistFile: landMode.denylistFile,
					frozen: this.#ctx.frozen() !== undefined,
					prLand: saved,
				},
				this.#depsOf(
					row,
					(prLand) => {
						latest = prLand;
						tasks.setLand(row.taskId, { mode: "pr", state: "active", requestedBy, sha, baseBranch, prLand });
					},
					isRemoteMode(landMode) ? { mode: landMode, sha, baseBranch } : undefined,
				),
			);
			this.#errors.delete(row.taskId);
			if (outcome.kind === "waiting" || outcome.kind === "landed") {
				return this.#stopped(row, `PR 열기가 예상 밖의 결과로 끝났습니다: ${outcome.kind}`);
			}
			return await this.#settle(row, at, outcome, latest);
		} catch (error) {
			await this.#failed(row.taskId, error);
			return { state: "blocked", reason: clip(`착지 오류: ${error instanceof Error ? error.message : String(error)}`) };
		}
	}

	/** A landing that stopped before the PR: the record that exists (a landing of an earlier commit) waits for the owner too. */
	#stopped(row: TaskRow, reason: string): TaskLandResult {
		const record = this.#store().get(row.taskId)?.land;
		const clipped = clip(reason);
		if (record) this.#store().setLand(row.taskId, { ...record, state: "blocked", reason: clipped });
		return { state: "blocked", reason: clipped };
	}

	/** Saves what a run came to: `blocked`/`held` wait for the owner (`announce` says why once), `rework` sends the worker back, `pr-open` stays `active`. */
	async #settle(
		row: TaskRow,
		at: LandAt,
		outcome: Exclude<PrLandOutcome, { kind: "waiting" | "landed" }>,
		latest?: LanePrLand,
		announce = false,
	): Promise<TaskLandResult> {
		const tasks = this.#store();
		const record = { mode: "pr", requestedBy: at.requestedBy } as const;
		switch (outcome.kind) {
			case "pr-open": {
				tasks.setLand(row.taskId, {
					...record,
					state: "active",
					sha: at.sha,
					baseBranch: at.baseBranch,
					prLand: outcome.prLand,
				});
				const url = outcome.prLand.url ?? "";
				this.#tell(row, `🔄 PR을 열었습니다 — CI가 초록이면 코어가 squash 머지합니다: ${url}`);
				return { state: "pr-open", url };
			}
			case "blocked":
			case "held": {
				const reason = clip(outcome.reason);
				tasks.setLand(row.taskId, {
					...record,
					state: outcome.kind,
					sha: at.sha,
					baseBranch: at.baseBranch,
					reason,
					prLand: latest ?? tasks.get(row.taskId)?.land?.prLand ?? { branch: row.branch },
				});
				if (announce && tasks.recordNotice(row.taskId, prLandNoticeKey(outcome.kind, at.sha, reason)))
					await postPrLandStop(this.#ctx, row, outcome.kind, reason);
				return { state: "blocked", reason };
			}
			case "rework":
				return this.#rework(row, at, outcome.reason, outcome.notice, outcome.prLand);
		}
	}

	/** The worker works again on the same branch; the landing record keeps the PR (no step, no commit). */
	async #rework(row: TaskRow, at: LandAt, reason: string, notice: string, saved: LanePrLand): Promise<TaskLandResult> {
		const { log, frozen } = this.#ctx;
		const tasks = this.#store();
		const clipped = clip(reason);
		const prLand = reworkedPrLand(saved);
		if ((saved.bounces ?? 0) > BOUNCES_MAX) {
			const stop = `${BOUNCES_MAX}번 반송된 뒤에도 고쳐지지 않음: ${clipped}`;
			tasks.setLand(row.taskId, { mode: "pr", state: "blocked", requestedBy: at.requestedBy, reason: stop, prLand });
			return { state: "blocked", reason: stop };
		}
		tasks.setLand(row.taskId, { mode: "pr", state: "rework", requestedBy: at.requestedBy, reason: clipped, prLand });
		log.info("task_pr_land_rework", { task: row.taskId, reason: clipped });
		this.#tell(row, notice);
		if (frozen() !== undefined) {
			log.warn("task_pr_rework_held_frozen", { task: row.taskId });
			this.#tell(
				row,
				`🔄 ${clipped}. 동결 중이라 워커에 안내를 보내지 않았습니다 — 동결이 풀린 뒤 이 스레드에 지시하세요.`,
			);
			return { state: "rework", reason: clipped };
		}
		try {
			const answer = await resumeTask(taskResumeDeps(this.#ctx, tasks, row), {
				id: row.taskId,
				task: reworkPrompt(row.branch, clipped, notice),
				host: row.host ?? undefined,
			});
			if (answer.startsWith("재개 실패")) this.#tell(row, `⚠️ 워커를 깨우지 못했습니다: ${clip(answer)}`);
		} catch (error) {
			log.warn("task_pr_rework_resume_failed", { task: row.taskId, error: String(error) });
			this.#tell(row, `⚠️ 워커를 깨우지 못했습니다: ${clip(String(error))}`);
		}
		return { state: "rework", reason: clipped };
	}

	/** A one-line notice in the task's thread. */
	#tell(row: TaskRow, text: string): void {
		postThreadNotices(this.#ctx, [row.threadRef], text);
	}

	async #poll(taskId: string): Promise<void> {
		const { log, clock, options, frozen } = this.#ctx;
		const tasks = this.#store();
		const row = tasks.get(taskId);
		const record = row?.land;
		if (row === undefined || row.status !== "review" || record?.state !== "active") return;
		const now = clock.now();
		const { lastPolledAt } = record.prLand;
		if (lastPolledAt !== undefined && now - lastPolledAt < PR_LAND_POLL_MS) return;
		const { sha, baseBranch } = record;
		const at = { requestedBy: record.requestedBy, sha: sha ?? "", baseBranch: baseBranch ?? "" };
		const landMode =
			sha === undefined || baseBranch === undefined ? undefined : await landModeOfRow(options.config, row);
		if (sha === undefined || baseBranch === undefined || landMode?.config.mode !== "pr") {
			const reason =
				sha === undefined || baseBranch === undefined
					? "PR 착지 기록에 커밋·기준 브랜치가 없습니다."
					: "lanes.land 설정이 pr이 아닙니다.";
			await this.#settle(row, at, { kind: "blocked", reason }, record.prLand, true);
			return;
		}
		// A freeze, an owner pause or an apply rollback's hold stops the merge step; the PR is still read.
		const hold = taskLandHold(row, {
			frozen: frozen() !== undefined,
			paused: tasks.isPaused(row),
			hold: record.requestedBy === "auto" ? readAutoLandHold(options.config.homeDir) : undefined,
		});
		let latest = record.prLand;
		const input: PrLandInput = {
			repo: localRepoOf(row, landMode),
			worktree: row.worktree,
			branch: row.branch,
			baseBranch,
			sha,
			checksHead: sha,
			title: row.title,
			summary: summaryOf(row),
			config: landMode.config,
			denylistFile: landMode.denylistFile,
			frozen: hold !== undefined,
			prLand: record.prLand,
		};
		const remote = isRemoteMode(landMode) ? { mode: landMode, sha, baseBranch, slug: record.prLand.slug } : undefined;
		const outcome = await runPrLanding(
			input,
			this.#depsOf(
				row,
				(prLand) => {
					latest = prLand;
					tasks.setLand(taskId, { ...record, prLand });
				},
				remote,
			),
		);
		this.#errors.delete(taskId);
		if (outcome.kind === "waiting") {
			tasks.setLand(taskId, { ...record, prLand: { ...latest, lastPolledAt: now } });
			if (outcome.warn === undefined) this.#warned.delete(taskId);
			else if (this.#warned.get(taskId) !== outcome.warn) {
				this.#warned.set(taskId, outcome.warn);
				log.warn("task_pr_land_read_failed", { task: taskId, reason: outcome.warn });
				this.#tell(row, `⚠️ PR 착지 읽기 실패 · ${outcome.warn}`);
			}
			return;
		}
		if (outcome.kind === "landed") {
			await this.#landed(row, at, outcome, latest);
			return;
		}
		await this.#settle(row, at, outcome, latest, true);
	}

	/** Merged and synced: the task is `done` by the core, its worker and note are closed out, the thread told once. */
	async #landed(row: TaskRow, at: LandAt, outcome: Extract<PrLandOutcome, { kind: "landed" }>, prLand: LanePrLand) {
		const { log, wikiNotes } = this.#ctx;
		const notes = outcome.cleanup === undefined ? [] : [outcome.cleanup];
		try {
			this.#store().transition(
				row.taskId,
				"done",
				"core-land",
				`코어 착지 ${at.baseBranch} ${outcome.mergedSha.slice(0, 12)} (PR)`,
			);
		} catch (error) {
			notes.push(clip(`원장 done 전이 실패: ${error instanceof Error ? error.message : String(error)}`));
		}
		notes.push(...(await this.#afterDone(row)));
		await wikiNotes?.taskDone(row.taskId, [
			`${at.baseBranch}에 PR squash 머지 (${outcome.mergedSha.slice(0, 12)})`,
			`PR ${prLand.url ?? ""}`,
		]);
		const landed: TaskLandResult = {
			state: "landed",
			baseBranch: at.baseBranch,
			sha: outcome.mergedSha,
			pushed: outcome.pushed,
			notes,
		};
		log.info("task_land_landed", { task: row.taskId, mode: "pr", ...landed });
		this.#tell(row, `${taskLandNote(landed)}${prLand.url === undefined ? "" : ` · ${prLand.url}`}`);
	}

	/** A run that threw (git or gh could not run): the step stays saved and the next poll retries; the third in a row waits for the owner. */
	async #failed(taskId: string, error: unknown): Promise<void> {
		const count = (this.#errors.get(taskId) ?? 0) + 1;
		this.#errors.set(taskId, count);
		const text = error instanceof Error ? error.message : String(error);
		this.#ctx.log.warn("task_pr_land_failed", { task: taskId, count, error: text });
		const row = this.#store().get(taskId);
		if (count < ERRORS_MAX || row?.land === null || row === undefined) return;
		this.#errors.delete(taskId);
		const reason = clip(`${count}번 연속 실패: ${text}`);
		this.#store().setLand(taskId, { ...row.land, state: "blocked", reason });
		await postPrLandStop(this.#ctx, row, "blocked", reason);
	}
}
