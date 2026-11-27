import type { HostMetricsInfo } from "./host-metrics";
import { resetIn, usageLevel } from "./load-view";
import type { DashboardSnapshot, Section } from "./snapshot";
import { esc } from "./text";
import type { UsageLimitsInfo } from "./usage-limits";

/**
 * Self-contained P0 dashboard renderers shipped into `SCRIPT` (`html.ts`) beside `renderDashboardMain`.
 * Keep every function free of module-level helpers except shipped globals (`esc`, `usageLevel`, `resetIn`).
 */

/** Formats context tokens as `54.7k / 1.0M` or `295.9k` when window size is unknown. */
export function fmtContextRatio(context: { percent: number; tokens: number; tokensOnly?: true } | undefined): string {
	if (context === undefined) return "";
	const fmt = (n: number): string =>
		n >= 1_000_000
			? `${(n / 1_000_000).toFixed(1)}M`
			: n >= 1000
				? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
				: String(n);
	if (context.tokensOnly === true || context.percent <= 0) return fmt(context.tokens);
	const win = Math.round(context.tokens / (context.percent / 100));
	return `${fmt(context.tokens)} / ${fmt(win)}`;
}

/** Renders CPU load, memory/swap/pressure, and browser process breakdown bars. */
export function renderHostMetricsBody(m: HostMetricsInfo): string {
	const cpuTone = m.cpuPct >= 100 ? " is-danger" : m.cpuPct >= 80 ? " is-warn" : "";
	const memTone =
		m.memUsedPct >= 90 || m.pressure === "full"
			? " is-danger"
			: m.memUsedPct >= 75 || m.pressure === "some"
				? " is-warn"
				: "";
	const brTone = m.browsers.rssMb >= 4096 || m.browsers.total >= 30 ? " is-warn" : "";
	const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
	const rssTxt = m.browsers.rssMb >= 1024 ? gb(m.browsers.rssMb) : `${Math.round(m.browsers.rssMb)} MB`;
	const swapTxt = m.swapTotalMb > 0 ? `스왑 ${gb(m.swapUsedMb)} / ${gb(m.swapTotalMb)}` : "스왑 없음";
	const presTxt = m.pressure === undefined ? "" : `pressure ${esc(m.pressure)} · `;
	const cpuBar = `<div class="res-item${cpuTone}"><div class="res-top"><span>CPU</span><b>${m.load1.toFixed(2)} / ${m.cpuCores}코어 · ${m.cpuPct}%</b></div><span class="meter" role="img" aria-label="CPU ${m.cpuPct}%"><i style="width:${Math.min(100, m.cpuPct)}%"></i></span><p class="res-sub">부하 5분 ${m.load5.toFixed(2)} · 15분 ${m.load15.toFixed(2)}</p></div>`;
	const memBar = `<div class="res-item${memTone}"><div class="res-top"><span>메모리</span><b>${m.memAvailPct}% 여유 (${m.memUsedPct}% 사용)</b></div><span class="meter" role="img" aria-label="메모리 사용 ${m.memUsedPct}%"><i style="width:${Math.min(100, m.memUsedPct)}%"></i></span><p class="res-sub">${presTxt}가용 ${gb(m.memAvailMb)} / ${gb(m.memTotalMb)} · ${swapTxt}</p></div>`;
	const brBar = `<div class="res-item${brTone}"><div class="res-top"><span>브라우저</span><b>${m.browsers.total}개 · ${rssTxt}</b></div><p class="res-sub">Chrome ${m.browsers.chrome} · headless ${m.browsers.headless} · Playwright ${m.browsers.playwright} · agent-browser ${m.browsers.agentBrowser}</p></div>`;
	return `<div class="res-list">${cpuBar}${memBar}${brBar}</div>`;
}

/** `호스트 리소스` card for the `시스템` view (`data-card="resources"`). */
export function renderHostMetricsCard(
	section: Section<HostMetricsInfo>,
	note: (text: string) => string,
	pushCard: (id: string, title: string, level: string, body: string, wide?: boolean) => void,
): void {
	if (!section.ok) {
		pushCard("resources", "호스트 리소스", "bad", note(`리소스를 읽지 못했어요: ${section.error}`));
		return;
	}
	const level =
		section.cpuPct >= 100 || section.memUsedPct >= 90 || section.pressure === "full"
			? "bad"
			: section.cpuPct >= 80 ||
					section.memUsedPct >= 75 ||
					section.pressure === "some" ||
					section.browsers.rssMb >= 4096 ||
					section.browsers.total >= 30
				? "warn"
				: "ok";
	pushCard("resources", "호스트 리소스", level, renderHostMetricsBody(section));
}

/** Desktop right-hand live status rail (`실시간 현황`) when `hostMetrics` is available. */
export function renderLiveRail(s: DashboardSnapshot, ago: (since: number) => string): string {
	if (s.hostMetrics === undefined) return "";
	const d = s.daemon;
	const up = d.ok && d.running;
	const genMs = Date.parse(s.generatedAt);
	const ageTxt = Number.isNaN(genMs) ? "-" : ago(genMs);
	const resBody = s.hostMetrics.ok
		? renderHostMetricsBody(s.hostMetrics)
		: `<p class="note">${esc(s.hostMetrics.error)}</p>`;
	const sessLine =
		d.ok && d.hostSessions !== undefined
			? `<p class="res-sub">호스트 세션 ${d.hostSessions.count ?? "?"}/${d.hostSessions.ceiling === 0 ? "∞" : d.hostSessions.ceiling}</p>`
			: "";
	const peersHtml =
		s.peerHealth?.ok && s.peerHealth.items.length > 0
			? `<section class="rail-card" aria-label="피어 봇 요약"><div class="rail-card-head"><b>피어 봇 ${s.peerHealth.items.length}</b><a class="rail-link" href="?view=system" data-view="system">시스템 →</a></div><div class="rail-peers">${s.peerHealth.items
					.map((p) => {
						const bad = !p.running || p.discord === "down" || p.error !== undefined;
						const warn = !bad && (p.openAlerts > 0 || (p.turns24h?.failed ?? 0) > 0 || p.draining === true);
						const dot = bad ? "is-danger" : warn ? "is-warning" : "is-success";
						const info = [
							p.turns24h
								? `진행 ${p.turns24h.open}${p.turns24h.failed > 0 ? ` · 실패 ${p.turns24h.failed}` : ""}`
								: p.running
									? "켜짐"
									: "꺼짐",
							p.agyAccount
								? `AGY ${p.agyAccount.current}${p.agyAccount.blockedCount > 0 ? ` (차단 ${p.agyAccount.blockedCount})` : ""}`
								: "",
						]
							.filter((x) => x !== "")
							.join(" · ");
						return `<div class="rail-peer"><span class="rail-peer-name"><i class="sys-dot ${dot}" aria-hidden="true"></i><b>${esc(p.name)}</b></span><span class="rail-peer-meta">${esc(info)}</span></div>`;
					})
					.join("")}</div></section>`
			: "";
	return `<aside class="dash-rail" aria-label="실시간 현황"><div class="rail-head"><span class="rail-title">실시간 현황</span><span class="rail-live"><i class="sys-dot ${up ? "is-success" : "is-danger"}" aria-hidden="true"></i>LIVE · ${esc(ageTxt)}</span></div><section class="rail-card" aria-label="시스템 리소스"><div class="rail-card-head"><b>시스템 · 30초 주기</b><a class="rail-link" href="?view=system" data-view="system">자세히 →</a></div>${resBody}${sessLine}</section>${peersHtml}</aside>`;
}

/**
 * Persistent quota card grid for Claude, GLM, and per-account Antigravity slots (model groups separated).
 * Never uses `.limit-tile` or `data-card="usage"` inside `<main>`.
 */
export function renderQuotaGrid(usage: Section<UsageLimitsInfo>, clock: number): string {
	if (!usage.ok) return `<p class="note">${esc(`한도를 읽지 못했어요: ${usage.error}`)}</p>`;
	const groupOf = (label: string, sourceName: string): string => {
		const paren = /\(([^)]+)\)/.exec(label);
		if (paren) return paren[1] ?? "";
		if (sourceName !== "Antigravity") return "";
		return label.replace(/\s+models$/i, "").replace(/\s+and\s+/i, "·");
	};
	const sortRows = <T extends { label: string; window: string }>(rawRows: T[], sourceName: string) => {
		const picked = rawRows.filter((row) => row.window !== "other");
		const rows = (picked.length === 0 ? rawRows : picked).map((row) => ({
			row,
			group: groupOf(row.label, sourceName),
		}));
		const order = [...new Set(rows.map((r) => r.group))];
		rows.sort(
			(a, b) =>
				order.indexOf(a.group) - order.indexOf(b.group) ||
				(a.row.window === "5h" ? 0 : 1) - (b.row.window === "5h" ? 0 : 1),
		);
		return rows;
	};
	const rowHtml = (label: string, pct: number, resetsAt: number | undefined): string => {
		const tone = usageLevel(pct);
		const left = resetIn(resetsAt, clock);
		return `<div class="quota-row is-${tone}"><span class="quota-name">${esc(label)}</span><span class="meter" role="img" aria-label="${esc(label)} ${pct}%"><i style="width:${pct}%"></i></span><b class="quota-pct">${pct}%</b><span class="quota-reset">${esc(left)}</span></div>`;
	};

	const cards: string[] = [];
	for (const source of usage.sources) {
		const accts = source.accounts;
		if (accts !== undefined && accts.length > 0) {
			for (const acct of accts) {
				const blkLeft =
					acct.blockedUntil !== undefined && acct.blockedUntil > clock ? resetIn(acct.blockedUntil, clock) : "";
				const pills = `${acct.active ? '<span class="badge is-info">사용 중</span>' : ""}${blkLeft !== "" ? `<span class="badge is-danger">차단 ${esc(blkLeft)}</span>` : ""}`;
				if (!acct.ok) {
					const cls = blkLeft !== "" ? "is-danger" : "is-failed";
					const dot = blkLeft !== "" ? "is-danger" : "is-muted";
					cards.push(
						`<div class="quota-card ${cls}" data-quota-account="${esc(acct.name)}"><div class="quota-head"><i class="dot ${dot}" aria-hidden="true"></i><b>${esc(acct.name)}</b><span class="quota-tag">AGY</span>${pills}</div><p class="note-sub">${esc(acct.error)}</p></div>`,
					);
					continue;
				}
				const rows = sortRows(acct.rows, source.name);
				let worst: "ok" | "warn" | "danger" = blkLeft !== "" ? "danger" : "ok";
				for (const { row } of rows) {
					const t = usageLevel(row.remainingPct);
					if (t === "danger" || (t === "warn" && worst === "ok")) worst = t;
				}
				const dotTone = worst === "danger" ? "is-danger" : worst === "warn" ? "is-warning" : "is-success";
				const body = rows
					.map(({ row, group }) => {
						const win = row.window === "5h" ? "5시간" : row.window === "weekly" ? "주간" : row.windowLabel;
						return rowHtml(group === "" ? win : `${group} ${win}`, row.remainingPct, row.resetsAt);
					})
					.join("");
				cards.push(
					`<div class="quota-card is-${worst}" data-quota-account="${esc(acct.name)}"><div class="quota-head"><i class="dot ${dotTone}" aria-hidden="true"></i><b>${esc(acct.name)}</b><span class="quota-tag">AGY</span>${pills}</div>${body}</div>`,
				);
			}
			continue;
		}
		if (!source.ok) {
			cards.push(
				`<div class="quota-card is-failed" data-quota-source="${esc(source.name)}"><div class="quota-head"><i class="dot is-muted" aria-hidden="true"></i><b>${esc(source.name)}</b></div><p class="note-sub">${esc(source.error)}</p></div>`,
			);
			continue;
		}
		const rows = sortRows(source.rows, source.name);
		let worst: "ok" | "warn" | "danger" = "ok";
		for (const { row } of rows) {
			const t = usageLevel(row.remainingPct);
			if (t === "danger" || (t === "warn" && worst === "ok")) worst = t;
		}
		const dotTone = worst === "danger" ? "is-danger" : worst === "warn" ? "is-warning" : "is-success";
		const body = rows
			.map(({ row, group }) => {
				const win = row.window === "5h" ? "5시간" : row.window === "weekly" ? "주간" : row.windowLabel;
				return rowHtml(group === "" ? win : `${group} ${win}`, row.remainingPct, row.resetsAt);
			})
			.join("");
		cards.push(
			`<div class="quota-card is-${worst}" data-quota-source="${esc(source.name)}"><div class="quota-head"><i class="dot ${dotTone}" aria-hidden="true"></i><b>${esc(source.name)}</b>${source.account ? `<span class="quota-tag">${esc(source.account)}</span>` : ""}</div>${body}</div>`,
		);
	}
	return `<div class="quota-grid">${cards.join("")}</div>`;
}

/** Persistent quota section rendered in the `인박스` view. */
export function renderQuotaSection(usage: Section<UsageLimitsInfo> | undefined, clock: number): string {
	if (usage === undefined) return "";
	return `<section class="quota-sec" aria-label="계정 토큰 상태"><h2 class="col-head"><span>계정 토큰 상태</span></h2>${renderQuotaGrid(usage, clock)}</section>`;
}

/** Wide `계정 한도` card (`data-card="quota"`) in the `시스템` view. */
export function renderQuotaSysCard(
	usage: Section<UsageLimitsInfo>,
	clock: number,
	pushCard: (id: string, title: string, level: string, body: string, wide?: boolean) => void,
): void {
	let level: "ok" | "warn" | "bad" = "ok";
	if (!usage.ok) level = "bad";
	else {
		for (const s of usage.sources) {
			if (!s.ok) {
				if (level === "ok") level = "warn";
			} else {
				for (const r of s.rows) {
					const t = usageLevel(r.remainingPct);
					if (t === "danger") level = "bad";
					else if (t === "warn" && level === "ok") level = "warn";
				}
			}
			for (const a of s.accounts ?? []) {
				if (a.blockedUntil !== undefined && a.blockedUntil > clock) level = "bad";
				else if (!a.ok && level === "ok") level = "warn";
				else if (a.ok) {
					for (const r of a.rows) {
						const t = usageLevel(r.remainingPct);
						if (t === "danger") level = "bad";
						else if (t === "warn" && level === "ok") level = "warn";
					}
				}
			}
		}
	}
	pushCard("quota", "계정 한도", level, renderQuotaGrid(usage, clock), true);
}

/** Renders 2-column `.active-grid` cards for working threads and running background jobs (reused in pulse & inbox). */
export function renderActiveCards(
	s: DashboardSnapshot,
	ago: (since: number) => string,
	dur: (ms: number | null | undefined) => string,
	badge: (text: string, tone: string) => string,
): { count: number; html: string } {
	const threads = s.turns.ok ? s.turns.threads.filter((t) => t.column === "working") : [];
	const runningJobs = s.jobs.ok ? s.jobs.items.filter((j) => j.state === "running" && j.health !== "dead") : [];
	const total = threads.length + runningJobs.length;
	if (total === 0) return { count: 0, html: "" };
	const placeOf = (key: string): string => {
		const raw = key.replace(/^[^/:]+:/, "");
		if (/^[a-z]+\/dm\//.test(raw)) return "DM";
		const ch = /^(?:slack|discord)\/ch\/([^/]+)/.exec(raw);
		if (ch?.[1]) return s.channelNames?.[ch[1]] ?? ch[1];
		return raw.startsWith("monitor/") ? "모니터" : "";
	};
	const cards = [
		...threads.map((t) => {
			const place = placeOf(t.originKey);
			const modelChip = t.model
				? `<span class="badge model-chip">${esc(
						t.model.model.slice(t.model.model.lastIndexOf("/") + 1) +
							(t.model.thinking ? ` · ${t.model.thinking}` : ""),
					)}</span>`
				: "";
			const ctx = t.context;
			const ctxHtml =
				ctx === undefined
					? `<div class="active-ctx is-empty"><span class="note-sub">턴 ${t.turnCount} · ${ago(Date.parse(t.updatedAt))}</span></div>`
					: ctx.tokensOnly
						? `<div class="active-ctx is-empty"><span class="note-sub">컨텍스트</span><span class="ctx-ratio">${esc(fmtContextRatio(ctx))}</span></div>`
						: (() => {
								const pct = Math.min(100, Math.round(ctx.percent));
								const tone = ctx.percent >= 90 ? " is-danger" : ctx.percent >= 80 ? " is-warn" : "";
								return `<div class="active-ctx${tone}"><span class="meter" role="img" aria-label="컨텍스트 ${pct}%"><i style="width:${pct}%"></i></span><span class="ctx-ratio">${esc(fmtContextRatio(ctx))} (${pct}%)</span></div>`;
							})();
			return `<a class="active-card" href="?view=turns&amp;item=${esc(encodeURIComponent(t.originKey))}"><div class="active-head"><span class="badges">${badge(t.install ?? "본체", "")}${place === "" ? "" : badge(place, "")}${modelChip}</span><span class="active-age">${badge("작업 중", "is-info")}<span class="card-time">${esc(dur(t.latest.ageMs))}</span></span></div><p class="active-title">${esc(t.title)}</p>${ctxHtml}</a>`;
		}),
		...runningJobs.map((j) => {
			const tail = j.percent !== undefined ? `${j.percent}%` : dur(j.ageMs);
			return `<a class="active-card" href="?view=turns&amp;item=${esc(encodeURIComponent(`job:${j.name}`))}"><div class="active-head"><span class="badges">${badge("백그라운드", "is-info")}</span><span class="active-age"><span class="card-time">${esc(tail)}</span></span></div><p class="active-title">${esc(j.title)}</p><div class="active-ctx is-empty"><span class="note-sub">${esc(j.detail ?? j.name)}</span></div></a>`;
		}),
	];
	return { count: total, html: `<div class="active-grid">${cards.join("")}</div>` };
}

/** Persistent `현재 활성` section rendered in non-idle `인박스` when turns or jobs are running. */
export function renderActiveTurnsSection(
	s: DashboardSnapshot,
	ago: (since: number) => string,
	dur: (ms: number | null | undefined) => string,
	badge: (text: string, tone: string) => string,
): string {
	const { count, html } = renderActiveCards(s, ago, dur, badge);
	if (count === 0) return "";
	return `<section class="active-sec" aria-label="현재 활성"><h2 class="col-head"><span>현재 활성</span><span class="count-chip">${count}</span></h2>${html}</section>`;
}
