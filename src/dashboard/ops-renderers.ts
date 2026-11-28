import { renderActiveCards } from "./p0-renderers";
import type { PeerHealthInfo } from "./peer-health";
import type { DashboardSnapshot } from "./snapshot";
import { esc } from "./text";

export { renderTurnsView } from "./channel-board";
export {
	channelDisplayTitle,
	effectiveLaneColumn,
	isChannelMainOrigin,
	isLaneOriginKey,
	laneLandBadge,
} from "./channel-meta";

/**
 * Self-contained operational UX renderers shipped into `SCRIPT` (`html.ts`) beside `renderDashboardMain`.
 * Keep every function free of module-level imports other than `esc` (already shipped in `SCRIPT`).
 */

/** Header herdr machines: connected ok, offline WITH an open TASK stays red, idle offline machines fold into one quiet pill. */
export function renderInboxMachines(
	machines: Array<{ id: string; name: string; connected: boolean }>,
	openTaskHosts: string[],
	badge: (text: string, tone: string) => string,
): string {
	const out: string[] = [];
	const idleOff: string[] = [];
	for (const m of machines) {
		if (m.connected) {
			out.push(`<span class="host-ok"><i class="sys-dot is-success" aria-hidden="true"></i>${esc(m.name)}</span>`);
			continue;
		}
		const busy =
			openTaskHosts.includes(m.name) ||
			openTaskHosts.includes(m.id) ||
			(m.id === "local" && openTaskHosts.includes("local"));
		if (busy) out.push(badge(`${m.name} · 끊김`, "is-danger"));
		else idleOff.push(m.name);
	}
	if (idleOff.length > 0) {
		out.push(
			`<span class="host-off" title="${esc(`오프라인: ${idleOff.join(", ")}`)}">오프라인 ${idleOff.length}</span>`,
		);
	}
	return out.length === 0 ? "" : `<div class="badges">${out.join("")}</div>`;
}

/** Formats herdr machines for the `시스템` card: idle offline devices fold quietly without triggering a warning. */
export function renderSystemMachines(
	machines: Array<{ id: string; name: string; connected: boolean }>,
	openTaskHosts: string[],
	badge: (text: string, tone: string) => string,
): { html: string; busyDown: boolean } {
	const out: string[] = [];
	const idleOff: string[] = [];
	let busyDown = false;
	for (const m of machines) {
		if (m.connected) {
			out.push(badge(`${m.name} · 연결`, ""));
			continue;
		}
		const busy =
			openTaskHosts.includes(m.name) ||
			openTaskHosts.includes(m.id) ||
			(m.id === "local" && openTaskHosts.includes("local"));
		if (busy) {
			busyDown = true;
			out.push(badge(`${m.name} · 끊김`, "is-danger"));
		} else {
			idleOff.push(m.name);
		}
	}
	if (idleOff.length > 0) {
		out.push(
			`<span class="host-off" title="${esc(`오프라인: ${idleOff.join(", ")}`)}">오프라인 ${idleOff.length}</span>`,
		);
	}
	return { html: out.join(" ") || "머신 없음", busyDown };
}

/** Quick bot & attention filter strip at the top of the `턴` view when peer installs or attention items exist. */
export function renderTurnBotFilters(threads: Array<{ column: string; install?: string }>, activeBot: string): string {
	const peers: string[] = [];
	let attention = 0;
	for (const t of threads) {
		if (t.column === "attention") attention += 1;
		if (t.install && !peers.includes(t.install)) peers.push(t.install);
	}
	if (peers.length === 0 && attention === 0) return "";
	const countFor = (key: string): number =>
		key === ""
			? threads.length
			: key === "own"
				? threads.filter((t) => !t.install).length
				: key === "attention"
					? attention
					: threads.filter((t) => t.install === key).length;
	const items: Array<[string, string, boolean]> = [
		["", "전체", false],
		...(peers.length > 0 ? [["own", "본체", false] as [string, string, boolean]] : []),
		...peers.map((p): [string, string, boolean] => [p, p, false]),
		...(attention > 0 ? [["attention", "확인 필요", true] as [string, string, boolean]] : []),
	];
	return `<div class="badges turn-filters" role="group" aria-label="봇·상태 필터">${items
		.map(
			([key, label, warn]) =>
				`<button type="button" class="chip${warn ? " is-warn" : ""}" data-turn-bot="${esc(key)}" aria-pressed="${
					activeBot === key
				}">${esc(label)} <b>${countFor(key)}</b></button>`,
		)
		.join("")}</div>`;
}

/** `시스템` view card showing live health, 24h turn counts, open alerts, and AGY quota account per peer bot. */
export function renderPeerBotsCard(
	peers: PeerHealthInfo[],
	dur: (ms: number | null | undefined) => string,
	badge: (text: string, tone: string) => string,
): { level: "ok" | "warn" | "bad"; html: string } {
	let level: "ok" | "warn" | "bad" = "ok";
	const rows = peers
		.map((p) => {
			const bad = !p.running || p.discord === "down" || p.error !== undefined;
			const warn = !bad && (p.openAlerts > 0 || (p.turns24h?.failed ?? 0) > 0 || p.draining === true);
			if (bad) level = "bad";
			else if (warn && level === "ok") level = "warn";
			const stateWord = !p.running ? "꺼짐" : p.draining ? "재시작 중" : "켜짐";
			const stateTone = !p.running ? "is-danger" : p.draining ? "is-warning" : "is-success";
			const parts = [
				p.discord === undefined ? "" : `Discord ${p.discord === "up" ? "연결" : "끊김"}`,
				p.turns24h === undefined
					? ""
					: `24h 답 ${p.turns24h.answered}${p.turns24h.open > 0 ? ` · 진행 ${p.turns24h.open}` : ""}${
							p.turns24h.failed > 0 ? ` · 실패 ${p.turns24h.failed}` : ""
						}`,
				p.openAlerts > 0 ? `알림 ${p.openAlerts}` : "",
				p.heartbeatAgeMs === undefined ? "" : `하트비트 ${dur(p.heartbeatAgeMs)} 전`,
				p.agyAccount
					? `AGY ${p.agyAccount.current}${p.agyAccount.blockedCount > 0 ? ` (차단 ${p.agyAccount.blockedCount})` : ""}`
					: "",
				p.error ?? "",
			].filter((x) => x !== "");
			return `<div class="peer-row"><div class="peer-head"><b>${esc(p.name)}</b><span class="badges">${badge(
				stateWord,
				stateTone,
			)}${p.openAlerts > 0 ? badge(`알림 ${p.openAlerts}`, "is-warning") : ""}${
				(p.turns24h?.failed ?? 0) > 0 ? badge(`실패 ${p.turns24h?.failed}`, "is-warning") : ""
			}</span></div><p class="row-sub">${esc(parts.join(" · ") || "-")}</p></div>`;
		})
		.join("");
	return { level, html: `<div class="peer-list">${rows}</div>` };
}

/** Rich live pulse shown in `인박스` when no herdr board cards or open TASKs occupy the 4 columns. */
export function renderInboxPulse(
	s: DashboardSnapshot,
	closedTasks: Array<{ taskId: string; title: string; statusLabel: string; closedAt: string }>,
	badge: (text: string, tone: string) => string,
	ago: (since: number) => string,
	at: (iso: string | null | undefined) => string,
	alertTitle: (scope: string) => string,
	dur: (ms: number | null | undefined) => string = (ms) =>
		ms === null || ms === undefined ? "-" : `${Math.max(0, Math.floor(ms / 60_000))}분`,
): string {
	const threads = s.turns.ok ? s.turns.threads : [];
	const workingThreads = threads.filter((t) => t.column === "working");
	const attnThreads = threads.filter((t) => t.column === "attention");
	const runningJobs = s.jobs.ok ? s.jobs.items.filter((j) => j.state === "running" && j.health !== "dead") : [];
	const pendingApprovals = s.approvals.ok ? s.approvals.items : [];
	const openAlerts = s.alerts.ok ? s.alerts.items.filter((a) => a.gateState === "open") : [];
	const badMonitors = s.monitors.ok ? s.monitors.items.filter((m) => m.failStreak > 0 || m.openIncidents > 0) : [];

	const attnTotal = attnThreads.length + pendingApprovals.length + openAlerts.length + badMonitors.length;
	const workingTotal = workingThreads.length + runningJobs.length;
	const costDays = s.costLedger?.ok ? s.costLedger.days : [];
	const todayCost = costDays.length > 0 ? costDays[costDays.length - 1]?.cost : undefined;
	const costText =
		todayCost === undefined
			? s.daemon.ok
				? `대화 ${s.daemon.origins}개`
				: "-"
			: `$${todayCost.toFixed(todayCost >= 100 ? 0 : 2)}`;
	const nextMonitor = s.monitors.ok ? s.monitors.items.find((m) => m.nextFireAt !== null) : undefined;
	const nextMon = nextMonitor?.nextFireAt
		? `${nextMonitor.nextFireAt.slice(11, 16)} ${nextMonitor.name}`
		: s.daemon.ok && s.daemon.monitors.next
			? `${s.daemon.monitors.next.at.slice(11, 16)} ${s.daemon.monitors.next.name}`
			: "예정 없음";

	const kpi = `<div class="pulse-kpi"><a class="pulse-stat" href="?view=turns" data-view="turns"><span>진행 중</span><b>${workingTotal}건</b></a><a class="pulse-stat${
		attnTotal > 0 ? " is-warn" : ""
	}" href="${attnThreads.length > 0 ? "?view=turns" : openAlerts.length > 0 ? "?view=alerts" : "?view=approvals"}" data-view="${
		attnThreads.length > 0 ? "turns" : openAlerts.length > 0 ? "alerts" : "approvals"
	}"><span>확인 필요</span><b>${attnTotal}건</b></a><a class="pulse-stat" href="?view=system" data-view="system"><span>${
		todayCost === undefined ? "활성 대화" : "오늘 비용"
	}</span><b>${esc(costText)}</b></a><a class="pulse-stat" href="?view=monitors" data-view="monitors"><span>다음 모니터</span><b>${esc(
		nextMon,
	)}</b></a></div>`;

	const attnRows = [
		...attnThreads.map((t) => {
			const href = `?view=turns&amp;item=${esc(encodeURIComponent(t.originKey))}`;
			return `<a class="row" href="${href}"><div class="row-main"><div class="badges">${badge(
				"턴 확인 필요",
				"is-warning",
			)}${t.install ? badge(t.install, "") : ""}</div><p class="row-title">${esc(
				t.title,
			)}</p><p class="row-sub">${esc(t.latest.preview ?? "-")} · ${ago(Date.parse(t.updatedAt))}</p></div></a>`;
		}),
		...pendingApprovals.map(
			(a) =>
				`<a class="row" href="?view=approvals&amp;item=${esc(encodeURIComponent(a.approvalId))}"><div class="row-main"><div class="badges">${badge(
					"승인 대기",
					"is-warning",
				)}</div><p class="row-title">${esc(a.title)}</p><p class="row-sub">${esc(a.originLabel ?? "-")}</p></div></a>`,
		),
		...openAlerts.map((al) => {
			const alertId = al.install ? `${al.install}:${al.incidentId}` : String(al.incidentId);
			return `<a class="row" href="?view=alerts&amp;item=${esc(encodeURIComponent(alertId))}"><div class="row-main"><div class="badges">${badge(
				"열린 알림",
				"is-danger",
			)}${al.install ? badge(al.install, "") : ""}</div><p class="row-title">${esc(
				alertTitle(al.scope),
			)}</p><p class="row-sub">${al.count}회 · ${at(al.lastAt)}</p></div></a>`;
		}),
		...badMonitors.map(
			(m) =>
				`<a class="row" href="?view=monitors&amp;item=${esc(encodeURIComponent(m.id))}"><div class="row-main"><div class="badges">${badge(
					"모니터 실패",
					"is-danger",
				)}</div><p class="row-title">${esc(m.name)}</p><p class="row-sub">${esc(m.summary)}</p></div></a>`,
		),
	];
	const attnBlock =
		attnRows.length === 0
			? ""
			: `<section class="pulse-sec" aria-label="확인 필요"><h2 class="col-head"><span>확인 필요</span><span class="count-chip">${attnRows.length}</span></h2><div class="rows">${attnRows.join("")}</div></section>`;

	const active = renderActiveCards(s, ago, dur, badge);
	const workBlock = `<section class="pulse-sec" aria-label="지금 진행 중"><h2 class="col-head"><span>지금 진행 중</span><span class="count-chip">${active.count}</span></h2>${
		active.count === 0
			? '<div class="empty-box"><p class="note">지금 진행 중인 대화·작업이 없어요</p><p class="note-sub">최근 기록은 <a href="?view=turns" data-view="turns">턴</a> · <a href="?view=flow" data-view="flow">흐름</a> · <a href="?view=monitors" data-view="monitors">모니터</a>에서 볼 수 있어요.</p></div>'
			: active.html
	}</section>`;

	const headClosed = closedTasks.slice(0, 5);
	const tailClosed = closedTasks.slice(5);
	const closedLine = (t: (typeof closedTasks)[number]): string =>
		`<a class="closed-row" href="?task=${esc(encodeURIComponent(t.taskId))}" data-task="${esc(t.taskId)}" data-row="${esc(
			t.taskId,
		)}"><b>${esc(t.taskId)}</b> ${esc(t.title)} · ${esc(t.statusLabel)} ${t.closedAt}</a>`;
	const closedBlock =
		closedTasks.length === 0
			? ""
			: `<section class="pulse-sec" aria-label="최근 닫힘 TASK"><h2 class="col-head"><span>최근 닫힘 TASK</span><span class="count-chip">${closedTasks.length}</span></h2><div class="pulse-closed">${headClosed
					.map(closedLine)
					.join("")}${
					tailClosed.length === 0
						? ""
						: `<details class="closed" id="closed"><summary>이전 닫힘 <span class="count-chip">${tailClosed.length}</span></summary>${tailClosed
								.map(closedLine)
								.join("")}</details>`
				}</div></section>`;

	return `<div class="inbox-pulse">${kpi}${attnBlock}${workBlock}${closedBlock}</div>`;
}
