import { typicalNote } from "../store/turn-duration";
import type { BoardCard } from "./board";
import type { MonitorDetailRun, MonitorProcedure } from "./monitor-detail";
import { monitorModelDetail } from "./monitor-model";
import type { DashboardSnapshot, FlowChainInfo, TaskInfo } from "./snapshot";
import { renderTaskWork } from "./task-work-client";
import {
	APPROVAL_OUTCOMES,
	alertText,
	esc,
	JOB_LABELS,
	MONITOR_STAGES,
	monitorTook,
	openTurnsText,
	TURN_LABELS,
} from "./text";

/**
 * A TASK's facts for the detail panel: ID and risk, branch, machine, AC and step progress, PROGRESS, blocker, worker.
 * Only what the snapshot already carries. Self-contained (shipped to the page).
 */
export function renderTaskFacts(task: TaskInfo): string {
	const at = (iso: string | undefined): string => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "-");
	const percent =
		task.acChecked === undefined || task.acTotal === 0 ? 0 : Math.round((task.acChecked / task.acTotal) * 100);
	const acValue =
		task.acChecked === undefined
			? !task.open
				? `${task.acTotal}개`
				: `-/${task.acTotal}`
			: `${task.acChecked}/${task.acTotal}<span class="meter" role="img" aria-label="AC ${percent}%"><i style="width:${percent}%"></i></span>`;
	const rows: Array<[string, string]> = [
		["TASK", `<span class="mono">${esc(task.taskId)}</span> · 위험 ${esc(task.risk)}`],
		["브랜치", `<code>${esc(task.branch)}</code>`],
		["머신", `${esc(task.host)} · ${esc(task.agent)}`],
		["AC 충족", acValue],
		[
			"단계",
			`${task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`}${
				task.progress?.current ? ` · 지금 ${esc(task.progress.current)}` : ""
			}`,
		],
		["PROGRESS", task.progress ? `${esc(task.progress.status || "?")} · ${at(task.progress.updated)}` : "-"],
	];
	if (task.typical !== undefined && task.elapsedMs !== undefined) {
		rows.push([
			"걸린 시간",
			esc(`경과 ${Math.floor(task.elapsedMs / 60_000)}분 · ${typicalNote(task.elapsedMs, task.typical) ?? ""}`),
		]);
	}
	if (task.progress?.blockedReason) rows.push(["막힌 이유", esc(task.progress.blockedReason)]);
	if (task.herdr !== undefined) {
		rows.push([
			"워커",
			task.herdr.ok ? esc(task.herdr.status) : `<span class="is-error">${esc(task.herdr.error)}</span>`,
		]);
	}
	if (task.error) rows.push(["판정 오류", `<span class="is-error">${esc(task.error)}</span>`]);
	rows.push(["갱신", at(task.updatedAt)]);
	if (task.closedAt) rows.push(["닫힘", at(task.closedAt)]);
	const item = (done: boolean, word: string, tone: string, id: string, text: string): string =>
		`<li class="${done ? "is-done" : ""}"><span class="badge ${tone}">${word}</span><span><b>${esc(id)}</b> ${esc(text)}</span></li>`;
	const checks =
		task.acceptance === undefined || task.acceptance.length === 0
			? ""
			: `<h3 class="h3">AC 체크 목록</h3><ol class="checks" aria-label="AC 체크 목록">${task.acceptance
					.map((ac) =>
						item(ac.checked, ac.checked ? "충족" : "미충족", ac.checked ? "is-success" : "is-warning", ac.id, ac.text),
					)
					.join("")}</ol>`;
	const now = (task.progress?.current ?? "").split(/[\s:]/, 1)[0];
	const steps =
		task.steps === undefined || task.steps.length === 0
			? ""
			: `<h3 class="h3">단계</h3><ol class="checks" aria-label="단계 목록">${task.steps
					.map((step) =>
						step.done
							? item(true, "완료", "is-success", step.id, step.text)
							: step.id === now
								? item(false, "지금", "is-info", step.id, step.text)
								: item(false, "남음", "", step.id, step.text),
					)
					.join("")}</ol>`;
	/**
	 * The 스펙 → S1…Sn → 판정 → 리뷰 → 착지 band. Over 9 steps the unbroken done run before the current step folds
	 * into one cell (the done step right before it stays), then, past 6 step cells, the steps after the second one
	 * after the current step fold into `+m 남음`.
	 */
	const band = (): string => {
		const list = task.steps ?? [];
		if (list.length === 0) return "";
		const finished = task.status === "done";
		const review = task.status === "review";
		const blocked = task.status === "blocked";
		const cells: Array<{ text: string; state: "done" | "now" | "todo" }> = [];
		const nowAt = review || finished ? -1 : list.findIndex((step) => step.id === now);
		const firstOpen = list.findIndex((step) => !step.done);
		const c = nowAt >= 0 ? nowAt + 1 : firstOpen >= 0 ? firstOpen + 1 : list.length;
		let d = 0;
		while (d < list.length && list[d]?.done) d += 1;
		const n = list.length;
		const k = n > 9 ? Math.min(d, c - 2) : 0;
		const folded = k >= 2 ? k : 0;
		const shown = (folded > 0 ? 1 : 0) + n - folded;
		const keepTo = n > 9 && shown > 6 ? Math.min(n, c + 2) : n;
		cells.push({ text: "스펙", state: "done" });
		if (folded > 0) cells.push({ text: `${list[0]?.id}–${list[folded - 1]?.id} 끝남`, state: "done" });
		for (let index = folded; index < keepTo; index += 1) {
			const step = list[index];
			if (step === undefined) continue;
			cells.push({
				text: step.id,
				state: finished || step.done ? "done" : index === nowAt ? "now" : "todo",
			});
		}
		if (keepTo < n) cells.push({ text: `+${n - keepTo} 남음`, state: finished ? "done" : "todo" });
		cells.push({
			text: `판정 ${task.acChecked ?? "-"}/${task.acTotal}`,
			state: finished || review ? "done" : "todo",
		});
		cells.push({ text: "리뷰", state: finished ? "done" : review ? "now" : "todo" });
		cells.push({ text: "착지", state: finished ? "done" : "todo" });
		const nowCell = cells.findIndex((cell) => cell.state === "now");
		const redAt = !blocked ? -1 : nowCell >= 0 ? nowCell : cells.findIndex((cell) => cell.text.startsWith("판정 "));
		const items = cells
			.map((cell, index) => {
				const red = index === redAt;
				const tone = red ? "is-blocked" : cell.state === "done" ? "is-done" : cell.state === "now" ? "is-now" : "";
				const chip = red
					? '<span class="band-chip">막힘</span>'
					: cell.state === "now"
						? '<span class="flow-here-chip">지금 여기</span>'
						: "";
				return `<li class="band-cell${tone === "" ? "" : ` ${tone}`}"${
					cell.state === "now" ? ' aria-current="step"' : ""
				}>${esc(cell.text)}${chip}</li>`;
			})
			.join("");
		return `${blocked ? `<p class="band-blocked">막힘 ${esc(task.progress?.blockedReason ?? "")}</p>` : ""}<ol class="band${
			task.status === "cancelled" ? " is-dim" : ""
		}" aria-label="진행 띠">${items}</ol>`;
	};
	return `<dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>${band()}${checks}${steps}`;
}

/**
 * The `https://discord.com/channels/…` link that opens a Discord conversation: a DM at its message
 * (`discord/dm/…`, `<dm>:<message>`), a server thread or a lane (`<parent>:<thread>`) at the thread, a server channel
 * at its message. "" for a ref that is not two snowflakes, or a server conversation without the one server id (a DM
 * needs none). Self-contained (shipped to the page).
 */
export function discordThreadHref(
	guild: string | null | undefined,
	originKey: string | null | undefined,
	threadRef: string | null | undefined,
): string {
	const ref = /^(\d{17,20}):(\d{17,20})$/.exec(threadRef ?? "");
	if (ref === null) return "";
	const key = (originKey ?? "").replace(/^[^/:]+:/, "");
	if (key.startsWith("discord/dm/")) return `https://discord.com/channels/@me/${ref[1]}/${ref[2]}`;
	if (!guild) return "";
	if (/^discord\/ch\/\d+\/t\/\d+$/.test(key) || key.startsWith("jabbu/work/")) {
		return `https://discord.com/channels/${guild}/${ref[2]}`;
	}
	if (key.startsWith("discord/ch/")) return `https://discord.com/channels/${guild}/${ref[1]}/${ref[2]}`;
	return "";
}

/**
 * A request's TASK chain: the `지금` line and the row of boxes, 요청 first. `focus` marks one TASK box as selected.
 * In the flow view (`panel` false) a TASK box opens its panel in place; inside another view's detail panel (`panel`
 * true) the chain comes in its own section with the `n/m 끝남` count and the boxes go to the flow view's page, since
 * closed TASKs past the snapshot's limit only have a panel there. Self-contained (shipped to the page).
 */
export function renderFlowChain(chain: FlowChainInfo, focus: string, panel: boolean): string {
	const at = (iso: string | null | undefined): string => (iso ? iso.slice(5, 16).replace("T", " ") : "-");
	/** status → [chip, tone of the chip]. */
	const CHIPS: Record<string, [string, string]> = {
		working: ["진행 중", "run"],
		blocked: ["막힘", "fail"],
		review: ["리뷰 대기", "wait"],
		done: ["완료", "done"],
		cancelled: ["취소", "off"],
	};
	const place = chain.place ?? "";
	const request = `<span class="flow-bh"><b>요청</b><span class="flow-chip c-off">${esc(
		[place, at(chain.requestedAt)].filter((part) => part !== "" && part !== "-").join(" · ") || "?",
	)}</span></span><span class="flow-bt">${esc(chain.title)}</span>`;
	const requestBox =
		chain.originKey === ""
			? `<div class="flow-box t-req">${request}</div>`
			: `<a class="flow-box t-req" href="?view=turns&amp;item=${esc(encodeURIComponent(chain.originKey))}">${request}</a>`;
	const box = (step: FlowChainInfo["tasks"][number]): string => {
		const [chip, chipTone] = CHIPS[step.status] ?? [step.status, "off"];
		const here = step.taskId === chain.here;
		const selected = step.taskId === focus;
		const chars = Array.from(step.stage.msg.replace(/\s+/g, " ").trim());
		const clipped = chars.length > 50 ? `${chars.slice(0, 49).join("")}…` : chars.join("");
		const msg = clipped !== "" && step.stage.tone !== "done" ? ` · ${clipped}` : "";
		const open = panel ? "" : ` data-item="${esc(step.taskId)}" data-row="${esc(step.taskId)}"`;
		const took =
			step.typical === undefined || step.elapsedMs === undefined
				? ""
				: `<span class="flow-bs">${esc(
						`경과 ${Math.floor(step.elapsedMs / 60_000)}분 · ${typicalNote(step.elapsedMs, step.typical) ?? ""}`,
					)}</span>`;
		return `<a class="flow-box t-${esc(step.stage.tone)}${here ? " is-here" : ""}${
			selected ? " is-selected" : ""
		}" href="?view=flow&amp;item=${esc(encodeURIComponent(step.taskId))}"${open} data-state="${esc(
			`${step.status}:${step.stage.label}`,
		)}"${selected ? ' aria-current="true"' : ""}><span class="flow-bh"><b>${esc(
			step.taskId,
		)}</b><span class="flow-chip c-${chipTone}">${esc(chip)}</span>${
			here ? '<span class="flow-here-chip">지금 여기</span>' : ""
		}</span><span class="flow-bt">${esc(step.title)}</span><span class="flow-bs s-${esc(step.stage.tone)}">${esc(
			step.stage.label,
		)}${esc(msg)}</span>${took}</a>`;
	};
	/** An open TASK (or one whose close time does not parse) ends this long after its registration, for grouping. */
	const OPEN_JOIN_MS = 10 * 60_000;
	/** `N분` / `N시간 M분`, seconds and part minutes dropped. */
	const span = (ms: number): string => {
		const minutes = Math.floor(ms / 60_000);
		const hours = Math.floor(minutes / 60);
		return hours === 0 ? `${minutes}분` : `${hours}시간 ${minutes % 60}분`;
	};
	/**
	 * Parallel groups: TASKs with a parsable registration time in registration order (stable), a TASK registered at
	 * or after the current group's end opening a new group; TASKs whose registration time does not parse come last,
	 * each its own group with no wait.
	 */
	const groupsOf = (
		tasks: FlowChainInfo["tasks"],
	): Array<{ tasks: FlowChainInfo["tasks"]; first: number; end: number; open: boolean }> => {
		const timed = tasks
			.map((step, index) => ({ step, index, created: Date.parse(step.createdAt) }))
			.filter((item) => Number.isFinite(item.created))
			.sort((a, b) => a.created - b.created || a.index - b.index);
		const groups: Array<{ tasks: FlowChainInfo["tasks"]; first: number; end: number; open: boolean }> = [];
		for (const { step, created } of timed) {
			const closed = step.closedAt === undefined ? Number.NaN : Date.parse(step.closedAt);
			const end = Number.isFinite(closed) ? closed : created + OPEN_JOIN_MS;
			const last = groups[groups.length - 1];
			if (last === undefined || created >= last.end) {
				groups.push({ tasks: [step], first: created, end, open: step.closedAt === undefined });
			} else {
				last.tasks.push(step);
				last.end = Math.max(last.end, end);
				last.open = last.open || step.closedAt === undefined;
			}
		}
		for (const step of tasks) {
			if (Number.isFinite(Date.parse(step.createdAt))) continue;
			groups.push({ tasks: [step], first: Number.NaN, end: Number.NaN, open: step.closedAt === undefined });
		}
		return groups;
	};
	const link = (gap: string): string =>
		`<span class="flow-link">${gap === "" ? "" : `<span class="flow-gap">대기 ${esc(gap)}</span>`}<span class="flow-link-arr" aria-hidden="true"></span></span>`;
	const groups = groupsOf(chain.tasks)
		.map((group, index, all) => {
			const before = all[index - 1];
			const wait =
				before === undefined || before.open || !Number.isFinite(group.first) || !Number.isFinite(before.end)
					? Number.NaN
					: group.first - before.end;
			const gap = Number.isFinite(wait) && wait >= 60_000 ? span(wait) : "";
			const name = group.tasks.length === 1 ? `${index + 1}차` : `${index + 1}차 · 병렬 ${group.tasks.length}`;
			const took = !Number.isFinite(group.first) ? "" : group.open ? "진행 중" : span(group.end - group.first);
			return `${link(gap)}<div class="flow-group" role="group" aria-label="${esc(name)}"><p class="flow-gh"><b>${esc(
				name,
			)}</b>${took === "" ? "" : `<span>${esc(took)}</span>`}</p>${group.tasks.map(box).join("")}</div>`;
		})
		.join("");
	// A TASK waiting for the owner's review: its Outcome card is in the request thread, one click away.
	const review =
		chain.discordHref !== "" && chain.tasks.some((step) => step.status === "review")
			? `<p class="flow-review"><a class="button" href="${esc(chain.discordHref)}" target="_blank" rel="noopener noreferrer">디스코드에서 보기</a></p>`
			: "";
	const body = `<p class="flow-now"><b>지금</b> ${esc(chain.now)}</p>${review}<div class="flow-row">${requestBox}${groups}</div>`;
	return panel
		? `<section class="detail-flow" aria-label="흐름"><h3 class="h3">흐름 <small>${chain.done}/${chain.total} 끝남</small></h3>${body}</section>`
		: body;
}

/**
 * `?task=<ID>`'s detail: title, status, {@link renderTaskFacts}, its agent's card link and a headless TASK's 작업 내역
 * ({@link renderTaskWork}); an unknown ID gets the "지금 목록에 없는 TASK" notice. Both helpers ship beside it.
 */
export function renderTaskDetail(
	taskId: string,
	task: TaskInfo | undefined,
	cardKey?: string,
	chain?: FlowChainInfo,
): string {
	if (task === undefined) {
		return `<p class="eyebrow">TASK ${esc(taskId)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 목록에 없는 TASK예요</h2><p class="lead">닫힌 지 7일이 지났거나 ID가 틀렸어요. 인박스에서 다시 골라 주세요.</p>`;
	}
	const TONES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		blocked: ["막힘", "is-warning"],
		review: ["검토 대기", "is-warning"],
		done: ["완료", "is-success"],
		cancelled: ["취소", ""],
	};
	const [label, tone] = TONES[task.status] ?? [task.status, ""];
	const card =
		cardKey === undefined
			? ""
			: `<a class="button is-ghost" href="?card=${esc(encodeURIComponent(cardKey))}" data-card="${esc(cardKey)}">에이전트 패널 보기</a>`;
	const actions = `<div class="detail-actions"><span class="badge ${tone}">${esc(label)}</span><button type="button" class="copy-btn" data-copy="${esc(task.taskId)}" data-copy-label="TASK ID" aria-label="TASK ID 복사">TASK ID 복사</button><button type="button" class="copy-btn" data-copy="${esc(task.branch)}" data-copy-label="브랜치" aria-label="브랜치 복사">브랜치 복사</button></div>`;
	const leadText =
		task.acChecked === undefined && !task.open
			? `AC ${task.acTotal}개`
			: `AC ${task.acChecked === undefined ? "-" : task.acChecked}/${task.acTotal} · 단계 ${
					task.stepsDone === undefined ? "-" : `${task.stepsDone}/${task.stepsTotal ?? "-"}`
				}`;
	return `<p class="eyebrow">TASK · ${esc(task.host)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
		task.title,
	)}</h2>${actions}<p class="lead">${leadText}</p>${renderTaskFacts(task)}${card}${
		chain === undefined ? "" : renderFlowChain(chain, task.taskId, true)
	}${renderTaskWork(task)}`;
}

/**
 * Head of the card detail panel: what the pane is, where it runs, the "herdr에서 답하기" link and — when the pane
 * carries a TASK — that TASK's facts. A key that is not on the board gets the "지금 보드에 없는 패널" notice.
 * Self-contained apart from {@link renderTaskFacts} (the browser redraws it from the board stream).
 */
export function renderDetailHead(
	key: string,
	card: BoardCard | undefined,
	task: TaskInfo | undefined,
	now: number,
	chain?: FlowChainInfo,
): string {
	if (card === undefined) {
		return `<p class="eyebrow">카드 ${esc(key)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 보드에 없는 패널이에요</h2><p class="lead">패널이 닫혔거나 herdr-web-ui에서 아직 받지 못했어요. 보드에 다시 나타나면 여기에 열려요.</p>`;
	}
	const TONES: Record<string, [string, string]> = {
		working: ["진행 중", "is-info"],
		idle: ["쉬는 중", ""],
		done: ["완료", "is-success"],
		blocked: ["막힘", "is-warning"],
	};
	const [label, tone] = TONES[card.status] ?? [`알 수 없음 · ${card.status}`, "is-warning"];
	const minutes = Math.floor(Math.max(0, now - card.since) / 60_000);
	const ago =
		minutes < 1
			? "방금"
			: minutes < 60
				? `${minutes}분 전`
				: minutes < 1440
					? `${Math.floor(minutes / 60)}시간 전`
					: `${Math.floor(minutes / 1440)}일 전`;
	const badges = [`<span class="badge ${tone}">${esc(label)}</span>`];
	if (card.taskId) badges.push(`<span class="badge is-info">${esc(card.taskId)}</span>`);
	if (task !== undefined) {
		badges.push(
			`<button type="button" class="copy-btn" data-copy="${esc(task.taskId)}" data-copy-label="TASK ID" aria-label="TASK ID 복사">TASK ID 복사</button>`,
			`<button type="button" class="copy-btn" data-copy="${esc(task.branch)}" data-copy-label="브랜치" aria-label="브랜치 복사">브랜치 복사</button>`,
		);
	} else {
		badges.push(
			`<button type="button" class="copy-btn" data-copy="${esc(card.key)}" data-copy-label="카드 키" aria-label="카드 키 복사">카드 키 복사</button>`,
		);
	}
	const lines = [
		`${esc(card.machineName)} · ${esc(card.workspaceLabel)} · ${esc(card.tabLabel)} · ${esc(card.agent)}`,
		card.cwd ? esc(card.cwd) : "",
		card.since === 0 ? `이 상태가 된 시각 - · 카드 ${esc(card.key)}` : `이 상태로 ${ago}부터 · 카드 ${esc(card.key)}`,
	]
		.filter((line) => line !== "")
		.map((line) => `<p class="lead">${line}</p>`)
		.join("");
	// What the pane said: every pending question with all its choices, else why it is blocked, else its last answer.
	const asks =
		card.asks && card.asks.length > 0
			? card.asks
			: card.question
				? [{ question: card.question, options: card.options ?? [] }]
				: [];
	const sayHtml =
		asks.length > 0
			? `<section class="detail-say" aria-label="묻는 말"><h3 class="h3">묻는 말</h3>${asks
					.map(
						(ask) =>
							`<p class="lead">${esc(ask.question)}</p>${
								ask.options.length > 0
									? `<ul class="say-options">${ask.options.map((option) => `<li>${esc(option)}</li>`).join("")}</ul>`
									: ""
							}`,
					)
					.join("")}</section>`
			: card.blocked
				? `<section class="detail-say" aria-label="막힌 이유"><h3 class="h3">막힌 이유</h3><p class="lead">${esc(card.blocked)}</p></section>`
				: card.lastSay
					? `<section class="detail-say" aria-label="마지막 답"><h3 class="h3">마지막 답</h3><p class="lead">${esc(card.lastSay)}</p></section>`
					: "";
	const sayError = card.sayError ? `<p class="note-sub">${esc(card.sayError)}</p>` : "";
	const prompt = card.lastPrompt;
	const promptMinutes = prompt === undefined ? 0 : Math.floor(Math.max(0, now - prompt.at) / 60_000);
	const promptHtml =
		prompt === undefined
			? ""
			: `<section class="detail-say" aria-label="마지막 지시"><h3 class="h3">마지막 지시</h3><p class="lead">${esc(
					prompt.preview,
				)}</p><p class="note-sub">${prompt.kind === "remind" ? "리마인더 · " : prompt.kind === "start" ? "시작 지시 · " : ""}${
					promptMinutes < 1
						? "방금"
						: promptMinutes < 60
							? `${promptMinutes}분 전`
							: promptMinutes < 1440
								? `${Math.floor(promptMinutes / 60)}시간 전`
								: `${Math.floor(promptMinutes / 1440)}일 전`
				}</p></section>`;
	const reply = /^https?:\/\//.test(card.replyUrl ?? "")
		? `<a class="button" href="${esc(card.replyUrl)}" target="_blank" rel="noopener noreferrer">herdr에서 답하기</a>`
		: "";
	const about =
		task === undefined
			? ""
			: `<section class="detail-task" aria-label="TASK"><h3 class="h3">${esc(task.taskId)} ${esc(task.title)}</h3>${renderTaskFacts(task)}<a class="button is-ghost" href="?task=${esc(
					encodeURIComponent(task.taskId),
				)}" data-task="${esc(task.taskId)}">TASK만 보기</a></section>`;
	return `<p class="eyebrow">${esc(card.machineName)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
		card.paneLabel,
	)}</h2><div class="detail-actions">${badges.join("")}</div>${lines}${sayHtml}${sayError}${promptHtml}${reply}${about}${
		chain === undefined || task === undefined ? "" : renderFlowChain(chain, task.taskId, true)
	}`;
}

/**
 * The detail panel of a row of the other views (`?view=<view>&item=<id>`): every field the snapshot has for it, no
 * more. An id not in the snapshot gets the "지금 목록에 없는 항목" notice. A monitor's panel ends in `monitorBody`
 * ({@link renderMonitorDetail}), a loading line until then. Self-contained (shipped to the page).
 */
export function renderItemDetail(s: DashboardSnapshot, view: string, id: string, monitorBody?: string): string {
	const at = (iso: string | null | undefined): string => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "-");
	const dur = (ms: number | null): string => {
		if (ms === null) return "-";
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}초`;
		return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
	};
	const LABELS: Record<string, string> = {
		turns: "턴",
		flow: "흐름",
		lanes: "레인",
		approvals: "승인 대기",
		monitors: "모니터",
		alerts: "알림",
	};
	const show = (title: string, rows: Array<[string, string]>): string =>
		`<p class="eyebrow">${esc(LABELS[view] ?? view)}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
			title,
		)}</h2><dl class="facts">${rows.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>`;
	// 터미널에서 보기: commands to paste on a phone, so no quotes or backticks — a word that would need them (a path with
	// a space, an odd origin key) drops the command rather than show one that breaks. Shown only; nothing runs here.
	const SHELL_WORD = /^[A-Za-z0-9._/:@=+,-]+$/;
	const terminal = (args: string[][]): string => {
		const cli = s.jabbuCli;
		if (cli === undefined) return "";
		const commands = args
			.map((words) => [...cli, ...words])
			.filter((words) => words.every((word) => SHELL_WORD.test(word)))
			.map((words) => words.join(" "));
		if (commands.length === 0) return "";
		return `<details class="detail-terminal"><summary>터미널에서 보기</summary><p class="note-sub">복사해 터미널에 붙여 넣으세요. 현황판은 실행하지 않아요.</p>${commands
			.map(
				(command) =>
					`<div class="terminal-cmd"><code>${esc(command)}</code><button type="button" class="copy-btn" data-copy="${esc(
						command,
					)}" data-copy-label="명령" aria-label="명령 복사">복사</button></div>`,
			)
			.join("")}</details>`;
	};
	const laneCommands = (name: string): string[][] => [
		["lanes", "watch", name],
		["lanes", "attach", name],
	];
	if (view === "turns" && s.jobs.ok) {
		const job = s.jobs.items.find((item) => `job:${item.name}` === id);
		if (job) {
			const [word] = JOB_LABELS[job.health === "ok" ? (job.state ?? "running") : job.health];
			const progressBlock =
				job.progressLines === undefined
					? ""
					: job.progressLines.length === 0
						? '<h3 class="h2">진행 기록</h3><p class="note">진행 기록이 비어 있어요</p>'
						: `<h3 class="h2">진행 기록 (최근 ${job.progressLines.length}줄)</h3><pre class="mon-text">${esc(
								job.progressLines.join("\n"),
							)}</pre>`;
			return `${show(job.title, [
				["상태", `${esc(word)} · ${esc(job.state ?? "-")}`],
				[
					"진행",
					job.done === undefined || job.total === undefined
						? "-"
						: esc(
								`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ""}${job.percent === undefined ? "" : ` (${job.percent}%)`}`,
							),
				],
				["시작", at(job.startedAt)],
				["마지막 갱신", at(job.updatedAt)],
				["마지막 갱신 뒤", dur(job.ageMs)],
				["pid", job.pid === undefined ? "-" : `<code>${esc(job.pid)}</code>`],
				["스레드", esc(job.thread ?? "-")],
				["로그", job.log === undefined ? "-" : `<code>${esc(job.log)}</code>`],
				["진행 파일", job.progress === undefined ? "-" : `<code>${esc(job.progress)}</code>`],
				["작업 디렉터리", job.cwd === undefined ? "-" : `<code>${esc(job.cwd)}</code>`],
				["설명", esc(job.detail ?? "-")],
				["파일", `<code>jobs/${esc(job.name)}.json</code>`],
			])}${progressBlock}`;
		}
	}
	if (view === "turns" && s.turns.ok) {
		// A conversation by its origin key; an inbound id (the old one-turn address) finds the conversation it is in.
		const thread = /^\d+$/.test(id)
			? s.turns.threads.find((item) => item.recent.some((turn) => String(turn.inboundId) === id))
			: s.turns.threads.find((item) => item.originKey === id);
		if (thread) {
			const latest = thread.latest;
			// The conversation's TASK chain, when the request became TASKs.
			const chain = s.flows?.ok ? s.flows.items.find((item) => item.originKey === thread.originKey) : undefined;
			const recent = thread.recent
				.map(
					(turn) =>
						`<li><button type="button" class="turn-recent-item" ${thread.install === undefined ? `data-trace-turn="${esc(turn.inboundId)}"` : "disabled"}><span class="mono">${at(
							turn.createdAt,
						)}</span><span class="badge">${esc(turn.state)}</span><span class="turn-recent-text">${esc(
							turn.preview ?? "-",
						)}</span></button></li>`,
				)
				.join("");
			const model = thread.model;
			const modelName = model === undefined ? "" : model.model.slice(model.model.lastIndexOf("/") + 1);
			return `${show(thread.title, [
				["상태", esc(latest.state)],
				...(model === undefined
					? []
					: ([
							[
								"모델",
								`<span class="badge model-chip${model.fallback ? " is-warning" : ""}" title="${esc(model.model)}">${
									model.fallback ? "폴백 · " : ""
								}${esc(model.thinking === null ? modelName : `${modelName} · ${model.thinking}`)}</span>`,
							],
						] as Array<[string, string]>)),
				["종류", esc(TURN_LABELS.kind[thread.kind])],
				["대기 이유", latest.waitReason === null ? "-" : esc(TURN_LABELS.wait[latest.waitReason])],
				["요청", latest.preview === null ? "-" : esc(latest.preview)],
				["시작", at(latest.createdAt)],
				["경과", dur(latest.ageMs)],
				["마지막 이벤트 뒤", dur(latest.silentMs)],
				["스레드", esc(thread.threadRef ?? "-")],
				["입수 번호", esc(latest.inboundId)],
				["턴", esc(`${thread.turnCount}${thread.openCount > 0 ? ` · ${openTurnsText(thread)}` : ""}`)],
				["대화", `<code>${esc(thread.originKey)}</code>`],
			])}${terminal(
				((lane) => (lane === undefined ? [["lanes", "watch", thread.originKey]] : laneCommands(lane.name)))(
					s.lanes.ok ? s.lanes.items.find((item) => item.originKey === thread.originKey) : undefined,
				),
			)}${chain === undefined ? "" : renderFlowChain(chain, "", true)}<h3 class="h2">최근 턴</h3><ol class="turn-recent" aria-label="최근 턴 (누르면 트레이스)">${recent}</ol>`;
		}
	}
	if (view === "flow" && s.flows?.ok) {
		// The flow carries every one of its TASKs, closed ones past the snapshot's closed-TASK limit included.
		const chain = s.flows.items.find((item) => item.tasks.some((step) => step.taskId === id));
		const step = chain?.tasks.find((item) => item.taskId === id);
		if (chain && step) {
			const STATUS: Record<string, string> = {
				working: "진행 중",
				blocked: "막힘",
				review: "리뷰 대기",
				done: "완료",
				cancelled: "취소",
			};
			const task = s.tasks.ok ? s.tasks.items.find((item) => item.taskId === id) : undefined;
			return `${show(step.title, [
				["TASK", `<code>${esc(step.taskId)}</code>`],
				["상태", esc(STATUS[step.status] ?? step.status)],
				["지금 단계", esc(`${step.stage.label}${step.stage.msg === "" ? "" : ` · ${step.stage.msg}`}`)],
				["위험", esc(step.risk)],
				["호스트", esc(step.host)],
				["브랜치", `<code>${esc(step.branch)}</code>`],
				["등록", at(step.createdAt)],
				["닫힘", at(step.closedAt)],
				["AC", `${step.acTotal}개`],
				[
					"요청",
					chain.originKey === ""
						? esc(chain.title)
						: `<a href="?view=turns&amp;item=${esc(encodeURIComponent(chain.originKey))}">${esc(chain.title)}</a>`,
				],
			])}${
				// An open TASK on this machine: its herdr worker's session (a remote one is watched on its host).
				step.host === "local" && step.status !== "done" && step.status !== "cancelled"
					? terminal([["lanes", "watch", step.taskId]])
					: ""
			}${
				task === undefined
					? ""
					: `<section class="detail-task" aria-label="TASK 진행"><h3 class="h3">진행</h3>${renderTaskFacts(task)}</section>${renderTaskWork(task)}`
			}`;
		}
	}
	if (view === "lanes" && s.lanes.ok) {
		const lane = s.lanes.items.find((item) => item.name === id);
		if (lane) {
			return `${show(lane.title, [
				["이름", esc(lane.name)],
				["상태", esc(lane.status)],
				["cwd", `<code>${esc(lane.cwd)}</code>`],
				["갱신", at(lane.updatedAt)],
			])}${terminal(laneCommands(lane.name))}`;
		}
	}
	if (view === "approvals" && s.approvals.ok) {
		// A pending one, else a settled one of 최근 결정: the same panel with the outcome in place of the countdown.
		const item =
			s.approvals.items.find((approval) => approval.approvalId === id) ??
			s.approvals.recent.find((approval) => approval.approvalId === id);
		if (item) {
			// Same order and labels as the approval card's sections (`DETAIL_SECTIONS` in safety/approval.ts).
			const SECTIONS = [
				["action", "할 일"],
				["why", "이유"],
				["impact", "영향"],
				["rollback", "되돌릴 수 없는 이유"],
			] as const;
			const facts: Array<[string, string]> = [];
			for (const [key, label] of SECTIONS) {
				const value = item.detail?.[key];
				if (value) facts.push([label, esc(value)]);
			}
			if ("status" in item) {
				const word = (APPROVAL_OUTCOMES[item.status] ?? [item.status])[0];
				facts.push(
					["결과", `${esc(word)}${item.tookMs === null ? "" : ` · 요청 ${esc(monitorTook(item.tookMs))} 뒤`}`],
					["요청", at(item.createdAt)],
					["결정", at(item.decidedAt)],
				);
			} else {
				facts.push(
					// Rounded up like the list badge (`N분 남음`), so both read the same minute.
					["남은 시간", item.remainingMs <= 0 ? "만료 처리 중" : `${Math.ceil(item.remainingMs / 60_000)}분`],
					["요청", at(item.createdAt)],
					["만료", at(item.expiresAt)],
				);
			}
			facts.push(["요청한 곳", esc(item.originLabel ?? "-")]);
			// A Discord card has no stored permalink: open the asking thread instead.
			const originUrl =
				item.originUrl ?? (discordThreadHref(s.discordGuild, item.originKey, item.originThreadRef) || null);
			const links = [
				item.cardUrl === null
					? ""
					: `<a class="button" href="${esc(item.cardUrl)}" target="_blank" rel="noopener noreferrer">카드 열기</a>`,
				originUrl === null
					? ""
					: `<a class="button is-ghost" href="${esc(originUrl)}" target="_blank" rel="noopener noreferrer">요청 스레드 열기</a>`,
			].join("");
			return `<p class="eyebrow">${"status" in item ? "승인 결정" : esc(LABELS[view])}</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(
				item.title,
			)}</h2>${item.summary.trim() === item.title ? "" : `<p class="lead detail-summary">${esc(item.summary)}</p>`}${
				item.detail === null ? '<p class="lead">세부 내용 없음(요약만 받은 요청)</p>' : ""
			}<dl class="facts">${facts.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${value}</dd>`).join("")}</dl>${
				links !== ""
					? `<div class="detail-actions">${links}</div>`
					: "status" in item
						? ""
						: `<p class="lead">${
								item.originKey?.startsWith("discord/") ? "디스코드" : "채팅"
							}의 승인 메시지에서 승인하거나 거절해요.</p>`
			}<details class="detail-internal"><summary>내부 정보</summary><dl class="facts"><dt>승인 ID</dt><dd><code>${esc(
				item.approvalId,
			)}</code></dd><dt>대화</dt><dd><code>${esc(item.originKey ?? "-")}</code></dd></dl></details>`;
		}
	}
	if (view === "monitors" && s.monitors.ok) {
		// By id; a link from before ids (`item=<name>`) opens the same panel.
		const monitor = s.monitors.items.find((item) => item.id === id || item.name === id);
		if (monitor) {
			const sends = [
				monitor.destination,
				...(monitor.copyTo === null ? [] : [`사본 ${monitor.copyTo}`]),
				monitor.deliver === "verbatim" ? "원문 그대로" : "턴으로 답",
			];
			// Snapshot facts now; the rest once the page has read `api/monitor/detail`.
			return `${show(monitor.name, [
				["일정", `${esc(monitor.schedule)}${monitor.cron === null ? "" : ` <code>${esc(monitor.cron)}</code>`}`],
				["다음 실행", at(monitor.nextFireAt)],
				["겹침 정책", monitor.overlap === "skip" ? "건너뜀" : "줄 세움"],
				["보내는 곳", esc(sends.join(" · "))],
				["모델", esc(monitorModelDetail(monitor))],
				[
					"상태",
					esc(
						[
							...(monitor.running ? ["실행 중"] : []),
							...(monitor.failStreak > 0 ? [`연속 실패 ${monitor.failStreak}회`] : []),
							monitor.openIncidents > 0 ? `열린 사건 ${monitor.openIncidents}` : "열린 사건 없음",
						].join(" · "),
					),
				],
				[
					`최근 ${monitor.stats.days}일`,
					esc(
						[
							`전달 ${monitor.stats.delivered}`,
							`조용히 끝남 ${monitor.stats.quiet}`,
							`실패 ${monitor.stats.failed}`,
							...(monitor.stats.skipped > 0 ? [`건너뜀 ${monitor.stats.skipped}`] : []),
							...(monitor.stats.medianMs === null ? [] : [`정기 실행 중앙값 ${monitorTook(monitor.stats.medianMs)}`]),
						].join(" · "),
					),
				],
			])}${
				// The monitor's own conversation, while the turn board still lists it.
				monitor.originKey !== null &&
				s.turns.ok &&
				s.turns.threads.some((thread) => thread.originKey === monitor.originKey)
					? `<div class="detail-actions"><a class="button is-ghost" href="?view=turns&amp;item=${esc(
							encodeURIComponent(monitor.originKey),
						)}">이 모니터의 대화 보기</a></div>`
					: ""
			}<div class="mon-detail">${
				monitorBody ??
				'<div class="skeleton" role="status"><p class="note-sub">하는 일과 최근 실행을 불러오는 중…</p><div class="skeleton-bar is-w70"></div><div class="skeleton-bar is-w90"></div><div class="skeleton-bar is-w50"></div></div>'
			}</div>`;
		}
	}
	if (view === "alerts" && s.alerts.ok) {
		const alert = s.alerts.items.find((item) => String(item.incidentId) === id);
		if (alert) {
			const text = alertText(alert.scope);
			const gate = text.gate === undefined || !s.gates.ok ? undefined : s.gates.items.find((g) => g.name === text.gate);
			const state =
				alert.gateState === "open"
					? "지금 열림"
					: alert.gateState === "closed"
						? "지금은 닫힘 · 기록만 남음"
						: alert.gateState === "unknown"
							? "상태 모름"
							: "기록만 남음";
			const rows: Array<[string, string]> = [
				["상태", `${esc(state)} · 기록 ${esc(alert.status)}`],
				["할 일", esc(text.todo).replace(/`([^`]+)`/g, "<code>$1</code>")],
				["범위", `<code>${esc(alert.scope)}</code>`],
				[
					"서명",
					`<code>${esc(alert.signature)}</code><button type="button" class="copy-btn" data-copy="${esc(
						alert.signature,
					)}" data-copy-label="서명" aria-label="서명 복사">복사</button>`,
				],
				["인시던트", `<code>${esc(alert.incidentId)}</code>`],
				["횟수", `${alert.count}회`],
				["처음", at(alert.firstAt)],
				["마지막", at(alert.lastAt)],
			];
			if (text.gate !== undefined) {
				rows.push(["게이트 detail", gate === undefined ? "-" : `<code>${esc(gate.detail)}</code>`]);
			}
			return show(text.title, rows);
		}
	}
	return `<p class="eyebrow">${esc(LABELS[view] ?? "항목")}</p><h2 class="detail-title" id="detail-title" tabindex="-1">지금 목록에 없는 항목이에요</h2><p class="lead">처리됐거나 닫혀서 목록에서 빠졌어요. 왼쪽 목록에서 다시 골라 주세요.</p>`;
}

/**
 * A monitor's `api/monitor/detail` answer as its panel's end: 하는 일, procedure files, 최근 실행; all text escaped.
 * Self-contained apart from `MONITOR_STAGES`/`monitorTook` (shipped to the page).
 */
export function renderMonitorDetail(body: unknown): string {
	const answer = (body ?? {}) as {
		instruction?: string;
		procedures?: MonitorProcedure[];
		runs?: MonitorDetailRun[];
		error?: string;
	};
	if (typeof answer.instruction !== "string") {
		return `<p class="note">하는 일과 최근 실행을 읽지 못했어요 (${esc(answer.error ?? "알 수 없는 응답")})</p>`;
	}
	const at = (iso: string): string => esc(iso.slice(5, 16).replace("T", " "));
	const files = (Array.isArray(answer.procedures) ? answer.procedures : [])
		.map(
			(file) =>
				`<h3 class="h2">절차 파일 <code>${esc(file.name)}</code></h3>${
					"text" in file
						? `<pre class="mon-text">${esc(file.text)}</pre>${file.truncated ? '<p class="note-sub">앞 2000자만 보여요.</p>' : ""}`
						: '<p class="note">지금 읽을 수 없어요.</p>'
				}`,
		)
		.join("");
	const runs = (Array.isArray(answer.runs) ? answer.runs : []).map((run) => {
		const [word, tone] = MONITOR_STAGES[run.stage] ?? [run.stage || "?", ""];
		const took =
			run.durationMs === null ? "진행 중" : `${run.attempts > 0 ? "지연 포함 " : ""}${monitorTook(run.durationMs)}`;
		const notes = [
			...(run.manual ? ["수동"] : []),
			...(run.attempts > 0 ? [`재시도 ${run.attempts}회`] : []),
			...(run.error ? [run.error] : []),
		];
		return `<tr><td class="num">${at(run.slotAt)}</td><td><span class="mon-dot ${tone}${
			run.manual ? " is-manual" : ""
		}" aria-hidden="true"></span> ${esc(word)}</td><td>${esc(took)}</td><td>${
			notes.length === 0 ? "-" : esc(notes.join(" · "))
		}</td></tr>`;
	});
	return `<h3 class="h2">하는 일</h3><pre class="mon-text" data-block="instruction">${esc(
		answer.instruction,
	)}</pre>${files}<h3 class="h2">최근 실행</h3>${
		runs.length === 0
			? '<p class="note">실행 기록이 아직 없어요.</p>'
			: `<table class="mon-runs"><thead><tr><th scope="col">예정 시각</th><th scope="col">결과</th><th scope="col">끝날 때까지</th><th scope="col">비고</th></tr></thead><tbody>${runs.join(
					"",
				)}</tbody></table>`
	}`;
}

/**
 * A lane's or TASK's change (`api/diff` answer) as the detail panel: a title, the totals and one folded block per
 * file (+/- counts in the summary, hunks inside, added/removed lines coloured). `body` undefined = still being read.
 * All text escaped; self-contained (shipped to the page).
 */
export function renderDiffDetail(subject: string, body?: unknown): string {
	const head = `<p class="eyebrow">변경 보기</p><h2 class="detail-title" id="detail-title" tabindex="-1">${esc(subject)}</h2>`;
	if (body === undefined) return `${head}<p class="note">변경 내용을 불러오는 중이에요…</p>`;
	const answer = body as {
		sha?: string;
		base?: string;
		files?: { path: string; added: number; deleted: number; binary: boolean; hunks: string }[];
		truncated?: boolean;
		error?: string;
	};
	if (!Array.isArray(answer.files))
		return `${head}<p class="note">변경 내용을 읽지 못했어요 (${esc(answer.error ?? "알 수 없는 응답")})</p>`;
	const added = answer.files.reduce((sum, file) => sum + file.added, 0);
	const deleted = answer.files.reduce((sum, file) => sum + file.deleted, 0);
	const lines = (hunks: string): string =>
		hunks
			.split("\n")
			.map((line) => {
				const tone = line.startsWith("@@") ? "dh" : line.startsWith("+") ? "da" : line.startsWith("-") ? "dd" : "";
				return `<span class="${tone}">${esc(line)}</span>`;
			})
			.join("");
	const files = answer.files.map(
		(file) =>
			`<details class="diff-file"><summary><span class="diff-path">${esc(file.path)}</span> <span class="diff-add">+${esc(file.added)}</span> <span class="diff-del">−${esc(file.deleted)}</span>${
				file.binary ? " 바이너리" : ""
			}</summary>${file.binary ? "" : `<pre class="diff-code">${lines(file.hunks)}</pre>`}</details>`,
	);
	return `${head}<p class="lead">파일 ${answer.files.length}개 · +${added} −${deleted} · ${esc(String(answer.base ?? "").slice(0, 12))} → ${esc(
		String(answer.sha ?? "").slice(0, 12),
	)}</p>${answer.truncated ? '<p class="note">너무 커서 일부가 잘렸어요 (잘림).</p>' : ""}${files.join("")}`;
}

/**
 * The detail panel's tab buttons: a herdr card's 개요/대화/plan (+ 트레이스 for a local omp worker, `withTrace`), a
 * conversation's 개요/대화/트레이스 (turn board), or a background job's 개요/트레이스. Self-contained (shipped to the page).
 */
export function renderDetailTabs(mode: "card" | "thread" | "job", selected: string, withTrace = false): string {
	const tabs =
		mode === "thread"
			? [
					["head", "개요", "detail-head"],
					["conv", "대화", "detail-conv"],
					["trace", "트레이스", "detail-trace"],
				]
			: mode === "job"
				? [
						["head", "개요", "detail-head"],
						["trace", "트레이스", "detail-trace"],
					]
				: [
						["head", "개요", "detail-head"],
						["conv", "대화", "detail-conv"],
						["plan", "plan", "detail-plan"],
						...(withTrace ? [["trace", "트레이스", "detail-trace"]] : []),
					];
	return tabs
		.map(
			([id, label, panel]) =>
				`<button id="tab-${id}" class="tab" type="button" role="tab" data-tab="${id}" aria-controls="${panel}" aria-selected="${id === selected}">${label}</button>`,
		)
		.join("");
}

/** herdr-web-ui's plan answer as a step list; nothing when the pane has no plan. Self-contained (shipped to the page). */
export function renderPlan(body: unknown): string {
	const steps = (body as { plan?: { steps?: unknown } | null } | null)?.plan?.steps;
	if (!Array.isArray(steps) || steps.length === 0) return "";
	const WORDS: Record<string, [string, string]> = {
		pending: ["대기", ""],
		in_progress: ["진행", "is-info"],
		completed: ["완료", "is-success"],
	};
	const items = steps.map((step: { label?: unknown; status?: unknown; active?: unknown } | null) => {
		const status = String(step?.status ?? "");
		const [word, tone] = WORDS[status] ?? [status || "?", ""];
		const active = typeof step?.active === "string" && step.active !== "" ? ` · ${esc(step.active)}` : "";
		return `<li><span class="badge ${tone}">${esc(word)}</span><span>${esc(step?.label)}${active}</span></li>`;
	});
	return `<h3 class="h2">plan</h3><ol class="plan">${items.join("")}</ol>`;
}

/**
 * herdr-web-ui's conversation answer (`{ turns, cursor }`) as turn cards, oldest first, with "이전 대화 더 보기" when
 * a page before them exists. Message text goes through `md` (the page passes {@link renderMarkdown}); every other
 * string is escaped. Self-contained (shipped to the page).
 */
export function renderConversation(body: unknown, agent: string, md: (text: string) => string, now: number): string {
	const answer = (body ?? {}) as { turns?: unknown; cursor?: unknown };
	if (!Array.isArray(answer.turns)) return '<p class="block-note">대화를 읽지 못했어요</p>';
	const more =
		typeof answer.cursor === "string"
			? `<button class="more" type="button" data-before="${esc(answer.cursor)}">이전 대화 더 보기</button>`
			: "";
	if (answer.turns.length === 0) return `<h3 class="h2">대화</h3>${more}<p class="block-note">아직 대화가 없어요</p>`;
	const OUTPUT_CHARS = 4000;
	const fold = (title: string, inner: string, cls = ""): string =>
		`<details class="fold${cls ? ` ${cls}` : ""}"><summary>${title}</summary>${inner}</details>`;
	const part = (p: Record<string, unknown> | null): string => {
		const text = typeof p?.text === "string" ? p.text : "";
		switch (p?.kind) {
			case "text":
				return `<div class="md">${md(text)}</div>`;
			case "thinking":
				return fold("생각", `<div class="md">${md(text)}</div>`);
			case "compact":
				return fold("이전 대화 요약", `<div class="md">${md(text)}</div>`);
			case "tool": {
				const output = typeof p.output === "string" ? p.output : "";
				const cut =
					output.length > OUTPUT_CHARS ? `<p class="turn-note">… ${output.length - OUTPUT_CHARS}자 생략</p>` : "";
				// `running`: a call with no result yet (omp sessions); herdr parts never carry it.
				const running = p.running === true;
				return fold(
					`<code class="mono"><b>${esc(p.name)}</b></code> <span>${esc(p.summary)}</span>${
						running
							? ' <span class="badge is-info">진행 중</span>'
							: p.error
								? ' <span class="badge is-danger">실패</span>'
								: ' <span class="badge is-success">완료</span>'
					}`,
					output === ""
						? `<p class="turn-note">${running ? "결과를 기다리는 중" : "출력 없음"}</p>`
						: `<pre class="md-code"><code>${esc(output.slice(0, OUTPUT_CHARS))}</code></pre>${cut}`,
					"tool-call",
				);
			}
			case "image":
				return '<p class="turn-note">이미지</p>';
			case "notice":
				return `<p class="turn-note">${esc(text)}</p>`;
			case "skill":
				return `<p class="turn-note">스킬 ${esc((p.skill as { name?: unknown } | undefined)?.name)}</p>`;
			case "task_result":
				return `<ul class="turn-tasks">${(Array.isArray(p.tasks) ? p.tasks : [])
					.map(
						(task: { title?: unknown; status?: unknown } | null) =>
							`<li>${esc(task?.title)} · ${esc(task?.status)}</li>`,
					)
					.join("")}</ul>`;
			default:
				return "";
		}
	};
	const turns = answer.turns.map((turn: { role?: unknown; ts?: unknown; parts?: unknown } | null) => {
		const user = turn?.role === "user";
		const at = typeof turn?.ts === "number" ? turn.ts : typeof turn?.ts === "string" ? Date.parse(turn.ts) : Number.NaN;
		const minutes = Math.floor(Math.max(0, now - at) / 60_000);
		const when = Number.isNaN(at)
			? ""
			: minutes < 1
				? "방금"
				: minutes < 60
					? `${minutes}분 전`
					: minutes < 1440
						? `${Math.floor(minutes / 60)}시간 전`
						: `${Math.floor(minutes / 1440)}일 전`;
		const parts = (Array.isArray(turn?.parts) ? turn.parts : []).map(part).join("");
		return `<article class="turn${user ? " is-user" : ""}"><p class="turn-head"><b>${user ? "나" : esc(agent)}</b><span>${when}</span></p>${parts}</article>`;
	});
	return `<h3 class="h2">대화</h3>${more}${turns.join("")}`;
}

/**
 * The "생성 중" block under the conversation from a daemon `live` view: the text being written (through `md`), its
 * thinking (folded), tool calls being written, running tools with their output tail, and a retry line. `settling`:
 * the message ended and the block stays as "확정 중" until the conversation is read again; `error`: the daemon
 * cannot be asked; `fail`: that read failed; `elapsedMs`: time since the view arrived, added to tool ages. Empty when
 * there is nothing to show. Every string but the text and thinking is escaped. Self-contained (shipped to the page).
 */
export function renderLiveTurn(
	live: unknown,
	md: (text: string) => string,
	state: { settling?: boolean; error?: string; fail?: string; elapsedMs?: number },
): string {
	if (state.error === "daemon_unreachable") {
		return '<p class="turn-note live-down">데몬에 연결할 수 없어 실시간 내용을 못 받고 있어요</p>';
	}
	const view = (live ?? {}) as {
		text?: unknown;
		thinking?: unknown;
		toolCalls?: unknown;
		running?: unknown;
		done?: unknown;
		retry?: { attempt?: unknown; error?: unknown } | null;
	};
	const text = typeof view.text === "string" ? view.text : "";
	const thinking = typeof view.thinking === "string" ? view.thinking : "";
	const calls = Array.isArray(view.toolCalls) ? view.toolCalls : [];
	const running = Array.isArray(view.running) ? view.running : [];
	const done = Array.isArray(view.done) ? view.done : [];
	const retry = view.retry ?? undefined;
	if (text === "" && thinking === "" && calls.length === 0 && running.length === 0 && retry === undefined) return "";
	const extra = Math.max(0, state.elapsedMs ?? 0);
	const age = (ms: unknown, plus = extra): string => {
		const seconds = Math.floor(((typeof ms === "number" ? ms : 0) + plus) / 1000);
		return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
	};
	const head = state.settling
		? '<span class="live-state">확정 중</span>'
		: '<span class="live-state"><span class="live-spin" aria-hidden="true"></span>생성 중</span>';
	const parts = [
		retry === undefined ? "" : `<p class="turn-note">재시도 ${esc(retry.attempt)}회 · ${esc(retry.error)}</p>`,
		thinking === ""
			? ""
			: `<details class="fold" data-fold="thinking"><summary>생각</summary><div class="md">${md(thinking)}</div></details>`,
		text === "" ? "" : `<div class="md">${md(text)}</div>`,
		...calls.map(
			(call: { name?: unknown; summary?: unknown } | null) =>
				`<p class="live-tool"><code class="mono"><b>${esc(call?.name)}</b></code> <span>${esc(call?.summary)}</span> <span class="badge">준비 중</span></p>`,
		),
		done.length === 0
			? ""
			: `<ol class="live-steps" aria-label="도구 단계">${[
					...done.map(
						(step: { name?: unknown; summary?: unknown; ms?: unknown; failed?: unknown } | null, i: number) =>
							`<li class="live-step is-${step?.failed === true ? "failed" : "done"}" data-step="${i}"><span class="step-mark" aria-hidden="true">${
								step?.failed === true
									? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m5 5 6 6M11 5l-6 6"/></svg>'
									: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path class="step-tick" d="m4.5 8.4 2.2 2.2 4.8-5"/></svg>'
							}</span><code class="mono"><b>${esc(step?.name)}</b></code> <span class="step-sum">${esc(step?.summary)}</span><span class="step-time">${
								step?.failed === true ? "실패 · " : ""
							}${age(step?.ms, 0)}</span></li>`,
					),
					...running.map(
						(tool: { name?: unknown; summary?: unknown; ageMs?: unknown } | null) =>
							`<li class="live-step is-running"><span class="step-mark" aria-hidden="true"><span class="live-spin"></span></span><code class="mono"><b>${esc(tool?.name)}</b></code> <span class="step-sum is-shimmer">${esc(tool?.summary)}</span><span class="step-time">${age(tool?.ageMs)}</span></li>`,
					),
				].join("")}</ol>`,
		...(done.length > 0 ? [] : running).map(
			(tool: { name?: unknown; summary?: unknown; ageMs?: unknown; outputTail?: unknown } | null, i: number) =>
				`<details class="fold tool-call" data-fold="run-${i}" open><summary><code class="mono"><b>${esc(tool?.name)}</b></code> <span>${esc(tool?.summary)}</span> <span class="badge is-info">진행 중 · ${age(tool?.ageMs)}</span></summary>${
					typeof tool?.outputTail === "string" && tool.outputTail !== ""
						? `<pre class="md-code"><code>${esc(tool.outputTail)}</code></pre>`
						: '<p class="turn-note">출력을 기다리는 중</p>'
				}</details>`,
		),
		state.fail ? `<p class="turn-note">${esc(state.fail)}</p>` : "",
	];
	return `<article class="turn is-live${state.settling ? " is-settling" : ""}" aria-busy="${state.settling ? "false" : "true"}"><p class="turn-head"><b>omp</b>${head}</p>${parts.join("")}</article>`;
}
