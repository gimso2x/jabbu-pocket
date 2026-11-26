// 호스트 부하(CPU 부하율·메모리·cgroup 메모리) 5분 지속 + 10pt 히스테리시스 경보 상태 머신.
import {
	DEFAULT_OPS_CGROUP_USED_PCT,
	DEFAULT_OPS_HYSTERESIS_PCT,
	DEFAULT_OPS_LOAD_PCT,
	DEFAULT_OPS_MEM_USED_PCT,
	DEFAULT_OPS_SUSTAIN_MINUTES,
	type OpsPanelConfig,
} from "../config-ops-panel";
import type { HostPressure } from "./host-resources";

export type LoadMetricKey = "load" | "mem" | "cgroup";

export const LOAD_METRIC_KEYS: readonly LoadMetricKey[] = ["load", "mem", "cgroup"];

/** 단일 시점의 호스트 부하 지표(% 단위; 읽기 불가 시 `null`). */
export interface LoadMetricSample {
	load: number;
	mem: number | null;
	cgroup: number | null;
	load15: number;
	cpus: number;
}

export interface LoadHysteresisPolicy {
	sustainMs: number;
	hysteresisPct: number;
	thresholds: Record<LoadMetricKey, number>;
}

export interface LoadMetricState {
	key: LoadMetricKey;
	phase: "ok" | "pending" | "firing";
	value: number | null;
	threshold: number;
	clearAt: number;
	since?: number;
	firingSince?: number;
	peak?: number;
}

export interface LoadHysteresisSnapshot {
	metrics: Record<LoadMetricKey, LoadMetricState>;
	active: boolean;
	startedAt?: number;
}

export type LoadStepResult = {
	transition: "none" | "fire" | "resolve";
	snapshot: LoadHysteresisSnapshot;
	resolvedPeaks?: Partial<Record<LoadMetricKey, number>>;
	resolvedStartedAt?: number;
};

const clampPct = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

/** `HostPressure` 샘플을 부하 히스테리시스용 % 지표로 변환한다. */
export function sampleLoadMetrics(pressure: HostPressure): LoadMetricSample {
	const cpus = Math.max(1, pressure.cpus);
	const load = Math.max(0, Math.round((pressure.load15 / cpus) * 100));
	const mem = pressure.memAvailableRatio === null ? null : clampPct((1 - pressure.memAvailableRatio) * 100);
	const cgroupFree = [pressure.cgroupHighFreeRatio, pressure.cgroupHardFreeRatio].filter(
		(ratio): ratio is number => ratio !== null,
	);
	const cgroup = cgroupFree.length === 0 ? null : clampPct((1 - Math.min(...cgroupFree)) * 100);
	return { load, mem, cgroup, load15: pressure.load15, cpus };
}

/** `config.opsPanel`에서 지속 시간·히스테리시스·지표별 발화 문턱 정책을 만든다. */
export function loadPolicyFromConfig(cfg: OpsPanelConfig): LoadHysteresisPolicy {
	return {
		sustainMs: (cfg.sustainMinutes ?? DEFAULT_OPS_SUSTAIN_MINUTES) * 60_000,
		hysteresisPct: cfg.hysteresisPct ?? DEFAULT_OPS_HYSTERESIS_PCT,
		thresholds: {
			load: cfg.loadPct ?? DEFAULT_OPS_LOAD_PCT,
			mem: cfg.memUsedPct ?? DEFAULT_OPS_MEM_USED_PCT,
			cgroup: cfg.cgroupUsedPct ?? DEFAULT_OPS_CGROUP_USED_PCT,
		},
	};
}

function defaultMetricState(key: LoadMetricKey): LoadMetricState {
	return { key, phase: "ok", value: null, threshold: 0, clearAt: 0 };
}

function cloneMetricState(state: LoadMetricState): LoadMetricState {
	return {
		key: state.key,
		phase: state.phase,
		value: state.value,
		threshold: state.threshold,
		clearAt: state.clearAt,
		...(state.since === undefined ? {} : { since: state.since }),
		...(state.firingSince === undefined ? {} : { firingSince: state.firingSince }),
		...(state.peak === undefined ? {} : { peak: state.peak }),
	};
}

/** 지속 발화 및 히스테리시스 복구 추적기(단일 지표 또는 복수 지표 동시 발화 지원). */
export class LoadHysteresisTracker {
	#metrics: Record<LoadMetricKey, LoadMetricState>;
	#active: boolean;
	#startedAt: number | undefined;
	#episodePeaks: Partial<Record<LoadMetricKey, number>> = {};

	constructor(initial?: LoadHysteresisSnapshot) {
		this.#metrics = {
			load: defaultMetricState("load"),
			mem: defaultMetricState("mem"),
			cgroup: defaultMetricState("cgroup"),
		};
		this.#active = false;
		if (initial !== undefined) this.restore(initial);
	}

	/** 저장된 스냅샷으로 상태를 복원한다(재시작 후에도 발화·해소 연속성 유지). */
	restore(snapshot: LoadHysteresisSnapshot): void {
		this.#metrics = {
			load: cloneMetricState(snapshot.metrics.load),
			mem: cloneMetricState(snapshot.metrics.mem),
			cgroup: cloneMetricState(snapshot.metrics.cgroup),
		};
		this.#active = snapshot.active;
		this.#startedAt = snapshot.startedAt;
		this.#episodePeaks = {};
		if (this.#active) {
			for (const key of LOAD_METRIC_KEYS) {
				const peak = this.#metrics[key].peak;
				if (this.#metrics[key].phase === "firing" && peak !== undefined) {
					this.#episodePeaks[key] = peak;
				}
			}
		}
	}

	snapshot(): LoadHysteresisSnapshot {
		return {
			metrics: {
				load: cloneMetricState(this.#metrics.load),
				mem: cloneMetricState(this.#metrics.mem),
				cgroup: cloneMetricState(this.#metrics.cgroup),
			},
			active: this.#active,
			...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
		};
	}

	/** 새 샘플을 평가해 상태 전이(`fire`·`resolve`·`none`)와 스냅샷을 반환한다. */
	evaluate(sample: LoadMetricSample, policy: LoadHysteresisPolicy, now: number): LoadStepResult {
		const wasActive = this.#active;
		const prevStartedAt = this.#startedAt;
		for (const key of LOAD_METRIC_KEYS) {
			const prev = this.#metrics[key];
			const value = sample[key];
			const threshold = policy.thresholds[key];
			const clearAt = Math.max(0, threshold - policy.hysteresisPct);
			this.#metrics[key] = this.#stepMetric(prev, value, threshold, clearAt, policy.sustainMs, now);
			const next = this.#metrics[key];
			if (next.phase === "firing" && next.peak !== undefined) {
				const priorPeak = this.#episodePeaks[key];
				this.#episodePeaks[key] = priorPeak === undefined ? next.peak : Math.max(priorPeak, next.peak);
			}
		}
		const anyFiring = LOAD_METRIC_KEYS.some((key) => this.#metrics[key].phase === "firing");
		if (!wasActive && anyFiring) {
			this.#active = true;
			this.#startedAt = now;
			return { transition: "fire", snapshot: this.snapshot() };
		}
		if (wasActive && !anyFiring) {
			const resolvedPeaks = { ...this.#episodePeaks };
			this.#active = false;
			this.#startedAt = undefined;
			this.#episodePeaks = {};
			return {
				transition: "resolve",
				snapshot: this.snapshot(),
				resolvedPeaks,
				...(prevStartedAt === undefined ? {} : { resolvedStartedAt: prevStartedAt }),
			};
		}
		return { transition: "none", snapshot: this.snapshot() };
	}

	#stepMetric(
		prev: LoadMetricState,
		value: number | null,
		threshold: number,
		clearAt: number,
		sustainMs: number,
		now: number,
	): LoadMetricState {
		if (value === null) {
			// 읽기 불가 샘플은 기존 경보·대기 상태를 임의로 해소하거나 초기화하지 않는다.
			return { ...cloneMetricState(prev), value: null, threshold, clearAt };
		}
		if (prev.phase === "ok") {
			if (value < threshold) return { key: prev.key, phase: "ok", value, threshold, clearAt };
			if (sustainMs <= 0) {
				return {
					key: prev.key,
					phase: "firing",
					value,
					threshold,
					clearAt,
					since: now,
					firingSince: now,
					peak: value,
				};
			}
			return { key: prev.key, phase: "pending", value, threshold, clearAt, since: now };
		}
		if (prev.phase === "pending") {
			if (value < threshold) return { key: prev.key, phase: "ok", value, threshold, clearAt };
			const since = prev.since ?? now;
			if (now - since >= sustainMs) {
				return {
					key: prev.key,
					phase: "firing",
					value,
					threshold,
					clearAt,
					since,
					firingSince: now,
					peak: value,
				};
			}
			return { key: prev.key, phase: "pending", value, threshold, clearAt, since };
		}
		// firing 상태: 문턱 - hysteresisPct 이하로 떨어져야만 복구된다.
		const peak = Math.max(prev.peak ?? value, value);
		if (value <= clearAt) return { key: prev.key, phase: "ok", value, threshold, clearAt };
		return {
			key: prev.key,
			phase: "firing",
			value,
			threshold,
			clearAt,
			...(prev.since === undefined ? {} : { since: prev.since }),
			...(prev.firingSince === undefined ? {} : { firingSince: prev.firingSince }),
			peak,
		};
	}
}
