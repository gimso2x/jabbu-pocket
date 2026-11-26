/**
 * Client-side URL-state and DOM helpers shipped into the page script ahead of `boot()`.
 */

export interface ClientUrlState {
	view: string;
	layout: string;
	stale: boolean;
	q: string;
	sort: string;
	desc: boolean;
	open: { kind: string; id: string } | null;
}

/** Parses `location.search` into dashboard UI and open-detail state; self-contained for `.toString()`. */
export function parseUrlState(search: string): ClientUrlState {
	const query = new URLSearchParams(search);
	const view = query.get("view") || "inbox";
	const layout = query.get("layout") === "list" ? "list" : "";
	const stale = query.get("stale") === "1";
	const q = query.get("q") || "";
	const sort = query.get("sort") || "";
	const desc = query.get("desc") === "1";
	for (const kind of ["card", "task", "item", "diff"]) {
		const id = query.get(kind);
		if (id) return { view, layout, stale, q, sort, desc, open: { kind, id } };
	}
	return { view, layout, stale, q, sort, desc, open: null };
}

/** Builds the canonical dashboard URL for the given UI state and open detail; self-contained for `.toString()`. */
export function buildUrlState(
	href: string,
	ui: Pick<ClientUrlState, "view" | "layout" | "stale" | "q" | "sort" | "desc">,
	target: { kind: string; id: string } | null,
): URL {
	const url = new URL(href);
	for (const name of ["view", "layout", "stale", "q", "sort", "desc", "card", "task", "item", "diff"]) {
		url.searchParams.delete(name);
	}
	if (ui.view !== "inbox") url.searchParams.set("view", ui.view);
	if (ui.view === "turns" && ui.layout === "list") url.searchParams.set("layout", "list");
	if (ui.stale && (ui.view === "inbox" || ui.view === "list")) url.searchParams.set("stale", "1");
	if (ui.q) url.searchParams.set("q", ui.q);
	if (ui.sort) {
		url.searchParams.set("sort", ui.sort);
		if (ui.desc) url.searchParams.set("desc", "1");
	}
	if (target) url.searchParams.set(target.kind, target.id);
	url.hash = "";
	return url;
}

const CLIENT_DOM_HELPERS = `function closeLimitsPops(doc) {
	for (const pop of doc.querySelectorAll(".limits-pop.is-open, .limits-pop:focus-within")) {
		pop.classList.remove("is-open");
		const btn = pop.querySelector(".limits-trigger");
		if (btn) btn.setAttribute("aria-expanded", "false");
		if (doc.activeElement && pop.contains(doc.activeElement) && typeof doc.activeElement.blur === "function") {
			doc.activeElement.blur();
		}
	}
}
function handleLimitsClick(target, event, doc) {
	const btn = target.closest(".limits-trigger");
	if (!btn) {
		if (!target.closest(".limits-pop")) closeLimitsPops(doc);
		return false;
	}
	event.preventDefault();
	const pop = btn.closest(".limits-pop");
	const willOpen = !!pop && !pop.classList.contains("is-open");
	closeLimitsPops(doc);
	if (pop && willOpen) {
		pop.classList.add("is-open");
		btn.setAttribute("aria-expanded", "true");
	}
	return true;
}
function restoreLimitsPop(root, wasOpen) {
	if (!wasOpen) return;
	const pop = root.querySelector(".limits-pop");
	const btn = root.querySelector(".limits-trigger");
	if (pop) pop.classList.add("is-open");
	if (btn) btn.setAttribute("aria-expanded", "true");
}
function applyUrlStateToUi(ui, searchEl, state) {
	const moved =
		state.view !== ui.view ||
		state.layout !== ui.layout ||
		state.stale !== ui.stale ||
		state.q !== ui.q ||
		state.sort !== ui.sort ||
		state.desc !== ui.desc;
	ui.view = state.view;
	ui.layout = state.layout;
	ui.stale = state.stale;
	ui.q = state.q;
	ui.sort = state.sort;
	ui.desc = state.desc;
	searchEl.value = state.q;
	return moved;
}
`;

/** Serialized source shipped ahead of `boot()` in `BOOT_CLIENT`. */
export const CLIENT_UI_HELPERS = `${parseUrlState.toString()}\n${buildUrlState.toString()}\n${CLIENT_DOM_HELPERS}`;
