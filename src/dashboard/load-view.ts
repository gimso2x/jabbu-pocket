import type { CostLedgerInfo } from "./cost-ledger";
import type { Section } from "./snapshot";
import { esc } from "./text";

/*
 * The two small renderers of the turn board's context bar and the system view's 7-day cost card. Both are shipped
 * to the page as source (`html.ts` SCRIPT) next to `renderDashboardMain`, so they are self-contained: no module-level
 * names but the shipped `esc`, and every look comes from classes the page already styles (`.limit-row`, `.meter`).
 */

/**
 * The thread card's context bar: `.limit-row` colours the bar and the share (none under 80%, `is-warn` from 80%,
 * `is-danger` from 90%), `200k+` once the session passed 200k tokens. Nothing for an unknown use.
 */
export function contextBar(context: { percent: number; tokens: number } | undefined): string {
	if (context === undefined) return "";
	const pct = Math.round(context.percent);
	const tone = context.percent >= 90 ? " is-danger" : context.percent >= 80 ? " is-warn" : "";
	return `<span class="limit-row${tone}" title="컨텍스트 ${Math.round(context.tokens / 1000)}k 토큰"><span class="meter" role="img" aria-label="컨텍스트 ${pct}%"><i style="width:${Math.min(100, pct)}%"></i></span><b class="limit-pct">${pct}%${
		context.tokens > 200_000 ? " · 200k+" : ""
	}</b></span>`;
}

/** The body of the "7일 비용" card: a bar per day, the costliest sessions and the cache-write share; a failed read says so. */
export function costCardBody(cost: Section<CostLedgerInfo>): string {
	if (!cost.ok) return `<p class="note">${esc(`읽지 못했어요: ${cost.error}`)}</p>`;
	const usd = (amount: number): string => `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
	const peak = Math.max(0.01, ...cost.days.map((day) => day.cost));
	const days = cost.days
		.map(
			(day) =>
				`<div class="limit-row" data-day="${esc(day.day)}"><span class="limit-name">${esc(day.day)}</span><span class="meter" role="img" aria-label="${esc(day.day)} ${usd(day.cost)}"><i style="width:${Math.round((day.cost / peak) * 100)}%"></i></span><b class="limit-pct">${usd(day.cost)}</b></div>`,
		)
		.join("");
	const top = cost.top
		.map(
			(session) =>
				`<li class="gate-row"><span class="sys-dot" aria-hidden="true"></span><span class="gate-word">${esc(session.kind)}</span><span class="gate-label">${esc(session.title)}</span><code class="gate-detail">${usd(session.cost)}</code></li>`,
		)
		.join("");
	return `${days}${top === "" ? "" : `<ul class="gate-list">${top}</ul>`}<p class="note">7일 합계 ${usd(cost.total)} · 캐시 쓰기 ${cost.cacheWritePct}% · 이 기기 세션만 집계 (원격 호스트 제외)</p>`;
}
