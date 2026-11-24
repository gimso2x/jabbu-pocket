import {
	AMBIGUOUS_STUCK_MS,
	BACKUP_MAX_AGE_MS,
	DELIVERY_OVERDUE_MS,
	DRAIN_ORPHANED_MS,
	INBOUND_STARVATION_MS,
	LANE_STUCK_MS,
	MONITOR_FAILURE_WINDOW_MS,
	MONITOR_OVERDUE_MS,
	ORIGIN_SILENT_MS,
	SOCKET_DOWN_MS,
	SWEEP_STALLED_MS,
	TURNS_FAILING_THRESHOLD,
	TURNS_FAILING_WINDOW_MS,
} from "../ops/gates";
import type { JobHealth, JobState, TurnKind, TurnWaitReason } from "./snapshot";

/** HTML-escapes text for the renderers below. Self-contained (shipped to the page). */
export function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** The gate thresholds the screens put into words; shipped to the page as JSON next to the renderers. */
export const GATE_LIMITS = {
	backupMaxAgeMs: BACKUP_MAX_AGE_MS,
	sweepStalledMs: SWEEP_STALLED_MS,
	socketDownMs: SOCKET_DOWN_MS,
	inboundStarvationMs: INBOUND_STARVATION_MS,
	originSilentMs: ORIGIN_SILENT_MS,
	deliveryOverdueMs: DELIVERY_OVERDUE_MS,
	ambiguousStuckMs: AMBIGUOUS_STUCK_MS,
	laneStuckMs: LANE_STUCK_MS,
	monitorFailureWindowMs: MONITOR_FAILURE_WINDOW_MS,
	monitorOverdueMs: MONITOR_OVERDUE_MS,
	turnsFailingWindowMs: TURNS_FAILING_WINDOW_MS,
	turnsFailingThreshold: TURNS_FAILING_THRESHOLD,
	drainOrphanedMs: DRAIN_ORPHANED_MS,
};

/** Words for a turn's kind and wait reason (turn view and its detail); shipped to the page like `GATE_LIMITS`. */
export const TURN_LABELS: { kind: Record<TurnKind, string>; wait: Record<TurnWaitReason, string> } = {
	kind: { message: "대화", command: "명령", auto: "자동 후속", monitor: "모니터" },
	wait: {
		restart: "재시작 대기",
		frozen: "동결 중",
		followup: "팔로업 대기",
		behind: "앞 턴 대기",
		queued: "전달 대기",
	},
};

/**
 * A background job's badge word and tone: its `health`, with `ok` told apart by `state` (running, done or stopped). Shipped to
 * the page like `TURN_LABELS`.
 */
export const JOB_LABELS: Record<Exclude<JobHealth, "ok"> | Exclude<JobState, "failed">, [string, string]> = {
	running: ["진행 중", "is-info"],
	done: ["완료", "is-success"],
	stopped: ["중단", ""],
	failed: ["실패", "is-danger"],
	dead: ["멈춤(프로세스 없음)", "is-danger"],
	stale: ["갱신 끊김", "is-warning"],
	invalid: ["파일 오류", "is-warning"],
};

/** A monitor event stage's word and dot tone (list and panel). Shipped to the page like `TURN_LABELS`. */
export const MONITOR_STAGES: Record<string, [string, string]> = {
	delivered: ["전달", "is-ok"],
	no_report: ["조용히 끝남", "is-quiet"],
	failed: ["실패", "is-fail"],
	failed_no_retry: ["실패", "is-fail"],
	admitted: ["대기", "is-run"],
	dispatched: ["진행 중", "is-run"],
	authored: ["작성됨", "is-run"],
	skipped: ["건너뜀", "is-skip"],
};

/** A settled approval's word and badge tone (list and panel). Shipped to the page like `TURN_LABELS`. */
export const APPROVAL_OUTCOMES: Record<string, [string, string]> = {
	approved: ["승인", "is-success"],
	denied: ["거절", "is-danger"],
	expired: ["만료", "is-warning"],
	replied: ["답장", "is-info"],
};

/** A monitor run's slot-to-settle time: `52초`, `5분 52초`, `6시간 15분`. Shipped to the page. */
export function monitorTook(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}초`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}분 ${seconds % 60}초` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

/**
 * A health gate in words: the owner-facing name, its numbers taken from the gate constants, and the one thing to do
 * (backticks mark commands). A gate not listed keeps its own name. Self-contained apart from `GATE_LIMITS` (both are
 * shipped to the page).
 */
export function gateText(name: string): { label: string; todo: string } {
	const limits = GATE_LIMITS;
	const span = (ms: number): string =>
		ms % 3_600_000 === 0
			? `${ms / 3_600_000}시간`
			: ms % 60_000 === 0
				? `${ms / 60_000}분`
				: `${Math.round(ms / 1000)}초`;
	const TEXT: Record<string, [string, string]> = {
		turns_failing: [
			`최근 ${span(limits.turnsFailingWindowMs)} 턴 실패가 ${limits.turnsFailingThreshold}회 이상`,
			"최근 `turn_failed` 사유를 로그에서 확인",
		],
		lanes_stuck: [
			`레인이 ${span(limits.laneStuckMs)} 넘게 멈춤·머지 대기`,
			"멈춘 레인 스레드에서 이어 가거나 닫기, 머지 대기 레인은 머지·정리하기",
		],
		backup_age: [`백업이 ${span(limits.backupMaxAgeMs)} 넘게 없음`, "백업 타이머·`ompbot backup` 확인"],
		offsite_age: [
			`오프사이트 백업이 ${span(limits.backupMaxAgeMs)} 넘게 없음`,
			"오프사이트 접속·`ompbot backup` 재실행 확인",
		],
		sweep_stalled: [
			`스윕 하트비트가 ${span(limits.sweepStalledMs)} 넘게 멈춤`,
			"`systemctl --user status ompbot`으로 데몬 확인",
		],
		discord_disconnected: [
			`Discord 게이트웨이가 ${span(limits.socketDownMs)} 넘게 끊김`,
			"네트워크·Discord 토큰과 데몬 로그 확인",
		],
		inbound_starved: [`턴이 ${span(limits.inboundStarvationMs)} 넘게 응답 없음`, "`ompbot status`로 멈춘 턴 확인"],
		origin_silent: [`받은 메시지가 ${span(limits.originSilentMs)} 넘게 대기`, "`ompbot status`로 대기 중인 대화 확인"],
		deliveries_overdue: [`전달이 ${span(limits.deliveryOverdueMs)} 넘게 밀림`, "데몬 로그에서 전달 실패 사유 확인"],
		deliveries_ambiguous_stuck: [
			`모호 전달이 ${span(limits.ambiguousStuckMs)} 넘게 남음`,
			"`ompbot deliveries list`로 확인한 뒤 `ack` 또는 `resend`로 정리",
		],
		monitors_failed: [
			`최근 ${span(limits.monitorFailureWindowMs)} 안에 실패한 뒤 아직 성공하지 못한 모니터`,
			"현황판 모니터 화면에서 연속 실패·최근 실행 비고 확인",
		],
		monitors_stalled: [`모니터 실행이 ${span(limits.monitorOverdueMs)} 넘게 밀림`, "모니터 실행·drain 상태 확인"],
		omp_runtime: ["omp 실행 환경 이상", "`omp --version`이 `omp/<버전>`을 내는지 확인"],
		frozen: ["동결 켜짐", "동결 사유 확인 뒤 `ompbot unfreeze`"],
		ledger_unreadable: ["장부(DB)를 읽지 못함", "DB 파일 권한·디스크 확인"],
		herdr_unreachable: ["herdr에 연결하지 못함", "herdr 서버 상태·`herdr.bin` 설정 확인"],
		disk_low: ["디스크 여유 공간 부족", "`df -h` 확인·`ompbot gc`·백업 정리"],
		host_pressure: ["호스트 부하·메모리 압박(시스템·cgroup)", "`uptime`·`free -m`·`systemd-cgtop` 확인"],
		drain_orphaned: [
			`apply가 죽은 뒤 drain이 ${span(limits.drainOrphanedMs)} 넘게 남음(새 메시지 보류 중)`,
			"`ompbot drain --cancel`로 풀고 `ompbot apply` 다시 실행",
		],
		inbound_identity_conflicts: [
			"같은 메시지 id가 다른 내용으로 다시 들어옴(기록만, 막지 않음)",
			"로그의 `inbound_identity_conflict`로 id·길이 확인",
		],
		cost_cap: ["오늘 비용이 하루 상한을 넘음(알림만, 모니터는 계속 돎)", "`!budget`으로 확인, 자정에 닫힘"],
	};
	const known = TEXT[name];
	return known === undefined ? { label: name, todo: "`ompbot gates` 확인" } : { label: known[0], todo: known[1] };
}

/** An alert row in words: its title, the thing to do and, for `gate:` rows, the gate. Shipped to the page. */
export function alertText(scope: string): { title: string; todo: string; gate?: string } {
	const cut = scope.indexOf(":");
	const kind = cut < 0 ? scope : scope.slice(0, cut);
	const rest = scope.slice(cut + 1);
	if (kind === "gate") {
		const text = gateText(rest);
		return { title: text.label, todo: text.todo, gate: rest };
	}
	if (kind === "turns")
		return { title: `대화 턴 연속 실패 · ${rest}`, todo: "최근 `turn_failed` 사유를 로그에서 확인" };
	if (kind === "dispatch") return { title: `턴 전달 실패 · ${rest}`, todo: "데몬 로그에서 전달 재시도 실패 사유 확인" };
	if (scope === "provider:limit") return { title: "모델 공급자 사용 한도", todo: "공급자 사용량·한도 확인" };
	return { title: scope, todo: "`ompbot gates` 확인" };
}

/**
 * A thread's open turns in words: inbound rows steered into one omp run are that run's merged messages, not a queue.
 * Empty for no open turn.
 */
export function openTurnsText(thread: { openCount: number; runCount: number; pendingCount: number }): string {
	const sent = thread.openCount - thread.pendingCount;
	const parts = [
		...(thread.runCount === 0 ? [] : [`실행 ${thread.runCount}`]),
		...(sent > thread.runCount ? [`합쳐진 메시지 ${sent}`] : []),
		...(thread.pendingCount === 0 ? [] : [`대기 ${thread.pendingCount}`]),
	];
	return parts.join(" · ");
}
