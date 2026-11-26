/**
 * Client-side UX helpers prepended to `BOOT_CLIENT`:
 * - P0: mobile more-menu sheet, topbar status popover close/restore, `unmarkSeen`
 * - P1/P2 helpers are added in subsequent steps
 */
export const stripClientComments = (source: string): string =>
	source
		.replace(/^\s*\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\/\s*$/gm, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\n{2,}/g, "\n");

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
	return {
		statusOpen: doc.querySelector("details.status-pop[open]") !== null,
		moreOpen: doc.querySelector(".sidenav.is-more-open") !== null,
	};
}
function restoreUxOpenState(doc, saved) {
	if (!saved) return;
	if (saved.statusOpen) {
		const pop = doc.querySelector("details.status-pop");
		if (pop) pop.setAttribute("open", "");
	}
	if (saved.moreOpen) setNavMore(doc, true);
}
function uxHandleClick(target, event, doc) {
	const moreBtn = target.closest("[data-nav-more]");
	if (moreBtn) {
		event.preventDefault();
		const nav = doc.querySelector(".sidenav");
		setNavMore(doc, !(nav && nav.classList.contains("is-more-open")));
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
