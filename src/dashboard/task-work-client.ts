import { isTaskOrigin } from "../lanes/status";
import type { TaskRow } from "../tasks/ledger";
import type { DashboardSnapshot, TaskInfo } from "./snapshot";
import { esc } from "./text";

/**
 * The 작업 내역 panel of a headless [TASK]: the snapshot's part (what runs the worker, its thread kept out of the turn
 * board), the panel's markup and the page script that fills it and sends 지시 넣기 · 멈춤 · 재개.
 */

/** {@link TaskInfo}'s `runtime`: a headless worker's session (`jabbu/task/<agent>`) shows in the 작업 내역 panel. */
export interface TaskRuntimeField {
	runtime: TaskRow["runtime"];
}

const innerOrigin = (key: string): string => {
	const colon = key.indexOf(":");
	return colon >= 0 && !key.slice(0, colon).includes("/") ? key.slice(colon + 1) : key;
};

/** The turn section without [TASK] worker threads (own or peer): their conversation is shown in TASK detail. */
export function withoutTaskThreads(section: DashboardSnapshot["turns"]): DashboardSnapshot["turns"] {
	return section.ok
		? { ...section, threads: section.threads.filter((thread) => !isTaskOrigin(innerOrigin(thread.originKey))) }
		: section;
}

/**
 * The 작업 내역 panel of a headless TASK (`""` for a herdr one, which keeps its board card): its worker session's
 * conversation (`api/thread/conversation`) and running turn (`api/thread/live/events`) on origin `jabbu/task/<agent>`,
 * and — for an open own TASK — the 지시 넣기 · 멈춤 · 재개 form the page shows only once the web chat's sign-in answered.
 * Self-contained (shipped to the page; {@link TASK_WORK_CLIENT} fills the slots).
 */
export function renderTaskWork(task: TaskInfo): string {
	if (task.runtime !== "headless") return "";
	// `taskOriginKey` of src/lanes/status.ts, spelled out: this function runs in the page too.
	const raw = task.install ? `${task.install}:jabbu/task/${task.agent}` : `jabbu/task/${task.agent}`;
	const origin = encodeURIComponent(raw);
	const running = task.herdr?.ok === true && task.herdr.status === "working";
	const form =
		task.open && task.install === undefined
			? `<form class="task-work-form" data-task-work-form hidden><textarea name="text" rows="3" aria-label="워커에 넣을 지시" placeholder="워커에 넣을 지시"></textarea><div class="task-work-buttons"><button type="submit" class="button">지시 넣기</button><button type="button" class="button is-ghost" data-task-work-control="pause">멈춤</button><button type="button" class="button is-ghost" data-task-work-control="resume">재개</button></div></form>`
			: "";
	return `<section class="task-work" aria-label="작업 내역" data-task-work="${esc(task.taskId)}" data-conversation="api/thread/conversation?origin=${origin}" data-live="api/thread/live/events?origin=${origin}" data-running="${running ? "1" : ""}"><h3 class="h3">작업 내역</h3><div class="task-work-conv" data-task-work-conv><p class="block-note">대화를 불러오는 중이에요</p></div><div class="live-slot" data-task-work-live></div><p class="task-work-note" data-task-work-note role="status"></p>${form}</section>`;
}

/** The panel's rules, appended to the page stylesheet (`PAGE_CSS`). */
export const TASK_WORK_STYLE = `.task-work { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; padding-top: var(--stack-m); border-top: 1px solid var(--c-line); }
.task-work-conv { display: flex; flex-direction: column; gap: var(--stack-s); min-width: 0; }
.task-work-note { font-size: var(--fs-caption); color: var(--c-text-2); }
.task-work-note:empty { display: none; }
.task-work-form { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2) 0; background: var(--c-surface); }
.task-work-form textarea { width: 100%; min-height: 64px; padding: var(--sp-2); border: 1px solid var(--c-line); border-radius: var(--r-m); background: var(--c-bg); color: var(--c-text-1); font: inherit; font-size: var(--fs-sub); resize: vertical; }
.task-work-form[hidden] { display: none; }
.task-work-buttons { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
@media (max-width: 640px) { .task-work-form { position: sticky; bottom: 0; z-index: 1; border-top: 1px solid var(--c-line); } }
`;

/**
 * `withPause` in the script: the snapshot lags the ledger by up to a poll, so until it agrees the header follows the
 * `paused` that the pause/resume answer re-read from the ledger.
 *
 * The page script of the panel (prepended to the boot script): `taskWork.paint(head, html)` replaces the detail head
 * and refills the panel from its own state, so a snapshot redraw keeps the conversation, the draft and the caret. The
 * conversation and live reads are the page's own GETs; writing needs the web chat's sign-in (`api/web/conversations`
 * hands out the CSRF token), otherwise the panel stays read-only.
 */
export const TASK_WORK_CLIENT = `const renderTaskWork = ${renderTaskWork.toString()};
const taskWork = (() => {
	const READ_ONLY = "개입은 웹 대화 인증이 필요합니다(디스코드로 가능)";
	let head = null;
	let work = null;
	let lastHtml = "";
	let known = null;
	const PAUSED = '<span class="badge is-warning" title="스윕 재촉·stale 알림·자동 머지 보류 중">멈춤 중</span>';
	function withPause(html) {
		if (!known || Date.now() - known.at > 20000 || html.indexOf('data-task-work="' + known.id + '"') < 0) return html;
		if ((html.indexOf(PAUSED) >= 0) === known.paused) known = null;
		else return known.paused ? html.replace('<button type="button" class="copy-btn"', PAUSED + '<button type="button" class="copy-btn"') : html.split(PAUSED).join("");
		return html;
	}
	const panelOf = () => {
		const panel = head && head.querySelector("[data-task-work]");
		return panel && work && panel.getAttribute("data-task-work") === work.id ? panel : null;
	};
	function stop() {
		if (work && work.source) work.source.close();
		work = null;
	}
	function paint() {
		const panel = panelOf();
		if (!panel) return;
		const conv = panel.querySelector("[data-task-work-conv]");
		if (work.convSeq > 0 && conv.getAttribute("data-seq") !== String(work.convSeq)) {
			conv.innerHTML = work.conv;
			conv.setAttribute("data-seq", String(work.convSeq));
		}
		const live = panel.querySelector("[data-task-work-live]");
		if (live.getAttribute("data-seq") !== String(work.liveSeq)) {
			live.innerHTML = work.live;
			live.setAttribute("data-seq", String(work.liveSeq));
		}
		const form = panel.querySelector("[data-task-work-form]");
		if (form) {
			form.hidden = work.writable !== true;
			const area = form.querySelector("textarea");
			if (area.value !== work.draft) area.value = work.draft;
			for (const button of form.querySelectorAll("button")) button.disabled = work.busy;
		}
		const note = form && work.writable === false ? (work.note ? work.note + " · " : "") + READ_ONLY : work.note;
		panel.querySelector("[data-task-work-note]").textContent = note;
	}
	async function load(w, before) {
		try {
			const response = await fetch(w.url + (before ? "&before=" + encodeURIComponent(before) : ""), { cache: "no-store" });
			if (!response.ok) throw new Error("HTTP " + response.status);
			const body = await response.json();
			if (work !== w) return;
			if (Array.isArray(body.turns)) {
				w.turns = before ? body.turns.concat(w.turns) : body.turns;
				w.cursor = body.cursor;
			}
			w.conv = renderConversation(Array.isArray(body.turns) ? { turns: w.turns, cursor: w.cursor } : body, "omp", renderMarkdown, Date.now());
		} catch (error) {
			if (work !== w) return;
			console.error(error);
			w.conv = '<p class="block-note">대화를 읽지 못했어요. 다시 시도해 주세요.</p>';
		}
		w.convSeq += 1;
		paint();
	}
	async function auth(w) {
		let token = "";
		try {
			const response = await fetch("api/web/conversations", { cache: "no-store", credentials: "same-origin" });
			token = response.ok ? response.headers.get("x-jabbu-csrf") || "" : "";
		} catch {
			token = "";
		}
		if (work !== w) return;
		w.csrf = token;
		w.writable = token !== "";
		paint();
	}
	async function send(action, text) {
		const w = work;
		if (!w || w.busy || w.writable !== true) return;
		w.busy = true;
		w.note = action === "followup" ? "지시를 넣는 중이에요" : action === "pause" ? "멈추는 중이에요" : "재개하는 중이에요";
		paint();
		let status = 0;
		let answer = {};
		try {
			const response = await fetch("api/web/task/" + encodeURIComponent(w.id) + "/" + action, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", "x-jabbu-csrf": w.csrf },
				body: JSON.stringify(action === "followup" ? { text: text } : {}),
			});
			status = response.status;
			answer = await response.json().catch(() => ({}));
		} catch (error) {
			console.error(error);
			answer = { error: "연결에 실패했습니다. 다시 시도해 주세요." };
		}
		if (work !== w) return;
		w.busy = false;
		if (status === 401 || status === 403 || (status === 404 && answer.error === "web_disabled")) w.writable = false;
		w.note = answer.text || answer.error || "연결에 실패했습니다. 다시 시도해 주세요.";
		if (status === 200 && action === "followup") w.draft = "";
		if (status === 200 && typeof answer.paused === "boolean" && lastHtml) {
			known = { id: w.id, paused: answer.paused, at: Date.now() };
			paintHead(head, lastHtml);
		}
		paint();
		if (status === 200) load(w);
	}
	function listen() {
		head.addEventListener("click", (event) => {
			const control = event.target.closest("button[data-task-work-control]");
			const more = event.target.closest("[data-task-work] button[data-before]");
			if (!control && !more) return;
			// The page's own handler would read these as its conversation tab's buttons.
			event.stopPropagation();
			if (more) {
				more.disabled = true;
				if (work) load(work, more.getAttribute("data-before"));
				return;
			}
			const action = control.getAttribute("data-task-work-control");
			// One confirmation before a pause: it cuts the worker's turn.
			if (action === "pause" && !confirm((work ? work.id : "") + " 작업을 멈출까요?")) return;
			send(action);
		});
		head.addEventListener("submit", (event) => {
			const form = event.target.closest("[data-task-work-form]");
			if (!form) return;
			event.preventDefault();
			const text = form.querySelector("textarea").value;
			if (text.trim() !== "") send("followup", text);
		});
		head.addEventListener("input", (event) => {
			if (work && event.target.closest("[data-task-work-form]")) work.draft = event.target.value;
		});
	}
	/** Replaces the detail head with html, then starts a new panel's reads or refills the kept one. */
	function paintHead(target, shown) {
		lastHtml = shown;
		const html = withPause(shown);
		if (head !== target) {
			head = target;
			listen();
		}
		const area = document.activeElement;
		const typing = area && area.tagName === "TEXTAREA" && head.contains(area) ? [area.selectionStart, area.selectionEnd] : null;
		head.innerHTML = html;
		const panel = head.querySelector("[data-task-work]");
		const id = panel ? panel.getAttribute("data-task-work") : null;
		if (!work || work.id !== id) {
			stop();
			if (!id) return;
			work = { id: id, url: panel.getAttribute("data-conversation"), turns: [], cursor: undefined, conv: "", convSeq: 0, live: "", liveSeq: 0, note: "", writable: null, csrf: "", source: null, draft: "", busy: false };
			load(work);
			auth(work);
		}
		const running = panel.getAttribute("data-running") === "1";
		if (running && !work.source) {
			const mine = work;
			mine.source = new EventSource(panel.getAttribute("data-live"));
			mine.source.addEventListener("live", (event) => {
				// A closed detail panel keeps no stream open.
				if (work !== mine || !head.isConnected || !document.body.classList.contains("detail-open")) return stop();
				const body = JSON.parse(event.data);
				const ended = mine.live !== "" && !(body && body.live);
				mine.live = renderLiveTurn(body && body.live ? body.live : null, renderMarkdown, { error: body && body.error ? body.error : "" });
				mine.liveSeq += 1;
				if (ended) load(mine);
				paint();
			});
		} else if (!running && work.source) {
			work.source.close();
			work.source = null;
			work.live = "";
			work.liveSeq += 1;
			load(work);
		}
		paint();
		const box = typing ? panel.querySelector("[data-task-work-form] textarea") : null;
		if (box && !box.closest("form").hidden) {
			box.focus({ preventScroll: true });
			box.setSelectionRange(typing[0], typing[1]);
		}
	}
	return { paint: paintHead };
})();
`;
