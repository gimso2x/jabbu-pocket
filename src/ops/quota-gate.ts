// 프로바이더별 쿼터 게이트: 한도에 닿은 프로바이더의 새 레인·[TASK] 시작만 보류하고, 다른 프로바이더와 기존 세션 재개는 허용한다.
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { QuotaGateConfig, QuotaGateMode } from "../config-quota";
import type { UsageLimit, UsageResponse } from "../omp/usage-json";
import { readRegularText, writeAtomic0600 } from "./stamp";

export const DEFAULT_QUOTA_HOLD_PCT = 95;
export const DEFAULT_QUOTA_POLL_MINUTES = 5;
/** `resetsAt`이 없는 한도가 영구 잠금되지 않도록 두는 최대 보류 시간(5시간). */
export const FALLBACK_QUOTA_RELEASE_MS = 5 * 3_600_000;
export const QUOTA_LIFT_CACHE_MS = 2_000;

export interface ProviderHoldCause {
	provider: string;
	label: string;
	windowId?: string;
	usedPct: number;
	releaseAt: number;
}

export interface ProviderHold {
	provider: string;
	causes: readonly ProviderHoldCause[];
}

export interface QuotaLiftEntry {
	provider: string;
	untilMs: number;
	setAt: number;
}

export interface QuotaGateSnapshot {
	updatedAt: number | null;
	mode?: QuotaGateMode;
	lastError?: string;
	held: ProviderHold[];
}

export type QuotaRefusalCheck = (model: string | undefined) => string | undefined;

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

export function quotaGatePath(homeDir: string): string {
	return join(homeDir, "quota-gate.json");
}

export function quotaLiftPath(homeDir: string): string {
	return join(homeDir, "quota-lift.json");
}

/** `"anthropic/claude-opus-5-5:high"` → `"anthropic"`, `/` 없는 모델은 `undefined`(차단 안 함). */
export function providerOfModel(model: string | undefined): string | undefined {
	if (model === undefined) return undefined;
	const trimmed = model.trim();
	if (trimmed === "") return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const colon = trimmed.lastIndexOf(":");
	const base = colon > slash ? trimmed.slice(0, colon) : trimmed;
	const sep = base.indexOf("/");
	if (sep <= 0) return undefined;
	const provider = base.slice(0, sep).trim().toLowerCase();
	return provider === "" ? undefined : provider;
}

/** 사용량 항목의 사용률(0..100); 계산할 수 없으면 `undefined`. */
export function usedPercentOfLimit(limit: UsageLimit): number | undefined {
	if (limit.status === "exhausted") return 100;
	const { amount } = limit;
	if (amount.usedFraction !== undefined && Number.isFinite(amount.usedFraction)) {
		return clampPct(amount.usedFraction * 100);
	}
	if (amount.remainingFraction !== undefined && Number.isFinite(amount.remainingFraction)) {
		return clampPct((1 - amount.remainingFraction) * 100);
	}
	if (amount.limit !== undefined && Number.isFinite(amount.limit) && amount.limit > 0) {
		if (amount.used !== undefined && Number.isFinite(amount.used)) {
			return clampPct((amount.used / amount.limit) * 100);
		}
		if (amount.remaining !== undefined && Number.isFinite(amount.remaining)) {
			return clampPct(((amount.limit - amount.remaining) / amount.limit) * 100);
		}
	}
	if (amount.unit === "percent") {
		if (amount.used !== undefined && Number.isFinite(amount.used)) return clampPct(amount.used);
		if (amount.remaining !== undefined && Number.isFinite(amount.remaining)) return clampPct(100 - amount.remaining);
	}
	return undefined;
}

function causeLabel(limit: UsageLimit): string {
	const windowId = limit.window?.id;
	if (windowId === "5h") return "5시간";
	if (windowId === "7d" || windowId === "1w") return "주간";
	return limit.window?.label ?? limit.label;
}

/** `omp usage --json` 응답에서 기준치 이상인 프로바이더별 보류 원인을 추출한다. */
export function evaluateUsageResponse(
	response: UsageResponse,
	config: QuotaGateConfig,
	now: number,
): Map<string, ProviderHoldCause[]> {
	const holdPct = config.holdPct ?? DEFAULT_QUOTA_HOLD_PCT;
	const allowed =
		config.providers === undefined ? undefined : new Set(config.providers.map((provider) => provider.toLowerCase()));
	const holds = new Map<string, ProviderHoldCause[]>();
	const healthyProviders = new Set<string>();
	for (const report of response.reports) {
		const provider = report.provider.trim().toLowerCase();
		if (provider === "" || (allowed !== undefined && !allowed.has(provider))) continue;
		const reportCauses: ProviderHoldCause[] = [];
		for (const limit of report.limits) {
			const usedPct = usedPercentOfLimit(limit);
			if (usedPct === undefined || usedPct < holdPct) continue;
			const resetsAt = limit.window?.resetsAt;
			if (resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt <= now) continue;
			const releaseAt =
				resetsAt !== undefined && Number.isFinite(resetsAt) ? resetsAt : now + FALLBACK_QUOTA_RELEASE_MS;
			const windowId = limit.window?.id;
			reportCauses.push({
				provider,
				label: causeLabel(limit),
				...(windowId === undefined ? {} : { windowId }),
				usedPct,
				releaseAt,
			});
		}
		if (reportCauses.length > 0) {
			const causes = holds.get(provider) ?? [];
			causes.push(...reportCauses);
			holds.set(provider, causes);
		} else if (report.limits.length > 0) {
			healthyProviders.add(provider);
		}
	}
	for (const provider of healthyProviders) holds.delete(provider);
	return holds;
}

/** 보류 사유를 한국어 1줄 거절 문구로 포맷한다. */
export function formatHoldRefusal(hold: ProviderHold, timezone: string): string {
	const fmt = new Intl.DateTimeFormat("ko-KR", {
		timeZone: timezone,
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const details = hold.causes.map(
		(cause) =>
			`${cause.label} ${Math.round(cause.usedPct)}% 사용 · ${fmt.format(new Date(cause.releaseAt))} 초기화 예정`,
	);
	return `프로바이더 쿼터 보류(${hold.provider}: ${details.join(", ")} — 해제: jabbu-pocket quota lift ${hold.provider})`;
}

function parseLiftRecord(raw: unknown): Map<string, QuotaLiftEntry> {
	const out = new Map<string, QuotaLiftEntry>();
	if (typeof raw !== "object" || raw === null) return out;
	const container = (raw as { lifts?: unknown }).lifts;
	if (typeof container !== "object" || container === null || Array.isArray(container)) return out;
	for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as Partial<QuotaLiftEntry>;
		const provider = (typeof entry.provider === "string" ? entry.provider : key).trim().toLowerCase();
		if (
			provider === "" ||
			typeof entry.untilMs !== "number" ||
			!Number.isFinite(entry.untilMs) ||
			typeof entry.setAt !== "number" ||
			!Number.isFinite(entry.setAt)
		) {
			continue;
		}
		out.set(provider, { provider, untilMs: entry.untilMs, setAt: entry.setAt });
	}
	return out;
}

function readAllLifts(homeDir: string): { exists: boolean; lifts: Map<string, QuotaLiftEntry> } {
	const path = quotaLiftPath(homeDir);
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { exists: false, lifts: new Map() };
	try {
		return { exists: true, lifts: parseLiftRecord(JSON.parse(readRegularText(path))) };
	} catch {
		return { exists: true, lifts: new Map() };
	}
}

/** 유효한(`untilMs > now`) 수동 해제 목록을 읽는다. 파일 없음·파손 시 빈 Map(fail-open). */
export function readQuotaLifts(homeDir: string, now: number): Map<string, QuotaLiftEntry> {
	const { lifts } = readAllLifts(homeDir);
	for (const [provider, entry] of lifts) {
		if (entry.untilMs <= now) lifts.delete(provider);
	}
	return lifts;
}

/** 수동 해제를 기록한다(`provider`는 소문자 또는 `"*"`). */
export function writeQuotaLift(
	homeDir: string,
	input: { provider: string; untilMs: number; now: number },
): QuotaLiftEntry {
	const path = quotaLiftPath(homeDir);
	if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true) {
		throw new Error(`${path}: quota-lift.json is a directory`);
	}
	const provider = input.provider.trim().toLowerCase();
	const lifts = readQuotaLifts(homeDir, input.now);
	const entry: QuotaLiftEntry = { provider, untilMs: input.untilMs, setAt: input.now };
	lifts.set(provider, entry);
	writeAtomic0600(path, `${JSON.stringify({ lifts: Object.fromEntries(lifts) }, null, "\t")}\n`);
	return entry;
}

/** 수동 해제를 지운다(`provider` 생략 시 전체 파일 삭제). 지워진 건수를 반환한다. */
export function clearQuotaLift(homeDir: string, provider?: string): number {
	const path = quotaLiftPath(homeDir);
	const { exists, lifts } = readAllLifts(homeDir);
	if (!exists) return 0;
	if (provider === undefined) {
		const count = Math.max(1, lifts.size);
		rmSync(path, { force: true });
		return count;
	}
	const key = provider.trim().toLowerCase();
	if (!lifts.delete(key)) return 0;
	if (lifts.size === 0) rmSync(path, { force: true });
	else writeAtomic0600(path, `${JSON.stringify({ lifts: Object.fromEntries(lifts) }, null, "\t")}\n`);
	return 1;
}

/** 저장된 쿼터 게이트 스냅샷을 읽고 만료된 원인을 정리한다. */
export function readQuotaGateSnapshot(homeDir: string, now: number): QuotaGateSnapshot {
	const path = quotaGatePath(homeDir);
	if (!existsSync(path)) return { updatedAt: null, held: [] };
	try {
		const parsed = JSON.parse(readRegularText(path)) as Partial<QuotaGateSnapshot>;
		const updatedAt =
			typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null;
		const mode: QuotaGateMode | undefined = parsed.mode === "hold" || parsed.mode === "warn" ? parsed.mode : undefined;
		const lastError = typeof parsed.lastError === "string" && parsed.lastError !== "" ? parsed.lastError : undefined;
		const held: ProviderHold[] = [];
		if (Array.isArray(parsed.held)) {
			for (const entry of parsed.held) {
				if (typeof entry !== "object" || entry === null || typeof entry.provider !== "string") continue;
				const causes = Array.isArray(entry.causes)
					? entry.causes.filter(
							(cause): cause is ProviderHoldCause =>
								typeof cause === "object" &&
								cause !== null &&
								typeof cause.provider === "string" &&
								typeof cause.label === "string" &&
								typeof cause.usedPct === "number" &&
								Number.isFinite(cause.usedPct) &&
								typeof cause.releaseAt === "number" &&
								Number.isFinite(cause.releaseAt) &&
								cause.releaseAt > now,
						)
					: [];
				if (causes.length > 0) held.push({ provider: entry.provider, causes });
			}
		}
		return {
			updatedAt,
			...(mode === undefined ? {} : { mode }),
			...(lastError === undefined ? {} : { lastError }),
			held,
		};
	} catch {
		return { updatedAt: null, held: [] };
	}
}

export function writeQuotaGateSnapshot(homeDir: string, snapshot: QuotaGateSnapshot): void {
	writeAtomic0600(quotaGatePath(homeDir), `${JSON.stringify(snapshot, null, "\t")}\n`);
}

/** 프로바이더별 쿼터 보류 상태 머신. */
export class ProviderQuotaGate {
	readonly #holds = new Map<string, ProviderHoldCause[]>();
	#updatedAt: number | null = null;
	#lastError: string | undefined;

	get hasHolds(): boolean {
		return this.#holds.size > 0;
	}

	updateFromUsage(
		response: UsageResponse,
		config: QuotaGateConfig,
		now: number,
	): { opened: ProviderHold[]; cleared: string[] } {
		const prevHeld = new Set(this.#holds.keys());
		this.pruneExpired(now);
		const allowed =
			config.providers === undefined ? undefined : new Set(config.providers.map((provider) => provider.toLowerCase()));
		if (allowed !== undefined) {
			for (const provider of this.#holds.keys()) {
				if (!allowed.has(provider)) this.#holds.delete(provider);
			}
		}
		const evaluated = evaluateUsageResponse(response, config, now);
		for (const report of response.reports) {
			const provider = report.provider.trim().toLowerCase();
			if (provider === "") continue;
			const next = evaluated.get(provider);
			if (next !== undefined && next.length > 0) this.#holds.set(provider, next);
			else this.#holds.delete(provider);
		}
		this.#updatedAt = now;
		this.#lastError = undefined;
		const opened: ProviderHold[] = [];
		for (const [provider, causes] of this.#holds) {
			if (!prevHeld.has(provider)) opened.push({ provider, causes: [...causes] });
		}
		const cleared = [...prevHeld].filter((provider) => !this.#holds.has(provider));
		return { opened, cleared };
	}

	notePollError(error: string, now: number): string[] {
		this.#lastError = error;
		return this.pruneExpired(now);
	}

	pruneExpired(now: number): string[] {
		const cleared: string[] = [];
		for (const [provider, causes] of this.#holds) {
			const active = causes.filter((cause) => cause.releaseAt > now);
			if (active.length === 0) {
				this.#holds.delete(provider);
				cleared.push(provider);
			} else if (active.length !== causes.length) {
				this.#holds.set(provider, active);
			}
		}
		return cleared;
	}

	clearAll(): void {
		this.#holds.clear();
		this.#lastError = undefined;
	}

	checkModel(
		model: string | undefined,
		now: number,
		lifts?: ReadonlyMap<string, QuotaLiftEntry>,
	): ProviderHold | undefined {
		this.pruneExpired(now);
		const provider = providerOfModel(model);
		if (provider === undefined) return undefined;
		if (lifts !== undefined) {
			const allLift = lifts.get("*");
			if (allLift !== undefined && allLift.untilMs > now) return undefined;
			const providerLift = lifts.get(provider);
			if (providerLift !== undefined && providerLift.untilMs > now) return undefined;
		}
		const causes = this.#holds.get(provider);
		return causes === undefined || causes.length === 0 ? undefined : { provider, causes: [...causes] };
	}

	snapshot(now: number, mode?: QuotaGateMode): QuotaGateSnapshot {
		this.pruneExpired(now);
		const held = [...this.#holds.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, causes]) => ({ provider, causes: [...causes] }));
		return {
			updatedAt: this.#updatedAt,
			...(mode === undefined ? {} : { mode }),
			...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
			held,
		};
	}
}
