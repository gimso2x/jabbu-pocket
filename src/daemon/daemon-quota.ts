// 데몬 주기 폴링 및 새 레인·[TASK] 시작 시 프로바이더 쿼터 게이트 검사.
import { type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { readOmpUsage } from "../omp/usage-json";
import {
	DEFAULT_QUOTA_POLL_MINUTES,
	formatHoldRefusal,
	ProviderQuotaGate,
	QUOTA_LIFT_CACHE_MS,
	type QuotaLiftEntry,
	readQuotaLifts,
	writeQuotaGateSnapshot,
} from "../ops/quota-gate";
import { redact } from "../redact";
import type { DaemonContext } from "./daemon-context";

/** 데몬의 프로바이더별 쿼터 게이트 감시자. */
export class DaemonQuotaGate {
	readonly #ctx: DaemonContext;
	readonly #run: ProcessRunner;
	readonly #gate = new ProviderQuotaGate();
	#lastPollAt = Number.NEGATIVE_INFINITY;
	#lastConfigKey: string | undefined;
	#polling = false;
	#wasEnabled = false;
	#liftCheckedAt = Number.NEGATIVE_INFINITY;
	#lifts = new Map<string, QuotaLiftEntry>();

	constructor(ctx: DaemonContext, run: ProcessRunner = realProcessRunner) {
		this.#ctx = ctx;
		this.#run = run;
	}

	/** `sweep()`마다 호출: 비활성이면 즉시 정리하고, 폴링 간격이 지나면 백그라운드로 사용량을 조회한다. */
	maybePoll(): void {
		const config = this.#ctx.options.config;
		const cfg = config.quotaGate;
		if (cfg === undefined || config.agent === "agy") {
			if (this.#wasEnabled || this.#gate.hasHolds) {
				this.#gate.clearAll();
				this.#lastPollAt = Number.NEGATIVE_INFINITY;
				this.#wasEnabled = false;
				this.#saveSnapshot(config.homeDir, this.#ctx.clock.now());
			}
			this.#lastConfigKey = undefined;
			return;
		}
		this.#wasEnabled = true;
		const configKey = JSON.stringify(cfg);
		if (this.#lastConfigKey !== undefined && this.#lastConfigKey !== configKey) {
			this.#lastPollAt = Number.NEGATIVE_INFINITY;
		}
		this.#lastConfigKey = configKey;
		const now = this.#ctx.clock.now();
		const cleared = this.#gate.pruneExpired(now);
		if (cleared.length > 0) {
			for (const provider of cleared) this.#ctx.log.info("quota_gate_cleared", { provider, reason: "reset_elapsed" });
			this.#saveSnapshot(config.homeDir, now);
		}
		const pollMs = (cfg.pollMinutes ?? DEFAULT_QUOTA_POLL_MINUTES) * 60_000;
		if (this.#polling || now - this.#lastPollAt < pollMs) return;
		this.#lastPollAt = now;
		void this.pollNow();
	}

	/** `omp usage --json`을 1회 실행해 게이트 상태와 스냅샷 파일을 갱신한다. */
	async pollNow(): Promise<void> {
		if (this.#polling) return;
		const config = this.#ctx.options.config;
		if (config.quotaGate === undefined || config.agent === "agy") return;
		this.#polling = true;
		try {
			const response = await readOmpUsage({
				executable: config.ompExecutable,
				...(config.ompProfile === undefined ? {} : { profile: config.ompProfile }),
				...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
				env: buildChildEnv({}, withOmpProfile(process.env, config.ompProfile)),
				run: this.#run,
			});
			const afterConfig = this.#ctx.options.config;
			const afterCfg = afterConfig.quotaGate;
			const now = this.#ctx.clock.now();
			if (afterCfg === undefined || afterConfig.agent === "agy") {
				this.#gate.clearAll();
				this.#saveSnapshot(afterConfig.homeDir, now);
				return;
			}
			const { opened, cleared } = this.#gate.updateFromUsage(response, afterCfg, now);
			for (const hold of opened) {
				this.#ctx.log.warn("quota_gate_opened", {
					provider: hold.provider,
					causes: hold.causes.map((cause) => `${cause.label}:${Math.round(cause.usedPct)}%`),
				});
			}
			for (const provider of cleared) this.#ctx.log.info("quota_gate_cleared", { provider, reason: "usage_recovered" });
			this.#saveSnapshot(afterConfig.homeDir, now);
		} catch (error) {
			const now = this.#ctx.clock.now();
			const message = redact(error instanceof Error ? error.message : String(error));
			const cleared = this.#gate.notePollError(message, now);
			for (const provider of cleared) this.#ctx.log.info("quota_gate_cleared", { provider, reason: "reset_elapsed" });
			this.#ctx.log.warn("quota_gate_poll_failed", { error: message });
			this.#saveSnapshot(this.#ctx.options.config.homeDir, now);
		} finally {
			this.#polling = false;
		}
	}

	/** `model`의 프로바이더가 보류 중이고 수동 해제가 없으면 거절 문구를 반환한다. */
	refusalFor(model: string | undefined): string | undefined {
		const config = this.#ctx.options.config;
		if (config.quotaGate === undefined || config.agent === "agy") return undefined;
		const now = this.#ctx.clock.now();
		if (now - this.#liftCheckedAt >= QUOTA_LIFT_CACHE_MS || now < this.#liftCheckedAt) {
			this.#lifts = readQuotaLifts(config.homeDir, now);
			this.#liftCheckedAt = now;
		}
		const hold = this.#gate.checkModel(model, now, this.#lifts);
		return hold === undefined ? undefined : formatHoldRefusal(hold, config.timezone);
	}

	#saveSnapshot(homeDir: string, now: number): void {
		try {
			writeQuotaGateSnapshot(homeDir, this.#gate.snapshot(now));
		} catch (error) {
			this.#ctx.log.warn("quota_gate_snapshot_failed", { error: String(error) });
		}
	}
}
