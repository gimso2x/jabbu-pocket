import { type HostChecksInfo, hostChecksLevel, repoCountsText } from "./host-checks";
import type { DashboardSnapshot, Section } from "./snapshot";
import { esc } from "./text";

/** Fallback `herdr 에이전트` section rendered in `인박스` when the live board stream is absent. */
export function renderHerdrAgentsBlock(
	herdr: DashboardSnapshot["herdr"],
	head: (title: string, count: number | string | undefined, extra?: string) => string,
	badge: (text: string, tone: string) => string,
	state: (name: string) => string,
): string {
	if (herdr.ok && herdr.hosts.length === 0) return "";
	const body = herdr.ok
		? herdr.hosts
				.map(
					(host) =>
						`<p class="group">${esc(host.host)}</p>${
							!host.ok
								? `<div class="notice is-danger">${badge("호스트 연결 실패", "is-danger")}<span>${esc(host.error)}</span><span class="notice-next">다음 행동: <code>jabbu-pocket doctor</code>로 해당 호스트의 SSH 및 herdr 경로를 점검하세요.</span></div>`
								: host.agents.length === 0
									? '<div class="empty-box"><p class="note">실행 중인 에이전트가 없어요</p><p class="note-sub">새 작업을 위임하면 이 호스트의 에이전트 목록에 나타납니다.</p></div>'
									: `<div class="rows">${host.agents
											.map(
												(agent) =>
													`<div class="row"><div class="row-main"><div class="badges">${state(agent.agentStatus)}</div><p class="row-title">${esc(agent.name)}</p>${
														agent.terminalTitle ? `<p class="row-sub">${esc(agent.terminalTitle)}</p>` : ""
													}${
														agent.question
															? `<p class="row-sub">묻는 말: ${esc(agent.question)}</p>`
															: agent.blocked || agent.lastSay
																? `<p class="row-sub">${esc(agent.blocked || agent.lastSay)}</p>`
																: ""
													}<p class="row-sub">${agent.taskId ? `${esc(agent.taskId)} · ` : ""}${esc(agent.cwd)}</p></div></div>`,
											)
											.join("")}</div>`
						}`,
				)
				.join("")
		: `<div class="notice is-danger">${badge("herdr 조회 실패", "is-danger")}<span>${esc(herdr.error)}</span><span class="notice-next">다음 행동: 로컬 herdr 실행 파일과 데몬 설정을 확인하세요(<code>jabbu-pocket doctor</code>).</span></div>`;
	return `<section class="rows-block" aria-label="herdr 에이전트">${head(
		"herdr 에이전트",
		herdr.ok ? herdr.hosts.reduce((sum, host) => sum + (host.ok ? host.agents.length : 0), 0) : undefined,
	)}${body}</section>`;
}

/** `호스트 점검` card in the `시스템` view; self-contained for `SCRIPT` (`html.ts`). */
export function renderHostChecksCard(
	checks: Section<HostChecksInfo>,
	hostChecksUrl: string | undefined,
	dur: (ms: number | null | undefined) => string,
	badge: (text: string, tone: string) => string,
	facts: (rows: Array<[string, string]>) => string,
	note: (text: string) => string,
	pushCard: (
		id: string,
		title: string,
		level: string,
		body: string,
		wide?: boolean,
		link?: { href: string; text: string },
	) => void,
): void {
	const link = hostChecksUrl === undefined ? undefined : { href: hostChecksUrl, text: "전체 보기" };
	if (!checks.ok) {
		pushCard("hosts", "호스트 점검", "bad", note(`호스트 점검을 읽지 못했어요: ${checks.error}`), true, link);
		return;
	}
	const rows: Array<[string, string]> = [];
	const lines: string[] = [];
	const line = (key: string, state: string, tone: string, word: string, label: string, detail: string) =>
		`<li class="gate-row is-open" data-check="${esc(key)}" data-state="${esc(state)}"><span class="sys-dot ${tone}" aria-hidden="true"></span><span class="gate-word">${word}</span><span class="gate-label">${esc(
			label,
		)}</span><code class="gate-detail">${esc(detail)}</code></li>`;
	for (const host of checks.hosts) {
		const age = host.reportAgeMs === null ? "보고 없음" : `${dur(host.reportAgeMs)} 전`;
		const repo = host.repoCounts === undefined ? undefined : repoCountsText(host.repoCounts);
		const repoShown = repo !== undefined && host.issues.some((issue) => issue.detail === repo);
		rows.push([
			host.label,
			host.online
				? [
						`정상 ${host.okCount}/${host.total}`,
						age,
						...(host.skipped > 0 ? [`건너뜀 ${host.skipped}`] : []),
						...(repo === undefined || repoShown ? [] : [`저장소 ${repo}`]),
					]
						.map(esc)
						.join(" · ")
				: badge(`보고 끊김 · ${age}`, "is-danger"),
		]);
		const stale = host.online ? [] : host.issues.filter((issue) => issue.state === "stale");
		for (const issue of host.issues) {
			if (stale.includes(issue)) continue;
			const alert = issue.state === "fail" && issue.severity === "alert";
			const word = issue.severity === "alert" ? "❌" : issue.severity === "notice" ? "🆕" : "ℹ";
			lines.push(
				line(
					`${host.host}:${issue.id}`,
					issue.state,
					alert ? "is-danger" : "is-warning",
					word,
					`${host.label} · ${issue.label}`,
					issue.detail,
				),
			);
		}
		if (stale.length > 0) {
			lines.push(line(host.host, "stale", "is-danger", "판정 보류", host.label, `점검 ${stale.length}개 판정 보류`));
		}
	}
	pushCard(
		"hosts",
		"호스트 점검",
		hostChecksLevel(checks),
		`${facts(rows)}${lines.length === 0 ? "" : `<ul class="gate-list">${lines.join("")}</ul>`}`,
		true,
		link,
	);
}
