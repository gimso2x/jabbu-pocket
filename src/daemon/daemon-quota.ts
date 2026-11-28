// 데몬 주기 폴링, 새 레인·[TASK] 쿼터 게이트, 한도 오류 대기열 보류 및 여유 회복 자동 해제.
import { classifyFailure } from "../core/failure-kind";
import { type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import type { AgyAccountPool } from "../omp/agy-account-pool";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { readOmpUsage } from "../omp/usage-json";
import {
	DEFAULT_QUOTA_HOLD_PCT,
	DEFAULT_QUOTA_POLL_MINUTES,
	formatHoldRefusal,
	ProviderQuotaGate,
	providerOfModel,
	QUOTA_LIFT_CACHE_MS,
	type QuotaLiftEntry,
	readQuotaLifts,
	writeQuotaGateSnapshot,
} from "../ops/quota-gate";
import {
	parseResetAtMs,
	QUOTA_RECOVERY_CURSOR,
	QuotaRecoveryTracker,
	type QuotaReleaseEvent,
} from "../ops/quota-recovery";
import { buildQuotaResetSnapshot, executeQuotaReset, type QuotaResetSnapshot } from "../ops/quota-reset";
import { redact } from "../redact";
import { type DaemonContext, dispatchPending, postThreadNotices } from "./daemon-context";
import { taskOfOrigin } from "./daemon-task-resume";

/** 데몬의 프로바이더별 쿼터 게이트 및 한도 오류 자동 복구 감시자. */
export class DaemonQuotaGate {
	readonly #ctx: DaemonContext;
	readonly #run: ProcessRunner | undefined;
	readonly #gate = new ProviderQuotaGate();
	readonly #recovery = new QuotaRecoveryTracker();
	readonly #holdNoticed = new Set<string>();
	#loaded = false;
	#lastPollAt = Number.NEGATIVE_INFINITY;
	#lastConfigKey: string | undefined;
	#polling = false;
	#pollPromise: Promise<void> = Promise.resolve();
	#wasEnabled = false;
	#liftCheckedAt = Number.NEGATIVE_INFINITY;
	#lifts = new Map<string, QuotaLiftEntry>();
	#agyPool: AgyAccountPool | undefined;

	constructor(ctx: DaemonContext, run?: ProcessRunner) {
		this.#ctx = ctx;
		this.#run = run;
	}

	/** `agy` 계정 풀을 연결해 `/usage-reset-jabbu`가 차단된 계정도 조회·해제할 수 있게 한다. */
	setAgyPool(pool: AgyAccountPool | undefined): void {
		this.#agyPool = pool;
	}

	/** `/usage-reset-jabbu` 피커·안내 문구용 현재 보류·차단·수동 해제 스냅샷을 반환한다. */
	resetSnapshot(): QuotaResetSnapshot {
		const config = this.#ctx.options.config;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		return buildQuotaResetSnapshot({
			isAgy: config.agent === "agy",
			agyStatus: config.agent === "agy" ? this.#agyPool?.status(now) : undefined,
			runtimeHolds: this.#recovery.listHolds(),
			gateHolds: this.#gate.snapshot(now).held,
			lifts: this.#currentLifts(now),
			timezone: config.timezone,
		});
	}

	/** `/usage-reset-jabbu [arg]`: 현재 상태를 보이거나 전체·개별 프로바이더/agy 차단 보류를 해제한다. */
	async resetUsage(rawArg: string): Promise<string> {
		const config = this.#ctx.options.config;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		return executeQuotaReset({
			rawArg,
			homeDir: config.homeDir,
			now,
			isAgy: config.agent === "agy",
			agyPool: this.#agyPool,
			recovery: this.#recovery,
			gate: this.#gate,
			log: this.#ctx.log,
			resetSnapshot: () => this.resetSnapshot(),
			onClearLifts: () => {
				this.#liftCheckedAt = Number.NEGATIVE_INFINITY;
			},
			onReleaseEvents: (events) => this.#releaseEvents(events),
			onSaveSnapshot: () => this.#saveSnapshot(config.homeDir, now),
			onPollNow: () => {
				void this.pollNow();
			},
		});
	}

	/** 진행 중인 사용량 조회가 끝날 때까지 기다린다(종료 전 store 닫기 동기화용). */
	idle(): Promise<void> {
		return this.#pollPromise;
	}

	/** `sweep()`마다 호출: 수동 해제·상한 만료를 정리하고, 게이트 또는 복구 감시가 필요하면 백그라운드로 조회한다. */
	maybePoll(): void {
		const config = this.#ctx.options.config;
		const cfg = config.quotaGate;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		this.#releaseEvents(this.#recovery.checkLiftsAndExpiry(now, this.#currentLifts(now)));

		if (cfg === undefined || config.agent === "agy") {
			if (this.#wasEnabled || this.#gate.hasHolds) {
				this.#gate.clearAll();
				this.#lastPollAt = Number.NEGATIVE_INFINITY;
				this.#wasEnabled = false;
				this.#saveSnapshot(config.homeDir, now);
			}
			this.#lastConfigKey = undefined;
			if (config.agent !== "agy" && this.#recovery.hasHolds) {
				const defaultPollMs = DEFAULT_QUOTA_POLL_MINUTES * 60_000;
				if (!this.#polling && this.#recovery.shouldProbeNow(now, this.#lastPollAt, defaultPollMs)) {
					this.#lastPollAt = now;
					void this.pollNow();
				}
			}
			return;
		}
		this.#wasEnabled = true;
		const configKey = JSON.stringify(cfg);
		if (this.#lastConfigKey !== undefined && this.#lastConfigKey !== configKey) {
			this.#lastPollAt = Number.NEGATIVE_INFINITY;
		}
		this.#lastConfigKey = configKey;
		const cleared = this.#gate.pruneExpired(now);
		if (cleared.length > 0) {
			for (const provider of cleared) this.#ctx.log.info("quota_gate_cleared", { provider, reason: "reset_elapsed" });
			this.#saveSnapshot(config.homeDir, now);
		}
		const pollMs = (cfg.pollMinutes ?? DEFAULT_QUOTA_POLL_MINUTES) * 60_000;
		const due = now - this.#lastPollAt >= pollMs || this.#recovery.shouldProbeNow(now, this.#lastPollAt, pollMs);
		if (this.#polling || !due) return;
		this.#lastPollAt = now;
		void this.pollNow();
	}

	/** `omp usage --json`을 1회 실행해 게이트 상태와 한도 보류 대기열 복구 여부를 갱신한다. */
	pollNow(): Promise<void> {
		if (this.#polling) return this.#pollPromise;
		const run = this.#runPoll();
		this.#pollPromise = run.catch(() => undefined);
		return run;
	}

	async #runPoll(): Promise<void> {
		const config = this.#ctx.options.config;
		this.#ensureLoaded();
		if (config.agent === "agy" || (config.quotaGate === undefined && !this.#recovery.hasHolds)) return;
		this.#polling = true;
		try {
			const response = await readOmpUsage({
				executable: config.ompExecutable,
				...(config.ompProfile === undefined ? {} : { profile: config.ompProfile }),
				...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
				env: buildChildEnv({}, withOmpProfile(process.env, config.ompProfile)),
				run: this.#run ?? this.#ctx.options.usageLimitsRun ?? realProcessRunner,
			});
			const afterConfig = this.#ctx.options.config;
			const afterCfg = afterConfig.quotaGate;
			const now = this.#ctx.clock.now();
			if (afterConfig.agent === "agy") {
				if (this.#wasEnabled || this.#gate.hasHolds) {
					this.#gate.clearAll();
					this.#wasEnabled = false;
					this.#saveSnapshot(afterConfig.homeDir, now);
				}
				return;
			}
			if (afterCfg !== undefined) {
				const { opened, cleared } = this.#gate.updateFromUsage(response, afterCfg, now);
				for (const hold of opened) {
					this.#ctx.log.warn("quota_gate_opened", {
						provider: hold.provider,
						mode: afterCfg.mode ?? "hold",
						causes: hold.causes.map((cause) => `${cause.label}:${Math.round(cause.usedPct)}%`),
					});
				}
				for (const provider of cleared) {
					this.#ctx.log.info("quota_gate_cleared", { provider, reason: "usage_recovered" });
				}
				this.#saveSnapshot(afterConfig.homeDir, now);
			} else if (this.#wasEnabled || this.#gate.hasHolds) {
				this.#gate.clearAll();
				this.#wasEnabled = false;
				this.#saveSnapshot(afterConfig.homeDir, now);
			}
			const holdPct = afterCfg?.holdPct ?? DEFAULT_QUOTA_HOLD_PCT;
			const recovered = this.#recovery.evaluateUsageRecovery(response, holdPct, now);
			const lifted = this.#recovery.checkLiftsAndExpiry(now, this.#currentLifts(now));
			this.#releaseEvents([...recovered, ...lifted]);
		} catch (error) {
			const now = this.#ctx.clock.now();
			const message = redact(error instanceof Error ? error.message : String(error));
			if (this.#ctx.options.config.quotaGate !== undefined) {
				const cleared = this.#gate.notePollError(message, now);
				for (const provider of cleared) this.#ctx.log.info("quota_gate_cleared", { provider, reason: "reset_elapsed" });
				this.#ctx.log.warn("quota_gate_poll_failed", { error: message });
				this.#saveSnapshot(this.#ctx.options.config.homeDir, now);
			} else {
				this.#ctx.log.warn("quota_recovery_poll_failed", { error: message });
			}
			this.#releaseEvents(this.#recovery.checkLiftsAndExpiry(now, this.#currentLifts(now)));
		} finally {
			this.#polling = false;
		}
	}

	/** 턴·전송이 공급자 한도 오류로 실패했을 때 그 프로바이더의 대기열 자동 보류를 기록한다. */
	noteQuotaError(info: { originKey: string; threadRef: string; model?: string; reason: string }): void {
		const config = this.#ctx.options.config;
		if (config.agent === "agy") return;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		const provider = providerOfModel(info.model) ?? this.#effectiveProvider(info.originKey) ?? "*";
		const classification = classifyFailure(info.reason);
		if (classification.kind === "provider_limit" && classification.limitScope === "rate_limited") {
			this.#ctx.log.info("quota_error_hold_skipped", { provider, origin: info.originKey, reason: "rate_limited" });
			return;
		}
		const resetAt = parseResetAtMs(classification.resetAt, now, config.timezone);
		const recorded = this.#recovery.recordQuotaError({
			provider,
			originKey: info.originKey,
			reason: redact(info.reason),
			...(resetAt === undefined ? {} : { resetAt }),
			now,
		});
		this.#saveRecovery();
		this.#ctx.log.warn("quota_error_hold_opened", {
			provider,
			origin: info.originKey,
			...(resetAt === undefined ? {} : { resetAt }),
		});
		const store = this.#ctx.store;
		if (store === undefined) return;
		if (store.listInbound({ originKey: info.originKey, state: "pending" }).length === 0) return;
		const noticeKey = `${info.originKey}:${recorded.hold.hitAt}`;
		if (this.#holdNoticed.has(noticeKey)) return;
		this.#holdNoticed.add(noticeKey);
		const label = provider === "*" ? "현재 모델" : provider;
		postThreadNotices(
			this.#ctx,
			[info.threadRef],
			`⏸ 공급자 한도(${label})로 대기열을 보류했습니다. 여유 회복이 확인되면 자동 재개합니다(\`/model-jabbu\`로 즉시 전환 가능).`,
		);
	}

	/** 해당 대화방의 유효 모델이 런타임 한도 오류 보류 중이면 안내 문구를 반환한다. */
	holdReasonForOrigin(originKey: string): string | undefined {
		const config = this.#ctx.options.config;
		if (config.agent === "agy") return undefined;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		const lifts = this.#currentLifts(now);
		const provider = this.#effectiveProvider(originKey);
		const hold = this.#recovery.holdForProvider(provider, now, lifts, originKey);
		return hold === undefined ? undefined : this.#recovery.formatOriginHold(hold, config.timezone);
	}

	/** `model`의 프로바이더가 보류 중이고 수동 해제가 없으면 거절 문구를 반환한다. */
	refusalFor(model: string | undefined): string | undefined {
		const config = this.#ctx.options.config;
		if (config.quotaGate === undefined || config.agent === "agy") return undefined;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();
		const lifts = this.#currentLifts(now);
		const effective = model ?? config.model;
		if (config.quotaGate.mode !== "warn") {
			const hold = this.#gate.checkModel(effective, now, lifts);
			if (hold !== undefined) return formatHoldRefusal(hold, config.timezone);
		}
		const runtimeHold = this.#recovery.holdForProvider(providerOfModel(effective), now, lifts);
		return runtimeHold === undefined ? undefined : this.#recovery.formatOriginHold(runtimeHold, config.timezone);
	}

	#currentLifts(now: number): Map<string, QuotaLiftEntry> {
		const homeDir = this.#ctx.options.config.homeDir;
		if (now - this.#liftCheckedAt >= QUOTA_LIFT_CACHE_MS || now < this.#liftCheckedAt) {
			this.#lifts = readQuotaLifts(homeDir, now);
			this.#liftCheckedAt = now;
		}
		return this.#lifts;
	}

	#ensureLoaded(): void {
		if (this.#loaded) return;
		const store = this.#ctx.store;
		if (store === undefined) return;
		this.#loaded = true;
		this.#recovery.restore(store.getCursor(QUOTA_RECOVERY_CURSOR));
	}

	#saveRecovery(): void {
		try {
			this.#ctx.store?.setCursor(QUOTA_RECOVERY_CURSOR, this.#recovery.serialize());
		} catch (error) {
			this.#ctx.log.warn("quota_recovery_save_failed", { error: String(error) });
		}
	}

	#effectiveProvider(originKey: string): string | undefined {
		const store = this.#ctx.store;
		const config = this.#ctx.options.config;
		let model: string | null | undefined;
		if (store !== undefined) {
			model = store.getLaneByOrigin(originKey)?.meta.workerModel ?? taskOfOrigin(store.tasks, originKey)?.workerModel;
			if (model === undefined && originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
				model = store.monitors.getMonitor(originKey.slice(MONITOR_ORIGIN_PREFIX.length))?.model;
			}
			if (model === undefined) {
				model = store.getOrigin(originKey)?.model;
				if (model === null || model === undefined) {
					const threadMark = originKey.indexOf("/t/");
					if (threadMark !== -1) model = store.getOrigin(originKey.slice(0, threadMark))?.model;
				}
			}
		}
		return providerOfModel(model ?? config.model);
	}

	#releaseEvents(events: readonly QuotaReleaseEvent[]): void {
		if (events.length === 0) return;
		this.#saveRecovery();
		const store = this.#ctx.store;
		if (store === undefined) return;
		const pendingRows = store.listInbound({ state: "pending" });
		const reasonByOrigin = new Map<string, QuotaReleaseEvent>();
		for (const event of events) {
			for (const originKey of event.origins) reasonByOrigin.set(originKey, event);
			for (const row of pendingRows) {
				if (event.provider === "*" || this.#effectiveProvider(row.originKey) === event.provider) {
					reasonByOrigin.set(row.originKey, event);
				}
			}
		}
		for (const [originKey, event] of reasonByOrigin) {
			if (this.holdReasonForOrigin(originKey) !== undefined) continue;
			const originPending = pendingRows.filter((row) => row.originKey === originKey);
			this.#ctx.log.info("quota_queue_released", {
				provider: event.provider,
				origin: originKey,
				reason: event.reason,
				pending: originPending.length,
			});
			if (originPending.length === 0) continue;
			const label = event.provider === "*" ? "현재 모델" : event.provider;
			const why = event.reason === "manual_lift" ? "수동 해제로" : "여유 회복을 확인해";
			const lead = originPending[0];
			if (lead !== undefined) {
				postThreadNotices(
					this.#ctx,
					[lead.threadRef],
					`▶️ 공급자 한도(${label}) ${why} 보류 중이던 대기열을 자동 재개합니다.`,
				);
			}
			dispatchPending(this.#ctx, originKey);
		}
	}

	#saveSnapshot(homeDir: string, now: number): void {
		try {
			writeQuotaGateSnapshot(homeDir, this.#gate.snapshot(now, this.#ctx.options.config.quotaGate?.mode));
		} catch (error) {
			this.#ctx.log.warn("quota_gate_snapshot_failed", { error: String(error) });
		}
	}
}
