import type { DashboardSnapshot, FlowChainInfo } from "./snapshot";
import { esc } from "./text";
import type { TraceSpan } from "./trace";

/**
 * Self-contained UX helper renderers shipped into `SCRIPT` (`html.ts`) beside `renderDashboardMain`.
 * Keep every function free of module-level imports other than `esc` (already shipped in `SCRIPT`).
 */

/** Compact topbar status summary `<details>` wrapping the full `.status-chips` badge tray. */
export function renderStatusPop(d: DashboardSnapshot["daemon"], boardDown: boolean, chipsHtml: string): string {
	const statusBad = !d.ok || !d.running || boardDown;
	const statusWarn =
		!statusBad &&
		d.ok &&
		(d.openGates.length > 0 || d.frozen !== undefined || d.drain !== undefined || d.heartbeat?.draining === true);
	const statusLabel = !d.ok
		? "데몬 상태 모름"
		: !d.running
			? "데몬 꺼짐"
			: boardDown
				? "보드 끊김"
				: d.openGates.length > 0
					? `게이트 ${d.openGates.length}열림`
					: d.frozen
						? "동결"
						: d.drain || d.heartbeat?.draining
							? "drain"
							: `정상${d.hostSessions ? ` · ${d.hostSessions.count ?? "?"}/${d.hostSessions.ceiling || "∞"}` : ""}`;
	const statusDot = statusBad ? "is-danger" : statusWarn ? "is-warning" : "is-success";
	return `<details class="status-pop"><summary class="status-summary${
		statusBad ? " is-danger" : statusWarn ? " is-warn" : ""
	}"><span class="sys-dot ${statusDot}" aria-hidden="true"></span><span>${esc(
		statusLabel,
	)}</span></summary><div class="status-chips" aria-label="봇 상태">${chipsHtml}</div></details>`;
}

/** Mobile 5th tab button ("더보기") and collapsible sheet wrapping secondary views + sidebar footer. */
export function renderNavExtras(view: string, moreWarn: boolean, theme: string, secondaryNav = ""): string {
	const moreCurrent = view === "lanes" || view === "monitors" || view === "alerts" || view === "system";
	const moreBtn = `<button type="button" class="nav-item nav-more-btn" data-nav-more aria-expanded="false" aria-label="더보기 메뉴"${
		moreCurrent ? ' aria-current="page"' : ""
	}><span>더보기</span>${
		moreWarn ? '<span class="nav-count is-warn">!</span>' : ""
	}<svg class="ico nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg></button>`;
	const themeBtn = (mode: string, text: string): string =>
		`<button type="button" class="seg-item" data-theme-set="${mode}" aria-pressed="${theme === mode}">${text}</button>`;
	const foot = `<div class="nav-foot"><div class="seg" role="group" aria-label="테마">${themeBtn("system", "시스템")}${themeBtn("light", "라이트")}${themeBtn("dark", "다크")}</div><button type="button" class="nav-help" data-help-open aria-label="단축키 도움말"><span>단축키</span><kbd>?</kbd></button></div>`;
	return `${moreBtn}<div class="nav-sheet">${secondaryNav}${foot}</div>`;
}

/** Contextual Board | List switcher placed in the view header for inbox, list, and turns. */
export function renderViewTools(hasLayout: boolean, boardHref: string, listHref: string, layout: string): string {
	if (!hasLayout) return "";
	return `<span class="view-tools"><div class="seg" role="group" aria-label="보기 방식"><a class="seg-item" href="${boardHref}" data-layout="board"${
		layout === "board" ? ' aria-current="true"' : ""
	}>Board</a><a class="seg-item" href="${listHref}" data-layout="list"${
		layout === "list" ? ' aria-current="true"' : ""
	}>List</a></div></span>`;
}

/** Flow view cards: open chains expanded, completed chains folded into 1-line accordions with a toggle bar. */
export function renderFlowCards(
	chains: FlowChainInfo[],
	selected: string,
	renderChain: (chain: FlowChainInfo, focus: string, panel: boolean) => string,
): string {
	const at = (iso: string | null | undefined): string => (iso ? iso.slice(5, 16).replace("T", " ") : "-");
	const openCount = chains.filter((chain) => chain.here !== null).length;
	const closedCount = chains.length - openCount;
	const bar = `<div class="flow-bar"><span class="view-sum">진행 중 <b>${openCount}</b> · 끝남 <b>${closedCount}</b></span>${
		closedCount > 1
			? '<button type="button" class="button is-ghost is-sm" data-flow-closed-toggle aria-expanded="false">완료 모두 펼치기</button>'
			: ""
	}</div>`;
	const cards = chains.map((chain) => {
		const closed = chain.here === null;
		const first = chain.tasks[0]?.createdAt;
		const meta = [`TASK ${chain.total}개`, `${at(first)} ~ ${at(chain.updatedAt)}`, chain.place ?? ""]
			.filter((part) => part !== "")
			.join(" · ");
		const body = renderChain(chain, selected, false);
		if (!closed) {
			return `<section class="flow-card" data-thread="${esc(chain.threadRef)}"><h2 class="flow-title"><span>${esc(
				chain.title,
			)}</span><small>${chain.done}/${chain.total} 끝남</small></h2><p class="flow-meta">${esc(
				meta,
			)}</p>${body}</section>`;
		}
		const hasSel = selected !== "" && chain.tasks.some((step) => step.taskId === selected);
		return `<section class="flow-card is-closed" data-thread="${esc(
			chain.threadRef,
		)}"><details class="flow-fold" id="flow-${esc(chain.threadRef)}"${
			hasSel ? " open" : ""
		}><summary class="flow-fold-sum"><h2 class="flow-title"><span>${esc(
			chain.title,
		)}</span><small>${chain.done}/${chain.total} 끝남</small></h2><span class="flow-meta">${esc(
			meta,
		)}</span></summary>${body}</details></section>`;
	});
	return `${bar}<div class="flow-list">${cards.join("")}</div>`;
}

/** 4-quadrant Anti-Theater approval card grid preserving `<dt>/<dd>` semantics. */
export function renderApprovalCards(detail: Record<string, string | undefined> | null): string {
	if (detail === null) return "";
	const SECTIONS: Array<[string, string]> = [
		["action", "할 일"],
		["why", "이유"],
		["impact", "영향"],
		["rollback", "되돌릴 수 없는 이유"],
	];
	const cells: string[] = [];
	for (const [key, label] of SECTIONS) {
		const value = detail[key];
		if (value) cells.push(`<div class="appr-cell is-${key}"><dt>${label}</dt><dd>${esc(value)}</dd></div>`);
	}
	return cells.length === 0 ? "" : `<dl class="appr-grid">${cells.join("")}</dl>`;
}

/** Trace waterfall filter bar (`전체 / 모델만 / 도구만 / 오류만 / 느린 순`). */
export function renderTraceFilters(filter: string, counts: { llm: number; tool: number; errors: number }): string {
	const items: Array<[string, string]> = [
		["all", "전체"],
		["llm", `모델만${counts.llm > 0 ? ` ${counts.llm}` : ""}`],
		["tool", `도구만${counts.tool > 0 ? ` ${counts.tool}` : ""}`],
		["error", `오류만${counts.errors > 0 ? ` ${counts.errors}` : ""}`],
		["slow", "느린 순"],
	];
	return `<div class="badges tw-filters" role="group" aria-label="스팬 필터" data-part="html">${items
		.map(
			([key, label]) =>
				`<button type="button" class="chip" data-trace-filter="${key}" aria-pressed="${filter === key}">${esc(label)}</button>`,
		)
		.join("")}</div>`;
}

/** Cache/token breakdown bar, cost share, and tool args/result preview inside `.tw-pop`. */
export function renderTraceInspector(
	picked: TraceSpan,
	sum:
		| {
				tokensIn: number;
				tokensInput: number;
				cacheRead: number;
				cacheWrite: number;
				tokensOut: number;
				cost: number;
		  }
		| undefined,
	totalCost: number,
): string {
	const fmt = (n: number): string =>
		n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
	const cr = sum?.cacheRead ?? picked.cacheRead ?? 0;
	const cw = sum?.cacheWrite ?? picked.cacheWrite ?? 0;
	const rawIn = sum?.tokensInput ?? picked.tokensInput ?? 0;
	const tin = rawIn + cr + cw > 0 ? rawIn : (sum?.tokensIn ?? picked.tokensIn ?? 0);
	const tout = sum?.tokensOut ?? picked.tokensOut ?? 0;
	const tokAll = tin + cr + cw + tout;
	const pct = (n: number, d: number): string => (d <= 0 || n <= 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`);
	const inSum = tin + cr + cw;
	const hitPct = inSum > 0 && cr > 0 ? ` · 캐시 적중 ${Math.round((cr / inSum) * 100)}%` : "";
	const costVal = picked.kind === "agent" || picked.kind === "subagent" ? (sum?.cost ?? 0) : (picked.cost ?? 0);
	const costNote =
		totalCost > 0 && costVal > 0 && picked.kind !== "agent"
			? ` · 비용 비중 ${Math.round((costVal / totalCost) * 100)}%`
			: "";
	const tokHtml =
		tokAll === 0
			? ""
			: `<div class="tw-tok"><div class="tw-tok-bar" role="img" aria-label="토큰 구성"><i class="tk-in" style="width:${pct(tin, tokAll)}"></i><i class="tk-cr" style="width:${pct(cr, tokAll)}"></i><i class="tk-cw" style="width:${pct(cw, tokAll)}"></i><i class="tk-out" style="width:${pct(tout, tokAll)}"></i></div><p class="note-sub">입력 ${esc(fmt(tin))} · 캐시 읽기 ${esc(fmt(cr))} · 캐시 쓰기 ${esc(fmt(cw))} · 출력 ${esc(fmt(tout))}${hitPct}${costNote}</p></div>`;
	const hasPay = picked.argsPreview !== undefined || picked.resultPreview !== undefined;
	const payHtml = !hasPay
		? ""
		: `<details class="fold tw-payload"><summary>도구 인자 · 결과 미리보기</summary><div class="tw-payload-body">${
				picked.argsPreview ? `<p class="note-sub">인자</p><pre class="tw-pre">${esc(picked.argsPreview)}</pre>` : ""
			}${
				picked.resultPreview ? `<p class="note-sub">결과</p><pre class="tw-pre">${esc(picked.resultPreview)}</pre>` : ""
			}</div></details>`;
	return `${tokHtml}${payHtml}`;
}

/** Collects span roll-ups, slowest call, max extent, and filtered/sorted tree rows for `renderTrace`. */
export function buildTraceRows(
	root: TraceSpan,
	clock: number,
	fold: Record<string, boolean>,
	filter: string,
): {
	sums: Record<
		string,
		{
			cost: number;
			tokensIn: number;
			tokensInput: number;
			cacheRead: number;
			cacheWrite: number;
			tokensOut: number;
			llm: number;
			tool: number;
			agents: number;
			errors: number;
		}
	>;
	total: {
		cost: number;
		tokensIn: number;
		tokensInput: number;
		cacheRead: number;
		cacheWrite: number;
		tokensOut: number;
		llm: number;
		tool: number;
		agents: number;
		errors: number;
	};
	slowest: TraceSpan | undefined;
	far: number;
	rows: Array<{ span: TraceSpan; level: number }>;
} {
	type Sum = {
		cost: number;
		tokensIn: number;
		tokensInput: number;
		cacheRead: number;
		cacheWrite: number;
		tokensOut: number;
		llm: number;
		tool: number;
		agents: number;
		errors: number;
	};
	const endOf = (span: TraceSpan): number => Math.max(span.start, span.end ?? clock);
	const sums: Record<string, Sum> = {};
	let slowest: TraceSpan | undefined;
	let far = 0;
	const walk = (span: TraceSpan): Sum => {
		const sum: Sum = {
			cost: span.cost ?? 0,
			tokensIn: span.tokensIn ?? 0,
			tokensInput: span.tokensInput ?? 0,
			cacheRead: span.cacheRead ?? 0,
			cacheWrite: span.cacheWrite ?? 0,
			tokensOut: span.tokensOut ?? 0,
			llm: span.kind === "llm" && span.end !== undefined ? 1 : 0,
			tool: span.kind === "tool" ? 1 : 0,
			agents: span.kind === "subagent" ? 1 : 0,
			errors: span.status === "failed" ? 1 : 0,
		};
		far = Math.max(far, endOf(span));
		const own = span.end === undefined ? -1 : span.end - span.start;
		if ((span.kind === "llm" || span.kind === "tool") && span.status !== "running" && own > 0) {
			if (slowest === undefined || own > (slowest.end ?? 0) - slowest.start) slowest = span;
		}
		for (const child of span.children ?? []) {
			const p = walk(child);
			sum.cost += p.cost;
			sum.tokensIn += p.tokensIn;
			sum.tokensInput += p.tokensInput;
			sum.cacheRead += p.cacheRead;
			sum.cacheWrite += p.cacheWrite;
			sum.tokensOut += p.tokensOut;
			sum.llm += p.llm;
			sum.tool += p.tool;
			sum.agents += p.agents;
			sum.errors += p.errors;
		}
		sums[span.id] = sum;
		return sum;
	};
	const total = walk(root);
	const isFolded = (span: TraceSpan): boolean =>
		(span.children?.length ?? 0) > 0 && (fold[span.id] ?? (span.kind === "subagent" && span.status !== "running"));
	const match = (span: TraceSpan): boolean =>
		filter === "llm"
			? span.kind === "llm"
			: filter === "tool"
				? span.kind === "tool"
				: filter === "error"
					? span.status === "failed"
					: true;
	const hasMatch = (span: TraceSpan): boolean => match(span) || (span.children ?? []).some(hasMatch);
	const rows: Array<{ span: TraceSpan; level: number }> = [];
	if (filter === "slow") {
		const flat: TraceSpan[] = [];
		const collect = (span: TraceSpan): void => {
			for (const c of span.children ?? []) {
				flat.push(c);
				collect(c);
			}
		};
		collect(root);
		flat.sort((a, b) => endOf(b) - b.start - (endOf(a) - a.start));
		rows.push({ span: root, level: 1 }, ...flat.map((span) => ({ span, level: 2 })));
	} else {
		const visit = (span: TraceSpan, level: number): void => {
			if (level > 1 && filter !== "all" && !hasMatch(span)) return;
			rows.push({ span, level });
			if (filter !== "all" || !isFolded(span)) for (const child of span.children ?? []) visit(child, level + 1);
		};
		visit(root, 1);
	}
	return { sums, total, slowest, far, rows };
}

/** File jump navigator with expand/collapse-all toggle at the top of diff detail. */
export function renderDiffNav(files: Array<{ path: string; added: number; deleted: number }>): string {
	if (files.length === 0) return "";
	const items = files
		.map(
			(file, i) =>
				`<a class="diff-nav-item" href="#diff-f-${i}" data-diff-jump="diff-f-${i}"><span class="diff-path">${esc(
					file.path,
				)}</span><span class="diff-stat"><span class="diff-add">+${file.added}</span> <span class="diff-del">−${file.deleted}</span></span></a>`,
		)
		.join("");
	return `<div class="diff-nav"><div class="diff-nav-head"><span>파일 목록 (${files.length})</span><button type="button" class="button is-ghost is-sm" data-diff-toggle-all aria-expanded="false">모두 펼치기</button></div><div class="diff-nav-list">${items}</div></div>`;
}

/** 1-line exception-first summary strip above the system cards grid. */
export function renderSysStrip(ok: number, warn: number, bad: number): string {
	const total = ok + warn + bad;
	if (total === 0) return "";
	const issues = warn + bad;
	const text = issues === 0 ? `모두 정상 (${ok}/${total})` : `확인 필요 ${issues}건 · 정상 ${ok}/${total}`;
	const label = issues === 0 ? "정상 카드 접기" : `정상 카드 펼치기 (${ok})`;
	return `<div class="notice ${bad > 0 ? "is-danger" : issues > 0 ? "is-warning" : ""} sys-strip"><span class="sys-dot ${
		bad > 0 ? "is-danger" : issues > 0 ? "is-warning" : "is-success"
	}" aria-hidden="true"></span><span>${text}</span>${
		ok > 0
			? `<button type="button" class="button is-ghost is-sm" data-sys-ok-toggle aria-pressed="${issues > 0}">${label}</button>`
			: ""
	}</div>`;
}
