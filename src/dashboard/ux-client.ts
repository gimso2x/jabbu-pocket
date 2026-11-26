/**
 * Client-side UX helpers prepended to `BOOT_CLIENT`:
 * - P0: mobile more-menu sheet, topbar status popover close/restore, `unmarkSeen`
 * - P1/P2 helpers are added in subsequent steps
 */
export const stripClientComments = (source: string, compact = false): string => {
	const noComments = source.replace(/^\s*\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");
	return (compact ? noComments.replace(/^[ \t]+/gm, "") : noComments).replace(/\n{2,}/g, "\n");
};

export const UX_CLIENT = `function unmarkSeen(store, id) {
	const state = readUnread(store);
	if (!Object.hasOwn(state.seen, id)) return null;
	const prev = state.seen[id];
	delete state.seen[id];
	store.set(JSON.stringify(state));
	return prev;
}
function restoreMarkSeen(store, id, mark) {
	const state = readUnread(store);
	if (mark) state.seen[id] = mark;
	else delete state.seen[id];
	store.set(JSON.stringify(state));
}
function setNavMore(doc, open) {
	const nav = doc.querySelector(".sidenav");
	const btn = doc.querySelector("[data-nav-more]");
	if (nav) nav.classList.toggle("is-more-open", !!open);
	if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}
function closeStatusPops(doc) {
	for (const pop of doc.querySelectorAll("details.status-pop[open]")) pop.removeAttribute("open");
}
function readUxOpenState(doc) {
	const grid = doc.querySelector(".sys-grid");
	const activeDay = doc.querySelector('[data-card="cost"] .limit-row.is-active');
	return {
		statusOpen: doc.querySelector("details.status-pop[open]") !== null,
		moreOpen: doc.querySelector(".sidenav.is-more-open") !== null,
		sysCompact: grid && grid.hasAttribute("data-ux-toggled") ? grid.classList.contains("is-compact-ok") : null,
		costDay: activeDay ? activeDay.getAttribute("data-day") : null,
	};
}
function selectCostDay(card, day) {
	if (!card) return;
	for (const r of card.querySelectorAll(".limit-row[data-day]")) r.classList.toggle("is-active", r.getAttribute("data-day") === day);
	const all = card.querySelector("[data-cost-all]");
	const reset = card.querySelector("[data-cost-day-reset]");
	const empty = card.querySelector("[data-cost-day-empty]");
	if (all) all.hidden = !!day;
	if (reset) reset.hidden = !day;
	let matched = false;
	for (const list of card.querySelectorAll("[data-cost-day]")) {
		const showList = !!day && list.getAttribute("data-cost-day") === day;
		list.hidden = !showList;
		if (showList) matched = true;
	}
	if (empty) empty.hidden = !day || matched;
}
function restoreUxOpenState(doc, saved) {
	for (const r of doc.querySelectorAll('[data-card="cost"] .limit-row[data-day]')) {
		r.setAttribute("role", "button");
		r.setAttribute("tabindex", "0");
	}
	if (!saved) return;
	if (saved.statusOpen) {
		const pop = doc.querySelector("details.status-pop");
		if (pop) pop.setAttribute("open", "");
	}
	if (saved.moreOpen) setNavMore(doc, true);
	if (saved.sysCompact !== null) {
		const grid = doc.querySelector(".sys-grid");
		const btn = doc.querySelector("[data-sys-ok-toggle]");
		if (grid) { grid.classList.toggle("is-compact-ok", saved.sysCompact); grid.setAttribute("data-ux-toggled", "1"); }
		if (btn) {
			btn.setAttribute("aria-pressed", saved.sysCompact ? "true" : "false");
			const okTotal = grid ? grid.querySelectorAll(".sys-card.is-ok").length : 0;
			btn.textContent = saved.sysCompact ? "정상 카드 펼치기 (" + okTotal + ")" : "정상 카드 접기";
		}
	}
	if (saved.costDay) selectCostDay(doc.querySelector('[data-card="cost"]'), saved.costDay);
}
function uxShowToast(el, text, action, arm) {
	el.replaceChildren();
	const msg = el.ownerDocument.createElement("span");
	msg.textContent = text;
	el.appendChild(msg);
	if (action && action.label) {
		const btn = el.ownerDocument.createElement("button");
		btn.type = "button";
		btn.className = "toast-act";
		btn.setAttribute("data-toast-act", "1");
		btn.textContent = action.label;
		el.appendChild(btn);
		const bar = el.ownerDocument.createElement("i");
		bar.className = "toast-bar";
		el.appendChild(bar);
	}
	el.hidden = false;
	arm();
	return action && typeof action.run === "function" ? action.run : null;
}
function triageRow(doc, mode, ctx) {
	if (ctx.view !== "inbox" && ctx.view !== "list") return false;
	if (!ctx.store || !ctx.snapshot) return false;
	const active = doc.activeElement;
	const main = doc.getElementById("main");
	const row = active && main && main.contains(active) ? active.closest("[data-row]") : null;
	const id = row ? row.getAttribute("data-row") : ctx.open ? ctx.open.id : null;
	if (!id) return false;
	const entry = inboxEntries(ctx.snapshot, ctx.board === null ? undefined : ctx.board).find((item) => item.id === id);
	if (!entry) return false;
	const state = readUnread(ctx.store);
	const isUnread = unreadIds([entry], ctx.store).includes(id);
	const prev = Object.hasOwn(state.seen, id) ? state.seen[id] : null;
	const prevKeep = ctx.getKeep();
	const key = entry.kind + ":" + id;
	if (mode === "read") {
		if (!isUnread) { ctx.toast("이미 확인한 항목이에요"); return true; }
		markSeen(ctx.store, entry, Date.now());
		if (prevKeep === key) ctx.setKeep("");
		ctx.redraw();
		ctx.toast("확인함으로 표시했어요", {
			label: "되돌리기",
			ms: 5000,
			run: () => { restoreMarkSeen(ctx.store, id, prev); ctx.setKeep(prevKeep); ctx.redraw(); },
		});
		return true;
	}
	if (!state.seeded) { ctx.toast("지금은 안 읽음 표시를 바꿀 수 없어요"); return true; }
	if (isUnread) { ctx.toast("이미 안 읽음 상태예요"); return true; }
	unmarkSeen(ctx.store, id);
	ctx.setKeep(key);
	ctx.redraw();
	ctx.toast("안 읽음으로 표시했어요", {
		label: "되돌리기",
		ms: 5000,
		run: () => { restoreMarkSeen(ctx.store, id, prev); ctx.setKeep(prevKeep); ctx.redraw(); },
	});
	return true;
}
function uxEnhanceDetail(root) {
	for (const li of root.querySelectorAll(".say-options li")) {
		li.setAttribute("role", "button");
		li.setAttribute("tabindex", "0");
		li.setAttribute("title", "눌러서 답변 복사");
	}
}
function uxSelectSayOption(opt, helpers) {
	const text = (opt.textContent || "").trim();
	const box = opt.closest(".detail-say");
	const replyUrl = box ? box.getAttribute("data-reply-url") : "";
	helpers.copyText(text, "선택지", replyUrl ? {
		label: "herdr에서 답하기 ↗",
		ms: 4500,
		run: () => window.open(replyUrl, "_blank", "noopener,noreferrer"),
	} : undefined);
}
function uxPeekLink(link, show) {
	if (!window.matchMedia || !window.matchMedia("(min-width: 1024px)").matches) return;
	for (const kind of ["card", "task", "item"]) {
		const tid = link.getAttribute("data-" + kind);
		if (tid) { show({ kind: kind, id: tid }, "peek"); break; }
	}
}
function uxHandleKeydown(event, ctx) {
	if ((event.key === "e" || event.key === "u") && triageRow(ctx.doc, event.key === "e" ? "read" : "unread", ctx)) {
		event.preventDefault();
		return true;
	}
	if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element) {
		const opt = event.target.closest(".say-options li");
		if (opt) { event.preventDefault(); uxSelectSayOption(opt, ctx); return true; }
		const costRow = event.target.closest('[data-card="cost"] .limit-row[data-day]');
		if (costRow) {
			event.preventDefault();
			const day = costRow.getAttribute("data-day");
			selectCostDay(costRow.closest('[data-card="cost"]'), costRow.classList.contains("is-active") ? null : day);
			return true;
		}
	}
	if (event.key === "Enter" && event.target instanceof Element) {
		const entry = event.target.closest("a[data-card], a[data-task], a[data-item]");
		if (entry) {
			event.preventDefault();
			for (const kind of ["card", "task", "item"]) {
				const id = entry.getAttribute("data-" + kind);
				if (id) { ctx.show({ kind: kind, id: id }, "push"); return true; }
			}
		}
	}
	return false;
}
function uxHandleClick(target, event, doc, helpers) {
	if (target.closest("[data-toast-act]") && helpers && helpers.runToastAct) {
		event.preventDefault();
		helpers.runToastAct();
		return true;
	}
	const moreBtn = target.closest("[data-nav-more]");
	if (moreBtn) {
		event.preventDefault();
		const nav = doc.querySelector(".sidenav");
		setNavMore(doc, !(nav && nav.classList.contains("is-more-open")));
		return true;
	}
	const flowToggle = target.closest("[data-flow-closed-toggle]");
	if (flowToggle) {
		event.preventDefault();
		const folds = Array.from(doc.querySelectorAll(".flow-fold"));
		const openAll = folds.some((fold) => !fold.open);
		for (const fold of folds) fold.open = openAll;
		flowToggle.setAttribute("aria-expanded", openAll ? "true" : "false");
		flowToggle.textContent = openAll ? "완료 모두 접기" : "완료 모두 펼치기";
		return true;
	}
	const diffToggle = target.closest("[data-diff-toggle-all]");
	if (diffToggle) {
		event.preventDefault();
		const files = Array.from(doc.querySelectorAll("#detail-head .diff-file"));
		const openAll = files.some((f) => !f.open);
		for (const f of files) f.open = openAll;
		diffToggle.setAttribute("aria-expanded", openAll ? "true" : "false");
		diffToggle.textContent = openAll ? "모두 접기" : "모두 펼치기";
		return true;
	}
	const diffJump = target.closest("[data-diff-jump]");
	if (diffJump) {
		event.preventDefault();
		const el = doc.getElementById(diffJump.getAttribute("data-diff-jump") || "");
		if (el) { el.open = true; el.scrollIntoView({ block: "start" }); }
		return true;
	}
	const sysToggle = target.closest("[data-sys-ok-toggle]");
	if (sysToggle) {
		event.preventDefault();
		const grid = doc.querySelector(".sys-grid");
		if (grid) {
			const compact = grid.classList.toggle("is-compact-ok");
			grid.setAttribute("data-ux-toggled", "1");
			sysToggle.setAttribute("aria-pressed", compact ? "true" : "false");
			const okTotal = grid.querySelectorAll(".sys-card.is-ok").length;
			sysToggle.textContent = compact ? "정상 카드 펼치기 (" + okTotal + ")" : "정상 카드 접기";
		}
		return true;
	}
	const costReset = target.closest("[data-cost-day-reset]");
	if (costReset) {
		event.preventDefault();
		selectCostDay(costReset.closest('[data-card="cost"]'), null);
		return true;
	}
	const costRow = target.closest('[data-card="cost"] .limit-row[data-day]');
	if (costRow) {
		event.preventDefault();
		const day = costRow.getAttribute("data-day");
		selectCostDay(costRow.closest('[data-card="cost"]'), costRow.classList.contains("is-active") ? null : day);
		return true;
	}
	const opt = target.closest(".say-options li");
	if (opt && helpers) {
		event.preventDefault();
		uxSelectSayOption(opt, helpers);
		return true;
	}
	if (!target.closest(".sidenav") && !target.closest("[data-nav-more]")) setNavMore(doc, false);
	if (!target.closest(".status-pop")) closeStatusPops(doc);
	return false;
}
function uxHandleEscape(doc) {
	if (doc.querySelector("details.status-pop[open]")) {
		closeStatusPops(doc);
		return true;
	}
	if (doc.querySelector(".sidenav.is-more-open")) {
		setNavMore(doc, false);
		return true;
	}
	return false;
}
`;
