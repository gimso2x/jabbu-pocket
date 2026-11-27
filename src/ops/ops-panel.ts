// `#ops` 고정 상태 패널, 부하 히스테리시스 경보·해소 임베드, 전체 모델 한도 Ephemeral 응답 포매터.
import type { CardTone } from "../channel/card";
import { type ActionButton, mentionToken, type OutboundMessage } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import { DEFAULT_OPS_HYSTERESIS_PCT, DEFAULT_OPS_MUTE_MINUTES, type OpsPanelConfig } from "../config-ops-panel";
import type { StatusReport } from "../daemon/status";
import type { Section } from "../dashboard/snapshot";
import type { UsageLimitsInfo, UsageRow } from "../dashboard/usage-limits";
import { formatLimits, type UsageResponse } from "../omp/usage-json";
import { localIso } from "../time";
import {
	LOAD_METRIC_KEYS,
	type LoadHysteresisPolicy,
	type LoadHysteresisSnapshot,
	type LoadMetricKey,
	type LoadMetricSample,
} from "./load-hysteresis";
import {
	extraFingerprint,
	extraPanelFields,
	type OpsExtraInput,
	PANEL_BODY_MAX,
	PANEL_FIELD_MAX,
} from "./ops-panel-fields";
import type { QuotaGateSnapshot, QuotaLiftEntry } from "./quota-gate";

export const OPS_ACTION_REFRESH = "ops:refresh";
export const OPS_ACTION_LIMITS = "ops:limits";
export const OPS_ACTION_MUTE = "ops:mute";

export type OpsPanelAction = "refresh" | "limits" | "mute";

export interface OpsLanesSummary {
	working: number;
	paused: number;
	pendingLand: number;
}

export interface OpsPanelRenderInput extends OpsExtraInput {
	now: number;
	timezone: string;
	status: StatusReport;
	lanes: OpsLanesSummary;
	load: { sample: LoadMetricSample; snapshot: LoadHysteresisSnapshot };
	quota: { snapshot: QuotaGateSnapshot; lifts: ReadonlyMap<string, QuotaLiftEntry> };
	mutedUntil?: number | undefined;
	config: OpsPanelConfig;
}

export interface LoadAlertRenderInput {
	ownerUserId: string;
	timezone: string;
	startedAt: number;
	sample: LoadMetricSample;
	snapshot: LoadHysteresisSnapshot;
	policy: LoadHysteresisPolicy;
}

export interface LoadResolvedRenderInput {
	timezone: string;
	startedAt: number;
	resolvedAt: number;
	sample: LoadMetricSample;
	resolvedPeaks: Partial<Record<LoadMetricKey, number>>;
}

export interface FullLimitsTextInput {
	now: number;
	timezone: string;
	limits?: Section<UsageLimitsInfo>;
	ompUsage?: UsageResponse;
	ompError?: string;
	quota: QuotaGateSnapshot;
	lifts: ReadonlyMap<string, QuotaLiftEntry>;
}

const METRIC_LABELS: Record<LoadMetricKey, string> = {
	load: "CPU 부하율",
	mem: "메모리",
	cgroup: "cgroup 메모리",
};

const FULL_LIMITS_MAX = 1900;

/** 버튼 custom_id를 `#ops` 패널 액션으로 파싱한다. */
export function parseOpsPanelActionId(actionId: string): OpsPanelAction | undefined {
	if (actionId === OPS_ACTION_REFRESH) return "refresh";
	if (actionId === OPS_ACTION_LIMITS) return "limits";
	if (actionId === OPS_ACTION_MUTE) return "mute";
	return undefined;
}

function formatWallTime(ms: number, timezone: string): string {
	return localIso(ms, timezone).slice(0, 19).replace("T", " ");
}

function formatHhMm(ms: number, timezone: string): string {
	return localIso(ms, timezone).slice(11, 16);
}

function muteButtonLabel(minutes: number): string {
	if (minutes % 60 === 0) return `${minutes / 60}시간 음소거`;
	return `${minutes}분 음소거`;
}

function fmtPct(value: number | null | undefined): string {
	return value === null || value === undefined ? "미확인" : `${value}%`;
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(1, Math.round(ms / 1000));
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min === 0) return `${sec}초`;
	return sec === 0 ? `${min}분` : `${min}분 ${sec}초`;
}

function phaseMarker(phase: "ok" | "pending" | "firing"): string {
	if (phase === "firing") return "🔴";
	if (phase === "pending") return "🟡";
	return "";
}

function formatLoadField(sample: LoadMetricSample, snapshot: LoadHysteresisSnapshot): string {
	const loadMark = phaseMarker(snapshot.metrics.load.phase);
	const memMark = phaseMarker(snapshot.metrics.mem.phase);
	const cgroupMark = phaseMarker(snapshot.metrics.cgroup.phase);
	const stateText = snapshot.active
		? "경보 활성"
		: LOAD_METRIC_KEYS.some((k) => snapshot.metrics[k].phase === "pending")
			? "지속 감지"
			: "정상";
	return [
		`상태: ${stateText}`,
		`CPU: ${sample.load}% (${sample.load15.toFixed(2)}/${sample.cpus})${loadMark ? ` ${loadMark}` : ""}`,
		`메모리: ${fmtPct(sample.mem)}${memMark ? ` ${memMark}` : ""} · cgroup: ${fmtPct(sample.cgroup)}${cgroupMark ? ` ${cgroupMark}` : ""}`,
	].join("\n");
}

function formatQuotaField(
	snapshot: QuotaGateSnapshot,
	lifts: ReadonlyMap<string, QuotaLiftEntry>,
	timezone: string,
): string {
	const lines: string[] = [];
	const warnOnly = snapshot.mode === "warn";
	if (snapshot.held.length === 0) {
		lines.push(warnOnly ? "경보 전용 · 정상" : "모두 열림");
	} else {
		if (warnOnly) lines.push("경보 전용(차단 안 함)");
		for (const hold of snapshot.held) {
			const causes = hold.causes.map((c) => `${c.label} ${Math.round(c.usedPct)}%`).join(", ");
			lines.push(`• ${hold.provider}: ${causes}`);
		}
	}
	if (lifts.size > 0) {
		const lifted = [...lifts.values()]
			.sort((a, b) => a.provider.localeCompare(b.provider))
			.map((l) => `${l.provider}(~${formatHhMm(l.untilMs, timezone)})`);
		lines.push(`수동 해제: ${lifted.join(", ")}`);
	}
	if (snapshot.lastError !== undefined) lines.push("최근 폴링 오류");
	return lines.join("\n");
}

/** Discord `#ops` 고정 상태 패널 임베드와 중복 갱신 방지용 fingerprint를 생성한다. */
export function renderOpsPanel(input: OpsPanelRenderInput): { message: OutboundMessage; fingerprint: string } {
	const { status, lanes, load, quota, timezone, now, config } = input;
	const muted = input.mutedUntil !== undefined && input.mutedUntil > now;
	const hasPendingLoad = LOAD_METRIC_KEYS.some((key) => load.snapshot.metrics[key].phase === "pending");
	const tone: CardTone =
		load.snapshot.active || status.openGates.length > 0
			? "danger"
			: hasPendingLoad ||
					quota.snapshot.held.length > 0 ||
					status.frozen !== undefined ||
					status.drain !== undefined ||
					muted ||
					(input.monitors?.failing.length ?? 0) > 0
				? "warn"
				: "ok";
	const titlePrefix = tone === "danger" ? "🔴" : tone === "warn" ? "🟡" : "🟢";
	const title = `${titlePrefix} jabbu 운영 상태 패널`;

	const statusNotes: string[] = [];
	if (status.frozen !== undefined) statusNotes.push(`❄️ FROZEN (${status.frozen.reason || "사유 없음"})`);
	if (status.drain !== undefined) {
		const { turns, hostTools, approvals } = status.drain;
		statusNotes.push(`⏳ drain (턴 ${turns} · 도구 ${hostTools} · 승인 ${approvals})`);
	}
	if (muted && input.mutedUntil !== undefined) {
		statusNotes.push(`🔕 부하 경보 음소거 (~${formatHhMm(input.mutedUntil, timezone)})`);
	}
	const body = cutCodePointSafe(statusNotes.length === 0 ? "정상 가동 중" : statusNotes.join(" · "), PANEL_BODY_MAX);

	const activeTurns = status.origins.filter((o) => o.busy).length;
	const hostSess = status.hostSessions
		? `${status.hostSessions.count ?? "?"}/${status.hostSessions.ceiling || "무제한"}`
		: "-";
	const sessionsField = [
		`활성 턴 ${activeTurns} · 호스트 세션 ${hostSess}`,
		`레인 진행 ${lanes.working} · 멈춤 ${lanes.paused} · 머지 대기 ${lanes.pendingLand}`,
		`인바운드 대기 ${status.inbound.pending} · 실행 ${status.inbound.dispatched} · 장부 대기 ${status.ledger.pending}`,
	].join("\n");

	const gatesField =
		status.openGates.length === 0
			? "모두 닫힘"
			: `${status.openGates.length}개 열림: ${status.openGates.map((g) => g.name).join(", ")}`;

	const loadField = formatLoadField(load.sample, load.snapshot);
	const quotaField = formatQuotaField(quota.snapshot, quota.lifts, timezone);
	const muteMinutes = config.muteMinutes ?? DEFAULT_OPS_MUTE_MINUTES;
	const buttons: ActionButton[] = [
		{ actionId: OPS_ACTION_REFRESH, label: "새로고침", style: "primary" },
		{ actionId: OPS_ACTION_LIMITS, label: "전체 한도" },
		{
			actionId: OPS_ACTION_MUTE,
			label: muted ? "음소거 해제" : muteButtonLabel(muteMinutes),
			...(muted ? { style: "danger" as const } : {}),
		},
	];

	const fields: Array<{ label: string; value: string }> = [
		{ label: "호스트 부하", value: loadField },
		{ label: "세션 · 작업", value: sessionsField },
		{ label: "건강 게이트", value: gatesField },
		{ label: "쿼터 게이트", value: quotaField },
	];
	fields.push(...extraPanelFields(input, now, timezone));
	fields.push({ label: "갱신 시각", value: `${formatWallTime(now, timezone)} (${timezone})` });

	const message: OutboundMessage = {
		text: "",
		title,
		body,
		tone,
		fields: fields.map((f) => ({ label: f.label, value: cutCodePointSafe(f.value, PANEL_FIELD_MAX) })),
		buttons,
	};

	const fingerprint = JSON.stringify({
		tone,
		body,
		loadField,
		sessionsField,
		gatesField,
		quotaField,
		buttons: buttons.map((b) => ({ actionId: b.actionId, label: b.label })),
		...extraFingerprint(input),
	});
	return { message, fingerprint };
}

/** 5분 이상 문턱을 넘었을 때 `#ops`에 올리는 오너 핑 부하 경보 메시지를 만든다. */
export function renderLoadAlert(input: LoadAlertRenderInput): OutboundMessage {
	const firing = LOAD_METRIC_KEYS.map((key) => input.snapshot.metrics[key]).filter((m) => m.phase === "firing");
	const firingNames = firing.map((m) => METRIC_LABELS[m.key]);
	const firingLines = firing.map(
		(m) => `• ${METRIC_LABELS[m.key]}: ${fmtPct(m.value)} (문턱 ${m.threshold}% · 복구 <=${m.clearAt}%)`,
	);
	const { sample, policy } = input;
	const sustainMin = Math.max(1, Math.round(policy.sustainMs / 60_000));
	const hysteresis = policy.hysteresisPct || DEFAULT_OPS_HYSTERESIS_PCT;
	return {
		text: `${mentionToken(input.ownerUserId)} 호스트 부하 경보 (${firingNames.join(", ")})`,
		title: "🚨 호스트 부하 경보",
		tone: "danger",
		body: `${sustainMin}분 이상 문턱을 넘었습니다. 모든 지표가 문턱 -${hysteresis}pt 이하로 내려오면 이 메시지가 resolved로 바뀝니다.`,
		fields: [
			{ label: "발화 지표", value: firingLines.join("\n") || "-" },
			{
				label: "현재 측정",
				value: `CPU ${sample.load}% (${sample.load15.toFixed(2)}/${sample.cpus}) · 메모리 ${fmtPct(sample.mem)} · cgroup ${fmtPct(sample.cgroup)}`,
			},
			{ label: "발화 시각", value: `${formatWallTime(input.startedAt, input.timezone)} (${input.timezone})` },
		],
	};
}

/** 부하 해소 시 기존 경보 메시지를 제자리 수정할 `resolved` 임베드를 만든다. */
export function renderLoadResolved(input: LoadResolvedRenderInput): OutboundMessage {
	const peakLines = LOAD_METRIC_KEYS.flatMap((key) => {
		const peak = input.resolvedPeaks[key];
		return peak === undefined ? [] : [`• ${METRIC_LABELS[key]}: 최고 ${peak}%`];
	});
	const { sample } = input;
	const elapsed = formatDuration(Math.max(0, input.resolvedAt - input.startedAt));
	return {
		text: "✅ 호스트 부하 경보 해소 (resolved)",
		title: "✅ 호스트 부하 경보 — resolved",
		tone: "ok",
		body: "모든 부하 지표가 히스테리시스 복구 기준 이하로 내려왔습니다.",
		fields: [
			{ label: "최고치", value: peakLines.length === 0 ? "-" : peakLines.join("\n") },
			{
				label: "현재 측정",
				value: `CPU ${sample.load}% (${sample.load15.toFixed(2)}/${sample.cpus}) · 메모리 ${fmtPct(sample.mem)} · cgroup ${fmtPct(sample.cgroup)}`,
			},
			{
				label: "지속 · 해소",
				value: `${elapsed} 지속 · ${formatWallTime(input.resolvedAt, input.timezone)} 해소`,
			},
		],
	};
}

function formatUsageRows(rows: readonly UsageRow[], timezone: string): string[] {
	return rows.map((row) => {
		const reset = row.resetsAt === undefined ? "" : ` · ${formatWallTime(row.resetsAt, timezone)} 초기화`;
		return `• ${row.label} (${row.windowLabel}) ${row.remainingPct}% 남음${reset}`;
	});
}

/** `전체 한도` 버튼 클릭 시 Ephemeral로 돌려줄 전체 프로바이더 한도와 쿼터 게이트 요약을 만든다. */
export function formatFullLimitsText(input: FullLimitsTextInput): string {
	const lines: string[] = [`📊 전체 모델 한도 (${formatWallTime(input.now, input.timezone)} · ${input.timezone})`, ""];
	if (input.limits !== undefined) {
		if (!input.limits.ok) {
			lines.push(`• 한도 조회 실패: ${input.limits.error}`);
		} else if (input.limits.sources.length === 0) {
			lines.push("• 설정된 한도 조회 소스가 없습니다.");
		} else {
			for (const source of input.limits.sources) {
				const header = source.account ? `${source.name} (${source.account})` : source.name;
				lines.push(header);
				if (source.accounts !== undefined && source.accounts.length > 0) {
					for (const acct of source.accounts) {
						const tag = acct.active ? `${acct.name} (활성)` : acct.name;
						if (!acct.ok) lines.push(`• ${tag}: 실패 (${acct.error})`);
						else
							for (const rowLine of formatUsageRows(acct.rows, input.timezone))
								lines.push(`  [${tag}] ${rowLine.slice(2)}`);
					}
				} else if (!source.ok) {
					lines.push(`• 조회 실패: ${source.error}`);
				} else {
					lines.push(...formatUsageRows(source.rows, input.timezone));
				}
				lines.push("");
			}
		}
	} else if (input.ompUsage !== undefined) {
		lines.push(formatLimits(input.ompUsage), "");
	} else if (input.ompError !== undefined) {
		lines.push(`• OMP 한도 조회 실패: ${input.ompError}`, "");
	} else {
		lines.push("• 설정된 모델 한도 조회 명령이 없습니다.", "");
	}

	lines.push("쿼터 게이트");
	if (input.quota.held.length === 0) {
		lines.push("• 보류 없음 (모두 열림)");
	} else {
		for (const hold of input.quota.held) {
			const detail = hold.causes
				.map((c) => `${c.label} ${Math.round(c.usedPct)}% (~${formatWallTime(c.releaseAt, input.timezone)})`)
				.join(", ");
			lines.push(`• ${hold.provider}: ${detail}`);
		}
	}
	if (input.lifts.size > 0) {
		const lifted = [...input.lifts.values()]
			.sort((a, b) => a.provider.localeCompare(b.provider))
			.map((l) => `${l.provider} (~${formatWallTime(l.untilMs, input.timezone)})`);
		lines.push(`• 수동 해제: ${lifted.join(", ")}`);
	}
	if (input.quota.lastError !== undefined) {
		lines.push(`• 최근 게이트 폴링 오류: ${input.quota.lastError}`);
	}
	return cutCodePointSafe(lines.join("\n").trim(), FULL_LIMITS_MAX);
}
