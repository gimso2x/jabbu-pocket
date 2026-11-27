// `quotaGate` 및 `costCap` 설정 검증기: `config.ts` 줄 수 상한을 지키기 위해 분리한다.
import { asRecord, invalid, optionalInt } from "./config-validate";

/** 프로바이더별 쿼터 게이트 동작 모드: `hold`(새 작업 차단, 기본값) 또는 `warn`(경보·기록 전용). */
export type QuotaGateMode = "hold" | "warn";

/** 프로바이더별 쿼터 게이트 설정(`config.quotaGate`). */
export interface QuotaGateConfig {
	holdPct?: number;
	pollMinutes?: number;
	providers?: string[];
	mode?: QuotaGateMode;
}

const QUOTA_GATE_KEYS = new Set(["holdPct", "pollMinutes", "providers", "mode"]);
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `quotaGate`: `{ holdPct?: 1..100, pollMinutes?: 1..60, providers?: string[], mode?: "hold" | "warn" }`. */
export function quotaGateOf(configPath: string, value: unknown): QuotaGateConfig | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "quotaGate");
	for (const key of Object.keys(record)) {
		if (!QUOTA_GATE_KEYS.has(key)) invalid(configPath, `quotaGate.${key}`);
	}
	const intField = (key: "holdPct" | "pollMinutes", min: number, max: number): number | undefined => {
		try {
			return optionalInt(configPath, record, key, min, max);
		} catch {
			invalid(configPath, `quotaGate.${key}`);
		}
	};
	const holdPct = intField("holdPct", 1, 100);
	const pollMinutes = intField("pollMinutes", 1, 60);
	let providers: string[] | undefined;
	if (record.providers !== undefined) {
		if (
			!Array.isArray(record.providers) ||
			record.providers.length === 0 ||
			record.providers.some((item) => typeof item !== "string" || !PROVIDER_NAME.test(item))
		) {
			invalid(configPath, "quotaGate.providers");
		}
		providers = [...new Set((record.providers as string[]).map((item) => item.toLowerCase()))];
	}
	let mode: QuotaGateMode | undefined;
	if (record.mode !== undefined) {
		if (record.mode !== "hold" && record.mode !== "warn") invalid(configPath, "quotaGate.mode");
		mode = record.mode;
	}
	return {
		...(holdPct === undefined ? {} : { holdPct }),
		...(pollMinutes === undefined ? {} : { pollMinutes }),
		...(providers === undefined ? {} : { providers }),
		...(mode === undefined ? {} : { mode }),
	};
}

/** `costCap`: `{ turnUsd?: >0, dailyUsd?: >0 }`. */
export function costCapOf(configPath: string, value: unknown): { turnUsd?: number; dailyUsd?: number } | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "costCap");
	for (const key of Object.keys(record)) {
		if (key !== "turnUsd" && key !== "dailyUsd") invalid(configPath, `costCap.${key}`);
		const limit = record[key];
		if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)) {
			invalid(configPath, `costCap.${key}`);
		}
	}
	const turnUsd = record.turnUsd as number | undefined;
	const dailyUsd = record.dailyUsd as number | undefined;
	return {
		...(turnUsd === undefined ? {} : { turnUsd }),
		...(dailyUsd === undefined ? {} : { dailyUsd }),
	};
}
