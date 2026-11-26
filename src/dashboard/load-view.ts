import type { CostLedgerInfo } from "./cost-ledger";
import type { Section } from "./snapshot";
import { esc } from "./text";
import type { UsageLimitsInfo } from "./usage-limits";

/*
 * The two small renderers of the turn board's context bar and the system view's 7-day cost card. Both are shipped
 * to the page as source (`html.ts` SCRIPT) next to `renderDashboardMain`, so they are self-contained: no module-level
 * names but the shipped `esc`, and every look comes from classes the page already styles (`.limit-row`, `.meter`).
 */

/**
 * The thread card's context bar: `.limit-row` colours the bar and the share (none under 80%, `is-warn` from 80%,
 * `is-danger` from 90%), `200k+` once the session passed 200k tokens. Nothing for an unknown use or `done` cards.
 */
export function contextBar(context: { percent: number; tokens: number } | undefined, column?: string): string {
	if (context === undefined || column === "done") return "";
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

/** `warn` under 20% remaining, `danger` under 5%; serialized into the page script, so it stays self-contained. */
export function usageLevel(remainingPct: number): "ok" | "warn" | "danger" {
	return remainingPct < 5 ? "danger" : remainingPct < 20 ? "warn" : "ok";
}

/** Time until a reset as `1h46m`, `4d6h`, `12m`; empty once it has passed. Self-contained for the page script. */
export function resetIn(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined || resetsAt <= now) return "";
	const minutes = Math.floor((resetsAt - now) / 60_000);
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
	return hours >= 1 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

/**
 * Top-bar model-limit chips and popover panel (`dashboard.usageLimits`). Self-contained for the page script:
 * keeps the active account on the chip while expanding per-account rows when `source.accounts` is populated.
 */
export function renderLimitsPop(
	usage: Section<UsageLimitsInfo> | undefined,
	clock: number,
	roll: (key: string, value: number | string, bad: string) => string,
): string {
	if (usage === undefined) return "";
	const wrap = (chips: string, tiles: string): string =>
		`<div class="limits-pop"><button type="button" class="limits-trigger" aria-label="모델 한도 자세히" aria-expanded="false">${chips}</button><div class="limits-panel" role="tooltip">${tiles}</div></div>`;
	if (!usage.ok) {
		return wrap(
			`<span class="limit-chip is-muted"><i class="dot is-muted" aria-hidden="true"></i>한도 ?</span>`,
			`<div class="limit-tile is-failed"><div class="limit-head"><b>모델 한도</b></div><p class="limit-error">읽지 못했어요: ${esc(usage.error)}</p></div>`,
		);
	}
	const groupOf = (label: string, sourceName: string): string => {
		const paren = /\(([^)]+)\)/.exec(label);
		if (paren) return paren[1] ?? "";
		if (sourceName !== "Antigravity") return "";
		return label.replace(/\s+models$/i, "").replace(/\s+and\s+/i, "·");
	};
	const best = { label: "", pct: 101 };
	const parts = usage.sources.map((source) => {
		const shortName = source.name === "Antigravity" ? "AG" : source.name;
		const accounts = source.accounts;
		const hasAccounts = accounts !== undefined && accounts.length > 0;
		const acctBadge = hasAccounts
			? source.account === undefined
				? `${accounts.length}계정`
				: `${source.account} · ${accounts.length}계정`
			: source.account;
		const headOf = (tone: string): string =>
			`<div class="limit-head"><i class="dot is-${tone}" aria-hidden="true"></i><b>${esc(source.name)}</b>${
				acctBadge === undefined ? "" : `<span class="limit-acct">${esc(acctBadge)}</span>`
			}</div>`;
		const acctsHtml = !hasAccounts
			? ""
			: `<div class="limit-accts"><div class="limit-acct-head"><span>계정</span><span>5시간</span><span>주간</span><span>초기화</span></div>${accounts
					.map((acct) => {
						const activeCls = acct.active ? " is-active" : "";
						if (!acct.ok) {
							return `<div class="limit-acct-row is-failed${activeCls}" data-account="${esc(acct.name)}"><span class="limit-acct-name"><i class="dot is-muted" aria-hidden="true"></i>${esc(acct.name)}</span><span class="limit-acct-err" title="${esc(acct.error)}">${esc(acct.error)}</span></div>`;
						}
						const filtered = acct.rows.filter((row) => row.window !== "other");
						const acctPicked = filtered.length === 0 ? acct.rows : filtered;
						let fiveH: (typeof acctPicked)[number] | undefined;
						let weekly: (typeof acctPicked)[number] | undefined;
						for (const row of acctPicked) {
							if (row.window === "5h" && (fiveH === undefined || row.remainingPct < fiveH.remainingPct)) fiveH = row;
							if (row.window === "weekly" && (weekly === undefined || row.remainingPct < weekly.remainingPct))
								weekly = row;
						}
						const t5 = fiveH === undefined ? "ok" : usageLevel(fiveH.remainingPct);
						const tw = weekly === undefined ? "ok" : usageLevel(weekly.remainingPct);
						const rowTone =
							t5 === "danger" || tw === "danger" ? "danger" : t5 === "warn" || tw === "warn" ? "warn" : "ok";
						const fiveHLeft = fiveH === undefined ? "" : resetIn(fiveH.resetsAt, clock);
						const resetRow =
							fiveH !== undefined && fiveH.remainingPct < 20
								? fiveH
								: weekly !== undefined && weekly.remainingPct < 20
									? weekly
									: fiveH !== undefined && fiveH.remainingPct < 100 && fiveHLeft !== ""
										? fiveH
										: (weekly ?? fiveH);
						const left = resetRow === undefined ? "" : resetIn(resetRow.resetsAt, clock);
						const detailTitle = acctPicked
							.map((row) => {
								const grp = groupOf(row.label, source.name);
								const win = row.window === "5h" ? "5시간" : row.window === "weekly" ? "주간" : row.windowLabel;
								const name = grp === "" ? win : `${grp} ${win}`;
								const rLeft = resetIn(row.resetsAt, clock);
								return `${name} ${row.remainingPct}%${rLeft === "" ? "" : ` (${rLeft})`}`;
							})
							.join(", ");
						return `<div class="limit-acct-row is-${rowTone}${activeCls}" data-account="${esc(acct.name)}" title="${esc(detailTitle)}"><span class="limit-acct-name"><i class="dot is-${rowTone}" aria-hidden="true"></i>${esc(acct.name)}</span><b class="limit-pct is-${t5}">${fiveH === undefined ? "-" : `${fiveH.remainingPct}%`}</b><b class="limit-pct is-${tw}">${weekly === undefined ? "-" : `${weekly.remainingPct}%`}</b><span class="limit-reset">${esc(left === "" ? "-" : left)}</span></div>`;
					})
					.join("")}</div>`;
		if (!source.ok) {
			return {
				chip: `<span class="limit-chip is-muted" data-source="${esc(source.name)}"><i class="dot is-muted" aria-hidden="true"></i>${esc(source.name)} ?</span>`,
				tile: `<div class="limit-tile is-failed" data-source="${esc(source.name)}">${headOf("muted")}<p class="limit-error">${esc(source.error)}</p>${acctsHtml}</div>`,
				tone: "muted",
			};
		}
		const picked = source.rows.filter((row) => row.window !== "other");
		const rows = (picked.length === 0 ? source.rows : picked).map((row) => ({
			row,
			group: groupOf(row.label, source.name),
		}));
		const order = [...new Set(rows.map((r) => r.group))];
		rows.sort(
			(a, b) =>
				order.indexOf(a.group) - order.indexOf(b.group) ||
				(a.row.window === "5h" ? 0 : 1) - (b.row.window === "5h" ? 0 : 1),
		);
		let worst = "ok";
		for (const { row } of rows) {
			const tone = usageLevel(row.remainingPct);
			if (tone === "danger" || (tone === "warn" && worst === "ok")) worst = tone;
		}
		const lines = hasAccounts
			? []
			: rows.map(({ row, group }) => {
					const tone = usageLevel(row.remainingPct);
					const win = row.window === "5h" ? "5시간" : row.window === "weekly" ? "주간" : row.windowLabel;
					const left = resetIn(row.resetsAt, clock);
					return `<div class="limit-row is-${tone}" data-window="${row.window}"><span class="limit-name">${esc(
						group === "" ? win : `${group} ${win}`,
					)}</span><span class="meter" role="img" aria-label="남은 ${row.remainingPct}%"><i style="width:${row.remainingPct}%"></i></span><b class="limit-pct">${row.remainingPct}%</b><span class="limit-reset"${
						left === "" ? "" : ` title="${esc(`${left} 뒤 초기화`)}"`
					}>${esc(left)}</span></div>`;
				});
		const lowest = (window: string): string => {
			const pcts = rows.filter((r) => r.row.window === window).map((r) => r.row.remainingPct);
			return pcts.length === 0 ? "" : String(Math.min(...pcts));
		};
		const short = lowest("5h");
		const week = lowest("weekly");
		const least = Math.min(...rows.map((r) => r.row.remainingPct));
		if (rows.length > 0 && least < best.pct) Object.assign(best, { label: shortName, pct: least });
		return {
			chip: `<span class="limit-chip is-${worst}" data-source="${esc(source.name)}"><i class="dot is-${worst}" aria-hidden="true"></i><b>${esc(shortName)}</b><span class="lc-full">${short === "" ? "" : `<small>5h</small>${roll(`lim:${source.name}:5h`, short, "down")}`}${
				week === "" ? "" : `<small>주</small>${roll(`lim:${source.name}:week`, week, "down")}`
			}</span><span class="lc-min">${rows.length === 0 ? "" : `${roll(`lim:${source.name}:min`, least, "down")}%`}</span></span>`,
			tile: `<div class="limit-tile is-${worst}" data-source="${esc(source.name)}">${headOf(worst)}${hasAccounts ? acctsHtml : lines.join("")}</div>`,
			tone: worst,
		};
	});
	const tones = parts.map((part) => part.tone);
	const sumTone = tones.includes("danger") ? "danger" : tones.some((tone) => tone !== "ok") ? "warn" : "ok";
	const dots = tones.map((tone) => `<i class="dot is-${tone}" aria-hidden="true"></i>`).join("");
	const sumVal = best.pct > 100 ? "?" : `${esc(best.label)} ${roll("lim:sum", best.pct, "down")}%`;
	const summary = `<span class="limit-sum limit-chip is-${sumTone}">${dots}${sumVal}</span>`;
	return wrap(parts.map((part) => part.chip).join("") + summary, parts.map((part) => part.tile).join(""));
}
