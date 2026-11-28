import { typicalNote } from "../store/turn-duration";
import {
	channelDisplayTitle,
	effectiveLaneColumn,
	isChannelMainOrigin,
	isLaneOriginKey,
	laneLandBadge,
} from "./channel-meta";
import { contextBar } from "./load-view";
import type { DashboardSnapshot, JobInfo, LaneInfo } from "./snapshot";
import { esc, JOB_LABELS, openTurnsText, TURN_LABELS } from "./text";

/**
 * Self-contained lane-aware turns board renderer shipped into `SCRIPT` (`html.ts`).
 * Keep module-level references strictly to globals already shipped in `SCRIPT`.
 */

export interface TurnsViewUi {
	q?: string;
	sort?: string;
	desc?: boolean;
	layout?: string;
	bot?: string;
}

export interface TurnsViewHelpers {
	head: (title: string, count: number | string | undefined, extra?: string) => string;
	viewTools: string;
	banners: string[];
	failed: (error: string) => string;
	nothing: string;
	badge: (text: string, tone: string, html?: string) => string;
	state: (name: string, prefix?: string) => string;
	at: (iso: string | null | undefined) => string;
	dur: (ms: number | null | undefined) => string;
	ago: (since: number) => string;
	msOf: (iso: string | undefined) => number;
	hit: (...texts: unknown[]) => boolean;
	isSel: (id: string) => boolean;
	overlapOf: (key: string) => string[];
	agyTitle: (key: string) => string;
	row: (id: string, badges: string[], title: string, sub: string[]) => string;
	botFilters: (items: Array<{ column: string; install?: string }>, active: string) => string;
	fmtRatio: (context: { percent: number; tokens: number; tokensOnly?: true } | undefined) => string;
}

/** Renders the `턴` view: background jobs, fixed channel main strip, and 3-column (or list) lane/thread work board. */
export function renderTurnsView(
	s: DashboardSnapshot,
	ui: TurnsViewUi,
	d: DashboardSnapshot["daemon"],
	clock: number,
	h: TurnsViewHelpers,
): string {
	const { badge, state, at, dur, ago, msOf, hit, isSel, overlapOf, agyTitle, fmtRatio } = h;
	const q = (ui.q ?? "").trim();
	const turns = s.turns;
	const jobs = s.jobs;
	const jobRow = (job: JobInfo): string => {
		const [word, tone] = JOB_LABELS[job.health === "ok" ? (job.state ?? "running") : job.health];
		const counts =
			job.done === undefined || job.total === undefined
				? ""
				: `${
						job.percent === undefined
							? ""
							: `<span class="meter" role="img" aria-label="진행 ${job.percent}%"><i style="width:${job.percent}%"></i></span> `
					}${esc(`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ""}${job.percent === undefined ? "" : ` (${job.percent}%)`}`)}`;
		return h.row(`job:${job.name}`, [badge(word, tone)], esc(job.title), [
			counts,
			`${job.startedAt ? `시작 ${at(job.startedAt)} · ` : ""}마지막 갱신 뒤 ${dur(job.ageMs)}`,
			job.thread ? `스레드 ${esc(job.thread)}` : "",
			esc(job.detail ?? ""),
		]);
	};
	const shownJobs = jobs.ok ? jobs.items.filter((job) => hit(job.title, job.name, job.detail, job.thread)) : [];
	const finished = (job: JobInfo): boolean => (job.state === "done" || job.state === "stopped") && job.health === "ok";
	const liveJobs = shownJobs.filter((job) => !finished(job));
	const doneJobs = shownJobs.filter(finished);
	const jobTop = !jobs.ok
		? `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2></div>${h.failed(jobs.error)}`
		: liveJobs.length === 0
			? ""
			: `<div class="view-head" id="jobs"><h2 class="h2">백그라운드 작업</h2><span class="count-chip">${liveJobs.length}</span></div><div class="rows">${liveJobs.map(jobRow).join("")}</div>`;
	const jobDone =
		doneJobs.length === 0
			? ""
			: `<details class="closed" id="closed"><summary>끝난 백그라운드 작업 <span class="count-chip">${doneJobs.length}</span></summary><div class="rows">${doneJobs.map(jobRow).join("")}</div></details>`;
	const runningJobs = jobs.ok ? jobs.items.filter((job) => job.state === "running").length : 0;
	if (!turns.ok)
		return `${h.head("턴", undefined, h.viewTools)}${h.banners.join("")}${h.failed(turns.error)}${jobTop}${jobDone}`;

	const draining = d.ok && (d.drain !== undefined || d.heartbeat?.draining === true);
	const holding = turns.items.filter((turn) => turn.blocksRestart);
	const oldest = holding.reduce((max, turn) => Math.max(max, turn.ageMs), 0);
	const drainLine = draining
		? `<p class="notice is-warning" role="status">${badge("재시작 준비 중", "is-warning")}<span>${
				holding.length === 0
					? "남은 도구 실행·승인이 끝나면 재시작합니다."
					: `진행 중인 턴 ${holding.length}개가 끝나면 재시작합니다 (가장 오래된 턴 경과 ${dur(oldest)}).`
			} 그동안 들어온 요청은 재시작 뒤 처리됩니다.</span></p>`
		: "";

	const laneList = s.lanes.ok ? s.lanes.items : [];
	const laneByOrigin = new Map(laneList.map((lane) => [lane.originKey, lane]));
	type ThreadCol = "attention" | "working" | "done";
	const colOf = (thread: (typeof turns.threads)[number]): ThreadCol => {
		const lane = laneByOrigin.get(thread.originKey);
		return lane ? effectiveLaneColumn(lane, thread.column) : thread.column;
	};
	const bot = ui.bot ?? "";
	const botOk = (item: { install?: string }, col: string) =>
		bot === "" || (bot === "own" ? !item.install : bot === "attention" ? col === "attention" : item.install === bot);
	const threadOriginSet = new Set(turns.threads.map((thread) => thread.originKey));
	const allExtraLanes = laneList.filter((lane) => !threadOriginSet.has(lane.originKey));
	const threads = turns.threads.filter(
		(t) =>
			botOk(t, colOf(t)) &&
			hit(
				t.title,
				isChannelMainOrigin(t.originKey) ? channelDisplayTitle(t, s.channelNames) : "",
				t.latest.preview,
				t.originKey,
				t.threadRef,
				t.install,
				...(t.jobs ?? []),
			),
	);
	const extraLanes = allExtraLanes.filter(
		(lane) => botOk(lane, effectiveLaneColumn(lane)) && hit(lane.title, lane.name, lane.repo, lane.cwd, lane.install),
	);
	const openThreads =
		turns.threads.filter((thread) => colOf(thread) === "working").length +
		allExtraLanes.filter((lane) => effectiveLaneColumn(lane) === "working").length;
	const bg = runningJobs > 0 ? ` · <a href="#jobs">백그라운드 작업 <b>${runningJobs}</b></a>` : "";
	const sum =
		q === "" ? `진행 중 스레드 <b>${openThreads}</b>` : `검색 결과 <b>${threads.length + extraLanes.length}</b>건`;
	const title = h.head("턴", undefined, `<span class="view-sum">${sum}${bg}</span>${h.viewTools}`);
	if (turns.threads.length === 0 && allExtraLanes.length === 0) {
		return liveJobs.length > 0
			? `${title}${h.banners.join("")}${drainLine}${jobTop}${jobDone}`
			: `${title}${h.banners.join("")}${drainLine}${jobTop}<div class="empty-box"><p class="note">최근 24시간 턴이 없어요</p><p class="note-sub">채팅 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다.</p></div>${jobDone}`;
	}

	const THREAD_RANK: Record<ThreadCol, number> = { attention: 0, working: 1, done: 2 };
	const restartHeld = new Set(holding.map((turn) => turn.originKey));
	const placeOf = (key: string): string => {
		if (isLaneOriginKey(key)) {
			const lane = laneByOrigin.get(key);
			return lane ? `레인 · ${lane.install ?? "본체"}${lane.repo ? ` · ${lane.repo}` : ""}` : "레인";
		}
		if (/^([^/:]+:)?[a-z]+\/dm\//.test(key)) return "DM";
		const channel = /^(?:[^/:]+:)?(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(key);
		if (channel !== null) {
			const named = channel[2] ? s.channelNames?.[channel[2]] : undefined;
			const id = named ?? `${channel[1] === "discord" ? "Discord " : ""}${channel[2] ?? ""}`;
			return channel[3] === undefined ? `${id} 채널 메인` : id;
		}
		return key.startsWith("monitor/") ? "" : key;
	};
	const threadLink = (key: string): string =>
		`href="?view=turns&amp;item=${esc(encodeURIComponent(key))}" data-item="${esc(key)}"`;
	const jobByName = new Map((s.jobs.ok ? s.jobs.items : []).map((job) => [job.name, job]));
	const threadJobBadge = (thread: (typeof threads)[number]): string => {
		const names = thread.jobs ?? [];
		if (names.length === 0) return "";
		const sorted = names
			.slice()
			.sort(
				(a, b) =>
					(jobByName.get(b) ? msOf(jobByName.get(b)?.updatedAt) : -1) -
					(jobByName.get(a) ? msOf(jobByName.get(a)?.updatedAt) : -1),
			);
		const target = `job:${sorted[0]}`;
		return `<a class="badge is-info card-job" href="?view=turns&amp;item=${esc(encodeURIComponent(target))}" data-item="${esc(target)}" title="${esc(sorted.join(", "))}">백그라운드 작업 ${names.length}</a>`;
	};
	const prBadge = (url?: string): string =>
		url
			? `<a class="badge is-info card-job" href="${esc(url)}" target="_blank" rel="noopener noreferrer">PR 보기 ↗</a>`
			: "";
	const threadBadges = (thread: (typeof threads)[number]): string => {
		const lane = laneByOrigin.get(thread.originKey);
		const land = laneLandBadge(lane?.landState);
		return [
			state(thread.latest.state),
			...(lane?.status === "paused" ? [badge("멈춤", "is-warning")] : []),
			...(land === undefined ? [] : [badge(land[0], land[1])]),
			...(thread.stalledCount > 0 ? [badge("정체", "is-warning")] : []),
			...(restartHeld.has(thread.originKey) ? [badge("재시작이 기다리는 턴", "is-warning")] : []),
			...(thread.jobs && thread.jobs.length > 0 ? [threadJobBadge(thread)] : []),
			...(lane?.prUrl ? [prBadge(lane.prUrl)] : []),
			...overlapOf(thread.originKey),
		].join("");
	};
	const byRecent = (a: (typeof threads)[number], b: (typeof threads)[number]): number =>
		THREAD_RANK[colOf(a)] - THREAD_RANK[colOf(b)] || msOf(b.updatedAt) - msOf(a.updatedAt);
	const modelChip = (model: (typeof threads)[number]["model"]): string => {
		if (model === undefined) return "";
		const name = model.model.slice(model.model.lastIndexOf("/") + 1);
		return `<span class="badge model-chip${model.fallback ? " is-warning" : ""}" title="${esc(model.model)}">${model.fallback ? "폴백 · " : ""}${esc(model.thinking === null ? name : `${name} · ${model.thinking}`)}</span>`;
	};
	const cardHtml = (p: {
		row: string;
		agyKey: string;
		stateAttr: string;
		cls?: string;
		link: string;
		eyebrow: string;
		title: string;
		sum: string;
		recent: string;
		badges: string;
		time: string;
		meta: string;
	}): string =>
		`<article class="card card-thread${p.cls ?? ""}${isSel(p.row) ? " is-selected" : ""}"${agyTitle(p.agyKey)} data-state="${esc(p.stateAttr)}" data-row="${esc(p.row)}"><a class="card-link" data-row-link ${p.link}${isSel(p.row) ? ' aria-current="true"' : ""}><p class="card-eyebrow">${p.eyebrow}</p><p class="card-title">${esc(p.title)}</p>${p.sum === "" ? "" : `<p class="card-sum">${p.sum}</p>`}${p.recent}</a><div class="card-foot"><span class="badges">${p.badges}</span><span class="card-time">${p.time}</span>${p.meta === "" ? "" : `<span class="card-meta">${p.meta}</span>`}</div></article>`;
	const threadCard = (thread: (typeof threads)[number], channel = false): string => {
		const key = thread.originKey;
		const col = colOf(thread);
		const place = placeOf(key);
		const latest = thread.latest;
		const lane = laneByOrigin.get(key);
		const cardTitle = channel
			? channelDisplayTitle(thread, s.channelNames)
			: lane
				? lane.install
					? `${lane.install} · ${lane.title}`
					: lane.title
				: thread.title;
		const sum = [
			latest.preview !== null && latest.preview !== cardTitle ? `<span>${esc(latest.preview)}</span>` : "",
			latest.waitReason === null ? "" : `<span class="card-wait">${esc(TURN_LABELS.wait[latest.waitReason])}</span>`,
		]
			.filter((part) => part !== "")
			.join(" · ");
		const prev = channel
			? thread.recent
					.slice(1)
					.filter((t) => t.preview !== null)
					.slice(0, 2)
					.map((t) => t.preview as string)
			: [];
		const metaParts = [`턴 ${thread.turnCount}`, ...(thread.openCount > 1 ? [openTurnsText(thread)] : [])];
		const ratioChip =
			col !== "done" && thread.context && !thread.context.tokensOnly
				? `<small class="ctx-ratio">${esc(fmtRatio(thread.context))}</small>`
				: "";
		return cardHtml({
			row: key,
			agyKey: key,
			stateAttr: `${col}:${latest.state}`,
			cls: channel
				? ` card-channel${col === "working" ? " is-live-ch" : col === "attention" ? " is-attn-ch" : ""}`
				: "",
			link: threadLink(key),
			eyebrow: `<span>${esc(TURN_LABELS.kind[thread.kind])}</span>${place === "" ? "" : ` · <span>${esc(place)}</span>`}`,
			title: cardTitle,
			sum,
			recent: prev.length === 0 ? "" : `<p class="ch-recent">이전: ${esc(prev.join(" · "))}</p>`,
			badges: threadBadges(thread),
			time: ago(msOf(thread.updatedAt)),
			meta: `${metaParts.map((part) => `<span>${esc(part)}</span>`).join("")}${modelChip(thread.model)}${contextBar(thread.context, col)}${ratioChip}`,
		});
	};
	const laneOnlyCard = (lane: LaneInfo): string => {
		const col = effectiveLaneColumn(lane);
		const land = laneLandBadge(lane.landState);
		const badges = [
			state(lane.status),
			...(land === undefined ? [] : [badge(land[0], land[1])]),
			...(lane.uncertainCount > 0 ? [badge(`보류 ${lane.uncertainCount}`, "is-warning")] : []),
			...(lane.prUrl ? [prBadge(lane.prUrl)] : []),
			...overlapOf(lane.originKey),
		].join("");
		const durNote =
			lane.typical === undefined
				? ""
				: `<span>${esc(`경과 ${Math.floor((lane.elapsedMs ?? 0) / 60_000)}분 · ${typicalNote(lane.elapsedMs ?? 0, lane.typical)}`)}</span>`;
		return cardHtml({
			row: `lane:${lane.name}`,
			agyKey: lane.originKey,
			stateAttr: `${col}:${lane.landState ?? lane.status}`,
			link: `href="?view=lanes&amp;item=${esc(encodeURIComponent(lane.name))}"`,
			eyebrow: esc(["레인", lane.install ?? "본체", lane.repo ?? ""].filter((p) => p !== "").join(" · ")),
			title: lane.title,
			sum: esc(lane.cwd),
			recent: "",
			badges,
			time: ago(msOf(lane.updatedAt)),
			meta: durNote,
		});
	};

	const filterItems = [
		...turns.threads.map((t) => ({ column: colOf(t), install: t.install })),
		...allExtraLanes.map((l) => ({ column: effectiveLaneColumn(l), install: l.install })),
	];
	const botFilters = h.botFilters(filterItems, bot);
	const lead = `${h.banners.join("")}${drainLine}${botFilters}${threads.length === 0 && extraLanes.length === 0 ? h.nothing || '<div class="empty-box" role="status"><p class="note">선택한 필터와 맞는 스레드가 없어요</p></div>' : ""}`;
	if (ui.layout === "list") {
		const TURN_SORTS: Array<[string, string]> = [
			["state", "상태"],
			["title", "제목"],
			["kind", "종류"],
			["turns", "턴 수"],
			["age", "경과"],
			["updated", "갱신"],
		];
		const key = TURN_SORTS.some(([id]) => id === ui.sort) ? (ui.sort as string) : "state";
		const flip = ui.desc === true ? -1 : 1;
		const rowTitleOf = (t: (typeof threads)[number]) =>
			isChannelMainOrigin(t.originKey)
				? `${channelDisplayTitle(t, s.channelNames)}${t.latest.preview ? ` · ${t.latest.preview}` : ""}`
				: (laneByOrigin.get(t.originKey)?.title ?? t.title);
		const rowKindOf = (t: (typeof threads)[number]) =>
			isChannelMainOrigin(t.originKey) ? "채널 본문" : TURN_LABELS.kind[t.kind];
		const value = (t: (typeof threads)[number]): string | number =>
			key === "title"
				? rowTitleOf(t)
				: key === "kind"
					? rowKindOf(t)
					: key === "turns"
						? t.turnCount
						: key === "age"
							? t.latest.ageMs
							: key === "updated"
								? clock - msOf(t.updatedAt)
								: THREAD_RANK[colOf(t)];
		const sorted = threads.slice().sort((a, b) => {
			const x = value(a),
				y = value(b);
			const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko");
			return order === 0 ? byRecent(a, b) : order * flip;
		});
		const heads = TURN_SORTS.map(([id, label]) => {
			const active = id === key;
			return `<th scope="col" aria-sort="${active ? (flip === 1 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${id}">${esc(label)}${active ? `<span aria-hidden="true"> ${flip === 1 ? "↑" : "↓"}</span>` : ""}</button></th>`;
		}).join("");
		const body = sorted
			.map(
				(t) =>
					`<tr data-row="${esc(t.originKey)}" data-state="${esc(`${colOf(t)}:${t.latest.state}`)}"${isSel(t.originKey) ? ' class="is-selected"' : ""}><td><span class="badges">${threadBadges(t)}</span></td><td class="list-title"><a data-row-link ${threadLink(t.originKey)}${isSel(t.originKey) ? ' aria-current="true"' : ""}>${esc(rowTitleOf(t))}</a></td><td>${esc(rowKindOf(t))}</td><td class="num">${t.turnCount}</td><td class="num">${dur(t.latest.ageMs)}</td><td class="num">${ago(msOf(t.updatedAt))}</td></tr>`,
			)
			.join("");
		return `${title}${lead}${jobTop}${sorted.length === 0 ? "" : `<table class="list"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table>`}${jobDone}`;
	}

	const channelThreads = threads.filter((thread) => isChannelMainOrigin(thread.originKey));
	const workThreads = threads.filter((thread) => !isChannelMainOrigin(thread.originKey));
	const channelRank = (col: ThreadCol) => (col === "working" ? 0 : col === "attention" ? 1 : 2);
	const channelStrip =
		channelThreads.length === 0
			? ""
			: `<section class="ch-strip" aria-label="상시 채널"><h2 class="col-head"><span>상시 채널</span><span class="count-chip">${channelThreads.length}</span></h2><div class="ch-grid">${channelThreads
					.slice()
					.sort((a, b) => channelRank(colOf(a)) - channelRank(colOf(b)) || msOf(b.updatedAt) - msOf(a.updatedAt))
					.map((t) => threadCard(t, true))
					.join("")}</div></section>`;
	const TURN_COLS: Array<[ThreadCol, string, string, string]> = [
		["attention", "확인 필요", "확인할 스레드가 없어요", "멈췄거나 실패로 끝난 스레드가 생기면 여기에 모입니다."],
		["working", "진행 중", "진행 중인 턴이 없어요", "채팅 대화나 모니터에서 새 턴이 시작되면 실시간으로 표시됩니다."],
		["done", "완료", "끝난 스레드가 없어요", "턴이 끝난 스레드는 마지막 활동 뒤 24시간 동안 여기에 남습니다."],
	];
	const countCol = (id: ThreadCol) =>
		workThreads.filter((t) => colOf(t) === id).length + extraLanes.filter((l) => effectiveLaneColumn(l) === id).length;
	const chips = TURN_COLS.map(
		([id, label]) => `<a class="chip" href="#col-${id}">${esc(label)} <b>${countCol(id)}</b></a>`,
	).join("");
	const columns = TURN_COLS.map(([id, label, none, hint]) => {
		const cards = [
			...workThreads.filter((t) => colOf(t) === id).map((t) => ({ at: msOf(t.updatedAt), html: threadCard(t) })),
			...extraLanes
				.filter((l) => effectiveLaneColumn(l) === id)
				.map((l) => ({ at: msOf(l.updatedAt), html: laneOnlyCard(l) })),
		].sort((a, b) => b.at - a.at);
		const body =
			cards.length === 0
				? `<div class="col-empty-wrap"><p class="col-empty">${esc(none)}</p><p class="col-empty-sub">${esc(hint)}</p></div>`
				: cards.map((c) => c.html).join("");
		return `<section class="col" id="col-${id}" aria-label="${esc(label)}"${cards.length === 0 ? " data-empty" : ""}><h2 class="col-head"><span>${esc(label)}</span><span class="count-chip">${cards.length}</span></h2>${body}</section>`;
	}).join("");
	if ((q !== "" || bot !== "") && threads.length === 0 && extraLanes.length === 0)
		return `${title}${lead}${jobTop}${jobDone}`;
	return `${title}${lead}${jobTop}${channelStrip}<nav class="col-chips" aria-label="열로 이동">${chips}</nav><div class="inbox">${columns}</div>${jobDone}`;
}
