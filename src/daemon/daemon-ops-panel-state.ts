// `#ops` 고정 상태 패널의 영속 상태 직렬화, 레인 집계, 전체 모델 한도 수집기.

import type { Section } from "../dashboard/snapshot";
import { readUsageLimits, type UsageLimitsInfo } from "../dashboard/usage-limits";
import { DiscordCallError } from "../discord/transport";
import { realProcessRunner } from "../dispatch/omp";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { readOmpUsage, type UsageResponse } from "../omp/usage-json";
import {
	LOAD_METRIC_KEYS,
	type LoadHysteresisSnapshot,
	type LoadMetricKey,
	type LoadMetricSample,
} from "../ops/load-hysteresis";
import { formatFullLimitsText, type OpsLanesSummary } from "../ops/ops-panel";
import { type QuotaLiftEntry, readQuotaGateSnapshot, readQuotaLifts } from "../ops/quota-gate";
import { redact } from "../redact";
import type { DaemonContext } from "./daemon-context";
import type { DaemonStore } from "./daemon-store";

export interface PersistedOpsPanelAlert {
	channelId: string;
	messageId: string;
	startedAt: number;
	peaks: Partial<Record<LoadMetricKey, number>>;
	pendingResolve?: {
		resolvedAt: number;
		sample: LoadMetricSample;
		peaks: Partial<Record<LoadMetricKey, number>>;
	};
}

export interface PersistedOpsPanelState {
	version: 1;
	panel?: { channelId: string; messageId: string };
	mutedUntil?: number;
	alert?: PersistedOpsPanelAlert;
	hysteresis?: LoadHysteresisSnapshot;
}

export function isMessageGoneError(err: unknown): boolean {
	return err instanceof DiscordCallError && err.kind === "definitive" && (err.status === 404 || err.code === 10008);
}

export function summarizeLanes(store: DaemonStore | undefined): OpsLanesSummary {
	if (store === undefined) return { working: 0, paused: 0, pendingLand: 0 };
	let working = 0;
	let paused = 0;
	let pendingLand = 0;
	for (const lane of store.listLanes()) {
		if (lane.status === "working") working += 1;
		else if (lane.status === "paused") paused += 1;
		else if (lane.status === "closed" && (lane.meta.land?.state === "pending" || lane.meta.land?.state === "blocked")) {
			pendingLand += 1;
		}
	}
	return { working, paused, pendingLand };
}

function isLoadMetricSnapshotValid(raw: unknown): raw is LoadHysteresisSnapshot {
	if (typeof raw !== "object" || raw === null) return false;
	const s = raw as Partial<LoadHysteresisSnapshot>;
	if (typeof s.active !== "boolean" || typeof s.metrics !== "object" || s.metrics === null) return false;
	for (const key of LOAD_METRIC_KEYS) {
		const m = s.metrics[key] as { phase?: unknown } | undefined;
		if (!m || (m.phase !== "ok" && m.phase !== "pending" && m.phase !== "firing")) return false;
	}
	return true;
}

export function parsePersistedOpsPanelState(raw: string | undefined): {
	state: PersistedOpsPanelState;
	reset: boolean;
} {
	if (raw === undefined) return { state: { version: 1 }, reset: false };
	try {
		const parsed = JSON.parse(raw) as Partial<PersistedOpsPanelState>;
		if (typeof parsed !== "object" || parsed === null || parsed.version !== 1) {
			return { state: { version: 1 }, reset: true };
		}
		const state: PersistedOpsPanelState = { version: 1 };
		if (
			typeof parsed.panel === "object" &&
			parsed.panel !== null &&
			typeof parsed.panel.channelId === "string" &&
			typeof parsed.panel.messageId === "string"
		) {
			state.panel = { channelId: parsed.panel.channelId, messageId: parsed.panel.messageId };
		}
		if (typeof parsed.mutedUntil === "number" && Number.isFinite(parsed.mutedUntil)) {
			state.mutedUntil = parsed.mutedUntil;
		}
		if (
			typeof parsed.alert === "object" &&
			parsed.alert !== null &&
			typeof parsed.alert.channelId === "string" &&
			typeof parsed.alert.messageId === "string" &&
			typeof parsed.alert.startedAt === "number"
		) {
			state.alert = parsed.alert;
		}
		if (isLoadMetricSnapshotValid(parsed.hysteresis)) {
			state.hysteresis = parsed.hysteresis;
		}
		return { state, reset: false };
	} catch {
		return { state: { version: 1 }, reset: true };
	}
}

export async function collectFullLimitsText(ctx: DaemonContext, now: number): Promise<string> {
	const config = ctx.options.config;
	const run = ctx.options.usageLimitsRun ?? realProcessRunner;
	const quota =
		config.quotaGate === undefined ? { updatedAt: null, held: [] } : readQuotaGateSnapshot(config.homeDir, now);
	const lifts =
		config.quotaGate === undefined ? new Map<string, QuotaLiftEntry>() : readQuotaLifts(config.homeDir, now);
	let limits: Section<UsageLimitsInfo> | undefined;
	let ompUsage: UsageResponse | undefined;
	let ompError: string | undefined;

	if (config.dashboard?.usageLimits !== undefined) {
		limits = await readUsageLimits(config.dashboard.usageLimits, run, () => now);
	} else if (config.agent !== "agy") {
		try {
			ompUsage = await readOmpUsage({
				executable: config.ompExecutable,
				...(config.ompProfile === undefined ? {} : { profile: config.ompProfile }),
				...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
				env: buildChildEnv({}, withOmpProfile(process.env, config.ompProfile)),
				run,
			});
		} catch (error) {
			ompError = redact(error instanceof Error ? error.message : String(error));
		}
	}

	return formatFullLimitsText({
		now,
		timezone: config.timezone,
		...(limits === undefined ? {} : { limits }),
		...(ompUsage === undefined ? {} : { ompUsage }),
		...(ompError === undefined ? {} : { ompError }),
		quota,
		lifts,
	});
}
