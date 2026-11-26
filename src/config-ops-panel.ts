// `#ops` 고정 상태 패널 및 호스트 부하 히스테리시스 경보 설정(`config.opsPanel`) 검증기.
import { asRecord, invalid, optionalInt } from "./config-validate";

export const DEFAULT_OPS_MIN_REFRESH_SEC = 60;
export const DEFAULT_OPS_SUSTAIN_MINUTES = 5;
export const DEFAULT_OPS_HYSTERESIS_PCT = 10;
export const DEFAULT_OPS_MUTE_MINUTES = 60;
export const DEFAULT_OPS_LOAD_PCT = 200;
export const DEFAULT_OPS_MEM_USED_PCT = 90;
export const DEFAULT_OPS_CGROUP_USED_PCT = 90;

/** Discord `#ops` 고정 상태 패널과 부하 히스테리시스 경보 설정(`config.opsPanel`). */
export interface OpsPanelConfig {
	channelId: string;
	minRefreshSec?: number;
	sustainMinutes?: number;
	hysteresisPct?: number;
	muteMinutes?: number;
	loadPct?: number;
	memUsedPct?: number;
	cgroupUsedPct?: number;
}

const SNOWFLAKE = /^[0-9]{17,20}$/;
const OPS_PANEL_KEYS = new Set([
	"channelId",
	"minRefreshSec",
	"sustainMinutes",
	"hysteresisPct",
	"muteMinutes",
	"loadPct",
	"memUsedPct",
	"cgroupUsedPct",
]);

type OpsIntKey = Exclude<keyof OpsPanelConfig, "channelId">;

/** `opsPanel` 설정 블록을 파싱하고 검증한다. */
export function opsPanelOf(
	configPath: string,
	value: unknown,
	discord?: { logChannelId?: string | undefined },
): OpsPanelConfig | undefined {
	if (value === undefined) return undefined;
	if (discord === undefined) invalid(configPath, "opsPanel");
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "opsPanel");
	for (const key of Object.keys(record)) {
		if (!OPS_PANEL_KEYS.has(key)) invalid(configPath, `opsPanel.${key}`);
	}
	const channelId = record.channelId;
	if (typeof channelId !== "string" || !SNOWFLAKE.test(channelId) || channelId === discord.logChannelId) {
		invalid(configPath, "opsPanel.channelId");
	}
	const intField = (key: OpsIntKey, min: number, max: number): number | undefined => {
		try {
			return optionalInt(configPath, record, key, min, max);
		} catch {
			invalid(configPath, `opsPanel.${key}`);
		}
	};
	const minRefreshSec = intField("minRefreshSec", 60, 3600);
	const sustainMinutes = intField("sustainMinutes", 1, 60);
	const hysteresisPct = intField("hysteresisPct", 1, 50);
	const muteMinutes = intField("muteMinutes", 5, 1440);
	const loadPct = intField("loadPct", 50, 500);
	const memUsedPct = intField("memUsedPct", 50, 99);
	const cgroupUsedPct = intField("cgroupUsedPct", 50, 99);
	return {
		channelId,
		...(minRefreshSec === undefined ? {} : { minRefreshSec }),
		...(sustainMinutes === undefined ? {} : { sustainMinutes }),
		...(hysteresisPct === undefined ? {} : { hysteresisPct }),
		...(muteMinutes === undefined ? {} : { muteMinutes }),
		...(loadPct === undefined ? {} : { loadPct }),
		...(memUsedPct === undefined ? {} : { memUsedPct }),
		...(cgroupUsedPct === undefined ? {} : { cgroupUsedPct }),
	};
}
