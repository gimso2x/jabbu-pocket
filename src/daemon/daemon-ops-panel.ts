// Discord `#ops` 고정 상태 패널 주기 갱신·버튼 액션 처리·부하 히스테리시스 경보 오케스트레이터.

import { renderMentions } from "../channel/port";
import { DEFAULT_OPS_MIN_REFRESH_SEC, type OpsPanelConfig } from "../config-ops-panel";
import { hostPressure } from "../ops/host-resources";
import {
	LOAD_METRIC_KEYS,
	type LoadHysteresisSnapshot,
	LoadHysteresisTracker,
	type LoadMetricKey,
	type LoadMetricSample,
	loadPolicyFromConfig,
	sampleLoadMetrics,
} from "../ops/load-hysteresis";
import { type OpsPanelAction, renderLoadAlert, renderLoadResolved, renderOpsPanel } from "../ops/ops-panel";
import { type QuotaGateSnapshot, type QuotaLiftEntry, readQuotaGateSnapshot, readQuotaLifts } from "../ops/quota-gate";
import { redact } from "../redact";
import type { DaemonContext } from "./daemon-context";
import {
	collectFullLimitsText,
	isMessageGoneError,
	type PersistedOpsPanelState,
	parsePersistedOpsPanelState,
	summarizeLanes,
} from "./daemon-ops-panel-state";
import type { StatusReport } from "./status";

export const OPS_PANEL_CURSOR = "ops_panel:state";

const SAME_FINGERPRINT_REFRESH_MS = 5 * 60_000;

/** Discord `#ops` 고정 패널과 부하 히스테리시스 경보 수명주기를 관리한다. */
export class DaemonOpsPanel {
	readonly #ctx: DaemonContext;
	readonly #status: () => StatusReport;
	readonly #tracker = new LoadHysteresisTracker();
	#state: PersistedOpsPanelState = { version: 1 };
	#loaded = false;
	#lastEditAt = 0;
	#lastFingerprint: string | undefined;
	#queue: Promise<void> = Promise.resolve();
	#busy = false;

	constructor(ctx: DaemonContext, deps: { status: () => StatusReport }) {
		this.#ctx = ctx;
		this.#status = deps.status;
	}

	/** 스윕마다 호출: `opsPanel`이 켜져 있고 직렬 작업이 비어 있으면 백그라운드로 갱신한다. */
	maybeTick(): void {
		if (this.#ctx.options.config.opsPanel === undefined || !this.#ctx.adapters.has("discord")) return;
		if (this.#busy) return;
		void this.#runSerialized(() => this.#tick(false)).catch((error: unknown) => {
			this.#ctx.log.warn("ops_panel_tick_failed", { error: String(error) });
		});
	}

	/** 테스트·강제 갱신용: 직렬 큐에서 즉시 1회 평가 및 패널 갱신을 실행한다. */
	async tickNow(forcePanel = false): Promise<void> {
		await this.#runSerialized(() => this.#tick(forcePanel));
	}

	/** 진행 중인 `#ops` 패널 작업이 끝날 때까지 대기한다(종료 시 장부 닫기 전 호출). */
	idle(): Promise<void> {
		return this.#queue;
	}

	/** `#ops` 패널 버튼(`새로고침`·`전체 한도`·`음소거`) 클릭을 처리한다. */
	async handleAction(action: OpsPanelAction, replyEphemeral?: (text: string) => Promise<void>): Promise<void> {
		await this.#runSerialized(async () => {
			const cfg = this.#ctx.options.config.opsPanel;
			if (cfg === undefined || !this.#ctx.adapters.has("discord")) return;
			this.#ensureLoaded();
			const now = this.#ctx.clock.now();
			if (action === "refresh") {
				await this.#tick(true);
				return;
			}
			if (action === "mute") {
				const currentlyMuted = this.#state.mutedUntil !== undefined && this.#state.mutedUntil > now;
				if (currentlyMuted) {
					delete this.#state.mutedUntil;
					this.#ctx.log.info("ops_alert_unmuted", { channel: cfg.channelId });
				} else {
					const muteMinutes = cfg.muteMinutes ?? 60;
					this.#state.mutedUntil = now + muteMinutes * 60_000;
					this.#ctx.log.info("ops_alert_muted", { channel: cfg.channelId, until: this.#state.mutedUntil });
				}
				this.#saveState();
				await this.#tick(true);
				return;
			}
			if (action === "limits") {
				const text = await collectFullLimitsText(this.#ctx, now);
				await replyEphemeral?.(redact(text));
			}
		});
	}

	#runSerialized(fn: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(async () => {
			this.#busy = true;
			try {
				await fn();
			} finally {
				this.#busy = false;
			}
		});
		this.#queue = next.catch(() => {});
		return next;
	}

	#ensureLoaded(): void {
		if (this.#loaded) return;
		const store = this.#ctx.store;
		if (store === undefined) return;
		this.#loaded = true;
		const parsed = parsePersistedOpsPanelState(store.getCursor(OPS_PANEL_CURSOR));
		this.#state = parsed.state;
		if (parsed.reset) this.#ctx.log.warn("ops_panel_state_reset");
		if (this.#state.hysteresis !== undefined) this.#tracker.restore(this.#state.hysteresis);
	}

	#saveState(): void {
		try {
			this.#ctx.store?.setCursor(OPS_PANEL_CURSOR, JSON.stringify(this.#state));
		} catch (error) {
			this.#ctx.log.warn("ops_panel_state_save_failed", { error: String(error) });
		}
	}

	async #tick(forcePanel: boolean): Promise<void> {
		const config = this.#ctx.options.config;
		const cfg = config.opsPanel;
		const discord = config.channels.discord;
		if (cfg === undefined || discord === undefined || !this.#ctx.adapters.has("discord")) return;
		const route = this.#ctx.channels.forConversation(cfg.channelId);
		if (route === undefined) return;
		this.#ensureLoaded();
		const now = this.#ctx.clock.now();

		if (this.#state.mutedUntil !== undefined && this.#state.mutedUntil <= now) {
			delete this.#state.mutedUntil;
		}
		if (this.#state.panel !== undefined && this.#state.panel.channelId !== cfg.channelId) {
			delete this.#state.panel;
			this.#lastEditAt = 0;
			this.#lastFingerprint = undefined;
		}

		await this.#retryPendingResolve(config.timezone);

		const sample = sampleLoadMetrics(hostPressure(this.#ctx.options.hostLoad));
		const policy = loadPolicyFromConfig(cfg);
		const step = this.#tracker.evaluate(sample, policy, now);
		this.#state.hysteresis = step.snapshot;

		if (step.transition === "fire") {
			await this.#onLoadFire(cfg, discord.ownerUserId, config.timezone, sample, step.snapshot, policy, now, route);
		} else if (step.transition === "resolve") {
			await this.#onLoadResolve(config.timezone, sample, step.resolvedStartedAt ?? now, step.resolvedPeaks ?? {}, now);
		} else if (
			step.snapshot.active &&
			this.#state.alert !== undefined &&
			this.#state.alert.pendingResolve === undefined
		) {
			for (const key of LOAD_METRIC_KEYS) {
				const peak = step.snapshot.metrics[key].peak;
				if (peak !== undefined) {
					const prev = this.#state.alert.peaks[key];
					this.#state.alert.peaks[key] = prev === undefined ? peak : Math.max(prev, peak);
				}
			}
		}

		await this.#updatePinnedPanel(cfg, now, sample, step.snapshot, route, forcePanel);
		this.#saveState();
	}

	async #retryPendingResolve(timezone: string): Promise<void> {
		const alert = this.#state.alert;
		const pending = alert?.pendingResolve;
		if (alert === undefined || pending === undefined) return;
		const alertRoute = this.#ctx.channels.forConversation(alert.channelId);
		if (alertRoute === undefined) {
			delete this.#state.alert;
			return;
		}
		try {
			await alertRoute.port.edit(
				{ platform: "discord", conversationId: alert.channelId, messageId: alert.messageId },
				renderLoadResolved({
					timezone,
					startedAt: alert.startedAt,
					resolvedAt: pending.resolvedAt,
					sample: pending.sample,
					resolvedPeaks: pending.peaks,
				}),
			);
			delete this.#state.alert;
		} catch (error) {
			if (isMessageGoneError(error)) delete this.#state.alert;
			else this.#ctx.log.warn("ops_load_resolve_retry_failed", { error: String(error) });
		}
	}

	async #onLoadFire(
		cfg: OpsPanelConfig,
		ownerUserId: string,
		timezone: string,
		sample: LoadMetricSample,
		snapshot: LoadHysteresisSnapshot,
		policy: ReturnType<typeof loadPolicyFromConfig>,
		now: number,
		route: NonNullable<ReturnType<DaemonContext["channels"]["forConversation"]>>,
	): Promise<void> {
		if (this.#state.mutedUntil !== undefined && this.#state.mutedUntil > now) {
			this.#ctx.log.info("ops_load_alert_muted", { channel: cfg.channelId, until: this.#state.mutedUntil });
			return;
		}
		const rawAlert = renderLoadAlert({
			ownerUserId,
			timezone,
			startedAt: snapshot.startedAt ?? now,
			sample,
			snapshot,
			policy,
		});
		const alertMsg = { ...rawAlert, text: renderMentions(rawAlert.text, route.port) };
		const peaks: Partial<Record<LoadMetricKey, number>> = {};
		for (const key of LOAD_METRIC_KEYS) {
			const peak = snapshot.metrics[key].peak;
			if (peak !== undefined) peaks[key] = peak;
		}
		try {
			const ref = await route.port.post(route.target, alertMsg);
			this.#state.alert = {
				channelId: cfg.channelId,
				messageId: ref.messageId,
				startedAt: snapshot.startedAt ?? now,
				peaks,
			};
			this.#ctx.log.warn("ops_load_alert_posted", { channel: cfg.channelId, messageId: ref.messageId });
		} catch (error) {
			this.#ctx.log.warn("ops_load_alert_post_failed", { channel: cfg.channelId, error: String(error) });
		}
	}

	async #onLoadResolve(
		timezone: string,
		sample: LoadMetricSample,
		startedAt: number,
		resolvedPeaks: Partial<Record<LoadMetricKey, number>>,
		now: number,
	): Promise<void> {
		const alert = this.#state.alert;
		if (alert === undefined) return;
		const mergedPeaks: Partial<Record<LoadMetricKey, number>> = { ...alert.peaks };
		for (const key of LOAD_METRIC_KEYS) {
			const p = resolvedPeaks[key];
			if (p !== undefined) mergedPeaks[key] = Math.max(mergedPeaks[key] ?? p, p);
		}
		const alertRoute = this.#ctx.channels.forConversation(alert.channelId);
		if (alertRoute === undefined) {
			delete this.#state.alert;
			return;
		}
		try {
			await alertRoute.port.edit(
				{ platform: "discord", conversationId: alert.channelId, messageId: alert.messageId },
				renderLoadResolved({
					timezone,
					startedAt: alert.startedAt ?? startedAt,
					resolvedAt: now,
					sample,
					resolvedPeaks: mergedPeaks,
				}),
			);
			delete this.#state.alert;
			this.#ctx.log.info("ops_load_alert_resolved", { channel: alert.channelId, messageId: alert.messageId });
		} catch (error) {
			if (isMessageGoneError(error)) {
				delete this.#state.alert;
				return;
			}
			alert.peaks = mergedPeaks;
			alert.pendingResolve = { resolvedAt: now, sample, peaks: mergedPeaks };
			this.#ctx.log.warn("ops_load_resolve_edit_failed", { channel: alert.channelId, error: String(error) });
		}
	}

	async #updatePinnedPanel(
		cfg: OpsPanelConfig,
		now: number,
		sample: LoadMetricSample,
		snapshot: LoadHysteresisSnapshot,
		route: NonNullable<ReturnType<DaemonContext["channels"]["forConversation"]>>,
		forcePanel: boolean,
	): Promise<void> {
		const config = this.#ctx.options.config;
		const quota =
			config.quotaGate === undefined
				? {
						snapshot: { updatedAt: null, held: [] } satisfies QuotaGateSnapshot,
						lifts: new Map<string, QuotaLiftEntry>(),
					}
				: { snapshot: readQuotaGateSnapshot(config.homeDir, now), lifts: readQuotaLifts(config.homeDir, now) };
		const { message, fingerprint } = renderOpsPanel({
			now,
			timezone: config.timezone,
			status: this.#status(),
			lanes: summarizeLanes(this.#ctx.store),
			load: { sample, snapshot },
			quota,
			mutedUntil: this.#state.mutedUntil,
			config: cfg,
		});

		const panel = this.#state.panel;
		if (panel === undefined) {
			await this.#createAndPinPanel(cfg.channelId, route, message, fingerprint, now);
			return;
		}

		const minRefreshMs = Math.max(60_000, (cfg.minRefreshSec ?? DEFAULT_OPS_MIN_REFRESH_SEC) * 1000);
		const elapsed = now - this.#lastEditAt;
		if (!forcePanel && elapsed >= 0 && elapsed < minRefreshMs) return;
		if (!forcePanel && fingerprint === this.#lastFingerprint && elapsed >= 0 && elapsed < SAME_FINGERPRINT_REFRESH_MS) {
			return;
		}

		try {
			await route.port.edit(
				{ platform: "discord", conversationId: panel.channelId, messageId: panel.messageId },
				message,
			);
			this.#lastEditAt = now;
			this.#lastFingerprint = fingerprint;
		} catch (error) {
			if (isMessageGoneError(error)) {
				delete this.#state.panel;
				await this.#createAndPinPanel(cfg.channelId, route, message, fingerprint, now);
				return;
			}
			this.#ctx.log.warn("ops_panel_edit_failed", { channel: cfg.channelId, error: String(error) });
		}
	}

	async #createAndPinPanel(
		channelId: string,
		route: NonNullable<ReturnType<DaemonContext["channels"]["forConversation"]>>,
		message: ReturnType<typeof renderOpsPanel>["message"],
		fingerprint: string,
		now: number,
	): Promise<void> {
		try {
			const ref = await route.port.post(route.target, message);
			this.#state.panel = { channelId, messageId: ref.messageId };
			this.#lastEditAt = now;
			this.#lastFingerprint = fingerprint;
			try {
				await route.port.pin?.(ref);
			} catch (pinError) {
				this.#ctx.log.warn("ops_panel_pin_failed", {
					channel: channelId,
					messageId: ref.messageId,
					error: String(pinError),
				});
			}
		} catch (error) {
			this.#ctx.log.warn("ops_panel_create_failed", { channel: channelId, error: String(error) });
		}
	}
}
