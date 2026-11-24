// Text rendering of the status report (the human `ompbot status` lines and a conversation's context line); the
// report types and computation live in ./status, which never renders.

import { isThreadOrigin } from "../core/normalize";
import { chatOriginKey, parseChatOrigin } from "../core/origin-key";
import type { OmpState } from "../omp/driver";
import { formatLocal } from "../time";
import type { MonitorsStatus, OriginStatus, StatusReport } from "./status";

function renderMonitorsLine(monitors: MonitorsStatus, timezone: string): string {
	if (monitors.count === 0) return "모니터 0개";
	const next = monitors.next
		? `다음 발사 ${monitors.next.name} ${formatLocal(Date.parse(monitors.next.at), timezone)} (${timezone})`
		: "다음 발사 없음";
	return `모니터 ${monitors.count}개 · ${next}`;
}

/** One bullet per DM/channel origin; thread sessions collapse into `<channel> × N스레드` so the list stays short. */
function renderOriginLines(origins: readonly OriginStatus[]): string[] {
	const lines: string[] = [];
	const threadsPerChannel = new Map<string, number>();
	for (const o of origins) {
		if (!isThreadOrigin(o.originKey)) {
			lines.push(`• ${o.originKey} epoch=${o.epoch} omp_pid=${o.ompPid ?? "-"} ${o.busy ? "작업 중" : "대기"}`);
			continue;
		}
		const ref = parseChatOrigin(o.originKey);
		if (ref === undefined) continue;
		const channel = chatOriginKey({ platform: ref.platform, kind: ref.kind, conversationId: ref.conversationId });
		threadsPerChannel.set(channel, (threadsPerChannel.get(channel) ?? 0) + 1);
	}
	for (const [channel, count] of threadsPerChannel) lines.push(`• ${channel} × ${count}스레드`);
	return lines;
}

/**
 * First line of a conversation's `!status` / `/status-ompbot`: its context use
 * and model. `idle`: no child runs (its state is read at the next message); `unknown`: the child did not answer.
 */
export function renderContextLine(state: OmpState | "idle" | "unknown"): string {
	const head = "이 대화 컨텍스트:";
	if (state === "idle") return `${head} 세션 쉬는 중(다음 메시지 때 다시 읽음)`;
	const known = state === "unknown" ? undefined : state;
	const model = known?.model === undefined ? "" : ` · 모델 ${known.model}`;
	const context = known?.context;
	if (context === undefined || context.tokens === null) return `${head} 알 수 없음${model}`;
	const kilo = (tokens: number): string => `${Math.round(tokens / 1000).toLocaleString("en-US")}k`;
	const percent = Math.round(context.percent ?? (context.tokens / context.window) * 100);
	return `${head} ${kilo(context.tokens)} / ${kilo(context.window)} (${percent}%)${model}`;
}

/** Short text for `/status-ompbot` and the human `ompbot status` output. */
export function renderStatusText(report: StatusReport): string {
	const { ledger, inbound } = report;
	const lines = [
		`ompbot · omp ${report.ompVersion} · 데몬 ${report.daemonRunning ? "실행 중" : "중지"} · origin ${report.origins.length}개`,
		...renderOriginLines(report.origins),
		`장부 p/i/c/a/e: ${ledger.pending}/${ledger.inflight}/${ledger.confirmed}/${ledger.ambiguous}/${ledger.expired}`,
		`입수 pending=${inbound.pending} dispatched=${inbound.dispatched} answered=${inbound.answered} failed=${inbound.failed_notified} discarded=${inbound.discarded} uncertain=${inbound.uncertain}`,
		renderMonitorsLine(report.monitors, report.timezone),
	];
	if (report.frozen !== undefined) {
		const { since, reason, by } = report.frozen;
		lines.push(
			`FROZEN · ${since} · ${by}${reason === "" ? "" : ` · ${reason}`} · 모니터·위임·새 레인 시작·실행 중 레인 자동 재프롬프트·스킬 리뷰 중지, 오너 대화만 계속 (ompbot unfreeze로 해제)`,
		);
	}
	if (report.drain !== undefined) {
		const { turns, hostTools, approvals } = report.drain;
		lines.push(
			`재시작 대기(drain) 중 · 진행 턴 ${turns} · 호스트 도구 ${hostTools} · 승인 대기 ${approvals} · 새 메시지는 pending`,
		);
	}
	if (report.openGates.length === 0) lines.push("자가진단 게이트 이상 없음");
	else {
		lines.push(`자가진단 게이트 ${report.openGates.length}개 열림`);
		for (const gate of report.openGates) lines.push(`• ${gate.name} ${gate.detail}`);
	}
	return lines.join("\n");
}
