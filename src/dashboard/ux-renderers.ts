import type { DashboardSnapshot } from "./snapshot";
import { esc } from "./text";

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

/** Mobile 5th tab button ("더보기") and sidebar footer (theme selector + shortcut help). */
export function renderNavExtras(view: string, moreWarn: boolean, theme: string): string {
	const moreCurrent = view === "lanes" || view === "monitors" || view === "alerts" || view === "system";
	const moreBtn = `<button type="button" class="nav-item nav-more-btn" data-nav-more aria-expanded="false" aria-label="더보기 메뉴"${
		moreCurrent ? ' aria-current="page"' : ""
	}><span>더보기</span>${
		moreWarn ? '<span class="nav-count is-warn">!</span>' : ""
	}<svg class="ico nav-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="8" r="1" fill="currentColor"/></svg></button>`;
	const themeBtn = (mode: string, text: string): string =>
		`<button type="button" class="seg-item" data-theme-set="${mode}" aria-pressed="${theme === mode}">${text}</button>`;
	const foot = `<div class="nav-foot"><div class="seg" role="group" aria-label="테마">${themeBtn("system", "시스템")}${themeBtn("light", "라이트")}${themeBtn("dark", "다크")}</div><button type="button" class="nav-help" data-help-open aria-label="단축키 도움말"><span>단축키</span><kbd>?</kbd></button></div>`;
	return `${moreBtn}${foot}`;
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
