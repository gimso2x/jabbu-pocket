// `#ops` 패널의 모니터 실패·최근 경보·공급자별 사용량 칸과 그 fingerprint 입력, 임베드 한도 상수.
import { oneLine } from "../channel/text";
import { alertText } from "../dashboard/text";
import { localIso } from "../time";

/** Enabled monitor count and the monitors with an open failure incident (one entry per monitor). */
export interface OpsMonitorsInput {
	total: number;
	failing: Array<{ name: string; count: number; lastAt: number }>;
}

/** One recent incident: `scope` is an alert scope (`gate:backup_age`) or `monitor:<name>`. */
export interface OpsRecentIncident {
	scope: string;
	status: "alerted" | "resolved";
	lastAt: number;
}

/** The most-used limit per provider; `empty` = sources reported nothing, `failed` = the collection errored. */
export type OpsUsageInput =
	| { state: "ok"; rows: Array<{ provider: string; label: string; usedPct: number; resetsAt?: number }> }
	| { state: "empty" }
	| { state: "failed"; error: string };

/** The three optional panel inputs: an omitted one draws no field. */
export interface OpsExtraInput {
	monitors?: OpsMonitorsInput;
	recent?: OpsRecentIncident[];
	usage?: OpsUsageInput;
}

/**
 * Eight fields plus title and body must stay under Discord's 6000-character embed total, so each value and the body
 * are cut here (well under the 1024 field limit) instead of letting the card layer drop trailing fields.
 */
export const PANEL_FIELD_MAX = 680;
export const PANEL_BODY_MAX = 300;
const MONITOR_LINES_MAX = 5;
const RECENT_COUNT = 3;
const USAGE_BAR_CELLS = 10;
const USAGE_FINGERPRINT_STEP_PCT = 5;

/** `방금`, `n분 전`, `n시간 전`, `n일 전`. */
function formatAgo(now: number, at: number): string {
	const sec = Math.max(0, Math.floor((now - at) / 1000));
	if (sec < 60) return "방금";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}분 전`;
	const hours = Math.floor(min / 60);
	return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}

function formatMonitorsField(monitors: OpsMonitorsInput, now: number): string {
	if (monitors.failing.length === 0) return `모두 정상 (${monitors.total}개)`;
	const lines = monitors.failing
		.slice(0, MONITOR_LINES_MAX)
		.map((m) => `⚠️ ${oneLine(m.name, 60)} 실패 ${m.count}회 · ${formatAgo(now, m.lastAt)}`);
	if (monitors.failing.length > MONITOR_LINES_MAX) lines.push(`외 ${monitors.failing.length - MONITOR_LINES_MAX}개`);
	return lines.join("\n");
}

function recentName(scope: string): string {
	return scope.startsWith("monitor:") ? scope.slice("monitor:".length) : alertText(scope).title;
}

function newestRecent(recent: readonly OpsRecentIncident[]): OpsRecentIncident[] {
	return [...recent].sort((a, b) => b.lastAt - a.lastAt).slice(0, RECENT_COUNT);
}

function formatRecentField(recent: readonly OpsRecentIncident[], now: number): string {
	if (recent.length === 0) return "아직 없음";
	return newestRecent(recent)
		.map(
			(r) =>
				`${r.status === "alerted" ? "🔴" : "✅"} ${oneLine(recentName(r.scope), 80)} · ${formatAgo(now, r.lastAt)}`,
		)
		.join("\n");
}

function usageBar(usedPct: number): string {
	const filled = Math.min(USAGE_BAR_CELLS, Math.max(0, Math.round(usedPct / USAGE_BAR_CELLS)));
	return "▰".repeat(filled) + "▱".repeat(USAGE_BAR_CELLS - filled);
}

function formatUsageField(usage: OpsUsageInput, timezone: string): string {
	if (usage.state === "empty") return "보고된 한도 없음";
	if (usage.state === "failed") return "조회 실패";
	return usage.rows
		.map((r) => {
			const reset = r.resetsAt === undefined ? "" : ` · ${localIso(r.resetsAt, timezone).slice(11, 16)}`;
			return `${oneLine(r.provider, 30)} ${oneLine(r.label, 30)} ${usageBar(r.usedPct)} ${Math.round(r.usedPct)}%${reset}`;
		})
		.join("\n");
}

/** The panel's extra fields in order, for the inputs that were given. */
export function extraPanelFields(
	input: OpsExtraInput,
	now: number,
	timezone: string,
): Array<{ label: string; value: string }> {
	const fields: Array<{ label: string; value: string }> = [];
	if (input.monitors !== undefined) fields.push({ label: "🛠️ 모니터", value: formatMonitorsField(input.monitors, now) });
	if (input.recent !== undefined) fields.push({ label: "📮 최근", value: formatRecentField(input.recent, now) });
	if (input.usage !== undefined) fields.push({ label: "🔋 사용량", value: formatUsageField(input.usage, timezone) });
	return fields;
}

/** Input values (not rendered text) for the fingerprint: relative times would change it every minute. */
export function extraFingerprint(input: OpsExtraInput): Record<string, unknown> {
	const step = USAGE_FINGERPRINT_STEP_PCT;
	const monitorsKey =
		input.monitors === undefined
			? undefined
			: { total: input.monitors.total, failing: input.monitors.failing.map((m) => [m.name, m.count, m.lastAt]) };
	const recentKey =
		input.recent === undefined ? undefined : newestRecent(input.recent).map((r) => [r.scope, r.status, r.lastAt]);
	const usageKey =
		input.usage === undefined
			? undefined
			: input.usage.state === "ok"
				? {
						state: "ok",
						rows: input.usage.rows.map((r) => [r.provider, r.label, Math.round(r.usedPct / step) * step, r.resetsAt]),
					}
				: { state: input.usage.state, error: input.usage.state === "failed" ? input.usage.error : undefined };
	return { monitorsKey, recentKey, usageKey };
}
