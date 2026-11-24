import type { BoardCard, BoardPanel } from "./board";
import type { DashboardSnapshot, TaskInfo } from "./snapshot";

export type InboxCol = "attention" | "working" | "wait";

/** One inbox card: an agent pane (with its TASK merged in), or an open TASK no pane carries. */
export interface InboxEntry {
	id: string;
	kind: "card" | "task";
	col: InboxCol;
	since: number;
	title: string;
	machine: string;
	taskId: string;
	card?: BoardCard;
	task?: TaskInfo;
}

/**
 * A board card with what its pane said merged in: the snapshot's `herdr.says` entry of the same host and pane, while
 * the card still has the status it was read in. Self-contained (shipped to the page).
 */
export function cardWithSay(s: DashboardSnapshot | null | undefined, card: BoardCard): BoardCard {
	const says = s?.herdr.ok ? (s.herdr.says ?? []) : [];
	const host = card.local ? "local" : card.machineId;
	const say = says.find((item) => item.host === host && item.paneId === card.paneId && item.status === card.status);
	if (say === undefined) return card;
	const { host: _host, paneId: _pane, status: _status, ...fields } = say;
	return { ...card, ...fields };
}

/**
 * The inbox cards of a snapshot and the live board, each in its column; no search, no order. Self-contained apart from
 * `cardWithSay` (shipped to the page).
 */
export function inboxEntries(s: DashboardSnapshot, live?: BoardPanel | null): InboxEntry[] {
	const board = live?.ok ? live : undefined;
	const msOf = (iso: string | undefined): number => {
		const ms = Date.parse(iso ?? "");
		return Number.isNaN(ms) ? 0 : ms;
	};
	const tasks = s.tasks.ok ? s.tasks.items : [];
	const trouble = (task: TaskInfo): boolean => task.status === "blocked" || task.error !== undefined;
	const lone = (task: TaskInfo): InboxCol => {
		// While the board is live, an open TASK whose pane is not on it has lost its agent: the owner should look.
		if (board !== undefined || trouble(task)) return "attention";
		const herdr = task.herdr;
		if (herdr !== undefined && !herdr.ok) {
			if (herdr.error !== "herdr is not configured") return "attention";
			return task.status === "review" ? "wait" : "working";
		}
		if (herdr !== undefined && herdr.status !== "working" && herdr.status !== "idle" && herdr.status !== "done") {
			return "attention";
		}
		if (task.status === "review") return "wait";
		return herdr === undefined || herdr.status === "working" ? "working" : "wait";
	};
	const entries: InboxEntry[] = [];
	for (const boardCard of board?.cards ?? []) {
		const card = cardWithSay(s, boardCard);
		const task = card.taskId === undefined ? undefined : tasks.find((item) => item.taskId === card.taskId);
		// A finished pane, with or without a TASK, goes to 완료·대기; only trouble or a blocked pane asks the owner.
		const col: InboxCol =
			card.column === "attention" || (task !== undefined && trouble(task))
				? "attention"
				: card.column === "working"
					? "working"
					: "wait";
		entries.push({
			id: card.key,
			kind: "card",
			col,
			since: card.since,
			title: task?.title || card.paneLabel,
			machine: card.machineName,
			taskId: card.taskId ?? "",
			card,
			...(task === undefined ? {} : { task }),
		});
	}
	for (const task of tasks) {
		if (!task.open || entries.some((entry) => entry.taskId === task.taskId)) continue;
		entries.push({
			id: task.taskId,
			kind: "task",
			col: lone(task),
			since: msOf(task.progress?.updated) || msOf(task.updatedAt),
			title: task.title,
			machine: task.host,
			taskId: task.taskId,
			task,
		});
	}
	return entries;
}

/** How long an idle or finished pane with no TASK sits in 완료·대기 before it counts as 방치. Shipped to the page. */
export const STALE_MS = 24 * 3_600_000;

/**
 * A 방치 entry: a herdr pane in 완료·대기 tied to no TASK (no merged TASK and no `taskId`, so a TASK pane stays out
 * while the TASK list cannot be read), in that state for `STALE_MS` or since an unknown time (`since` 0). Self-contained
 * apart from `STALE_MS` (shipped beside it).
 */
export function isStale(entry: InboxEntry, now: number): boolean {
	return (
		entry.kind === "card" &&
		entry.col === "wait" &&
		entry.task === undefined &&
		entry.taskId === "" &&
		(entry.since === 0 || now - entry.since >= STALE_MS)
	);
}

/**
 * The 확인 필요 group of an entry: 0 failed (TASK documents not judged, worker check failed or gone, unknown pane state),
 * 1 blocked, 2 the rest (no agent card…). Self-contained (shipped).
 */
export function attentionGroup(entry: InboxEntry): number {
	const task = entry.task;
	const card = entry.card;
	const herdr = task?.herdr;
	if (task?.error !== undefined || (herdr !== undefined && (!herdr.ok || herdr.status === "gone")) || card?.unknown) {
		return 0;
	}
	if (task?.status === "blocked" || card?.status === "blocked") return 1;
	return 2;
}

/**
 * The one 확인 필요 order: group, then the longest wait first (an unknown since, 0, after every known one), then id.
 * Self-contained apart from `attentionGroup`.
 */
export function byAttention(a: InboxEntry, b: InboxEntry): number {
	return (
		attentionGroup(a) - attentionGroup(b) ||
		Number(a.since === 0) - Number(b.since === 0) ||
		a.since - b.since ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/**
 * The 확인 필요 entries in the one order the next line, the number badges and keys and the tab title use; never
 * filtered by the search. Self-contained apart from `inboxEntries`/`byAttention` (shipped beside it).
 */
export function inboxAttention(s: DashboardSnapshot, live?: BoardPanel | null): InboxEntry[] {
	return inboxEntries(s, live)
		.filter((entry) => entry.col === "attention")
		.sort(byAttention);
}

/** Why the owner should look at a 확인 필요 entry, failure first, cut at 120 characters. Self-contained (shipped). */
export function inboxNextReason(entry: InboxEntry, live: boolean): string {
	const task = entry.task;
	const card = entry.card;
	const herdr = task?.herdr;
	const reason =
		task?.error ??
		(herdr !== undefined && !herdr.ok
			? herdr.error
			: herdr?.status === "gone"
				? "워커 사라짐"
				: card?.unknown
					? `알 수 없는 상태 ${card.status || "?"}`
					: task?.progress?.blockedReason
						? task.progress.blockedReason
						: card?.status === "blocked"
							? (card.question ?? card.blocked ?? "에이전트 입력 대기")
							: entry.kind === "task" && live
								? "에이전트 카드 없음"
								: "확인 필요");
	return reason.length > 120 ? `${reason.slice(0, 119)}…` : reason;
}

/** The tab icon for a state: the brand mark, the same with a red dot (확인 필요), all grey (이상). Self-contained. */
export function faviconHref(state: "ok" | "attention" | "bad"): string {
	const fill = state === "bad" ? "#525860" : "#0860CA";
	const dot =
		state === "attention" ? '<circle cx="25" cy="7" r="6" fill="#B91C1C" stroke="#FFFFFF" stroke-width="2"/>' : "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="4" width="26" height="26" rx="7" fill="${fill}"/><circle cx="15" cy="17" r="6.5" fill="none" stroke="#FFFFFF" stroke-width="3"/>${dot}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The tab title and icon: `(!)` when the last refresh failed, the daemon is not running or the board is cut off;
 * otherwise the 확인 필요 count. Self-contained apart from `inboxAttention`/`faviconHref` (shipped beside it).
 */
export function tabSignal(
	s: DashboardSnapshot,
	board: BoardPanel | null | undefined,
	failed: boolean,
): { count: number; bad: boolean; title: string; favicon: string } {
	const bad = failed || !s.daemon.ok || !s.daemon.running || (board !== undefined && board !== null && !board.ok);
	const count = inboxAttention(s, board).length;
	const title = bad ? "(!) ompbot 현황판" : count > 0 ? `(${count}) 확인 필요 · ompbot 현황판` : "ompbot 현황판";
	return { count, bad, title, favicon: faviconHref(bad ? "bad" : count > 0 ? "attention" : "ok") };
}

/** A key press as the number and reply keys see it. */
interface OrderKeyInput {
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	typing?: boolean;
	modalOpen?: boolean;
	view?: string;
}

/**
 * The id key `1`…`9` opens: the card with that number on screen (`numberedIds` in number order), or null — typing,
 * a modal open, a modifier held, a view other than the inbox, or no card with that number. Self-contained (shipped).
 */
export function orderKeyTarget(input: OrderKeyInput, numberedIds: string[]): string | null {
	if (input.typing || input.modalOpen || input.meta || input.ctrl || input.alt || input.view !== "inbox") return null;
	if (!/^[1-9]$/.test(input.key)) return null;
	return numberedIds[Number(input.key) - 1] ?? null;
}

/** The address key `r` opens: the next line's reply link, under the same conditions as {@link orderKeyTarget}. */
export function replyKeyTarget(input: OrderKeyInput, replyHref: string | null | undefined): string | null {
	if (input.typing || input.modalOpen || input.meta || input.ctrl || input.alt || input.view !== "inbox") return null;
	return input.key === "r" && replyHref ? replyHref : null;
}

/** The `localStorage` key of the inbox read marks ({@link readUnread}); this browser only. Shipped to the page. */
export const UNREAD_KEY = "ompbot-inbox-seen";
/** How long the read mark of an entry no longer in the snapshot is kept, from when it was read. Shipped. */
export const UNREAD_KEEP_MS = 14 * 86_400_000;
/** The most read marks kept; past it the longest-read entries no longer in the snapshot go first. Shipped. */
export const UNREAD_MAX = 1000;

/** What the owner saw of an entry: its {@link entrySig}, its `since`, and when it was read. */
interface UnreadMark {
	sig: string;
	since: number;
	at: number;
}

/** The stored read marks; `seeded` once the first whole inbox was recorded as read. */
export interface UnreadState {
	v: 1;
	seeded: boolean;
	seen: Record<string, UnreadMark>;
}

/** Where the read marks live: the page's `localStorage[UNREAD_KEY]`, a fake one in tests. */
export interface UnreadStorage {
	get(): string | null;
	set(value: string): void;
}

/**
 * The stored read marks, or the empty unseeded state for nothing stored, broken JSON or another shape (never throws
 * on bad data); a mark of the wrong shape is dropped. Self-contained (shipped).
 */
export function readUnread(store: UnreadStorage): UnreadState {
	const empty: UnreadState = { v: 1, seeded: false, seen: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(store.get() ?? "");
	} catch {
		return empty;
	}
	if (typeof raw !== "object" || raw === null) return empty;
	const value = raw as { v?: unknown; seeded?: unknown; seen?: unknown };
	if (value.v !== 1 || typeof value.seeded !== "boolean") return empty;
	if (typeof value.seen !== "object" || value.seen === null || Array.isArray(value.seen)) return empty;
	const seen: Record<string, UnreadMark> = {};
	for (const [id, item] of Object.entries(value.seen as Record<string, unknown>)) {
		const mark = item as { sig?: unknown; since?: unknown; at?: unknown } | null;
		if (mark && typeof mark.sig === "string" && typeof mark.since === "number" && typeof mark.at === "number") {
			seen[id] = { sig: mark.sig, since: mark.since, at: mark.at };
		}
	}
	return { v: 1, seeded: value.seeded, seen };
}

/**
 * The state of an entry the owner cares to see change: a card's pane status, its TASK's status and whether its
 * documents failed, and the column; a lone TASK's status, failure, worker check and column. No `since` and no
 * PROGRESS update, so a worker writing its progress does not make a TASK unread. Self-contained (shipped).
 */
export function entrySig(entry: InboxEntry): string {
	const task = entry.task;
	const taskPart = task === undefined ? "-" : `${task.status}/${task.error === undefined ? "" : "error"}`;
	if (entry.kind === "card") return `card|${entry.card?.status ?? ""}|${taskPart}|${entry.col}`;
	const herdr = task?.herdr;
	const herdrPart = herdr === undefined ? "-" : herdr.ok ? `ok/${herdr.status}` : "fail";
	return `task|${taskPart}|${herdrPart}|${entry.col}`;
}

/**
 * The ids of the entries changed since the owner last opened them in this browser: a changed {@link entrySig}, a card
 * whose `since` moved (both known, so a pane back in the same state counts), or — once seeded — an entry never seen.
 * Self-contained apart from `readUnread`/`entrySig` (shipped beside it).
 */
export function unreadIds(entries: InboxEntry[], store: UnreadStorage): string[] {
	const state = readUnread(store);
	return entries
		.filter((entry) => {
			const mark = Object.hasOwn(state.seen, entry.id) ? state.seen[entry.id] : undefined;
			if (mark === undefined) return state.seeded;
			if (mark.sig !== entrySig(entry)) return true;
			return entry.kind === "card" && mark.since !== 0 && entry.since !== 0 && mark.since !== entry.since;
		})
		.map((entry) => entry.id);
}

/**
 * Whether a snapshot reads the whole inbox: the TASK list read and, with the board on (`board` not undefined), the
 * board read too. Seeding or pruning on less would mark the missing half unread once it comes back. Self-contained.
 */
export function unreadReady(s: DashboardSnapshot, board: BoardPanel | null | undefined): boolean {
	return s.tasks.ok && (board === undefined || board?.ok === true);
}

/**
 * The first visit: records every inbox entry (before any search) as read and marks the store seeded, once a snapshot
 * reads the whole inbox ({@link unreadReady}). `board` undefined = the board is off. Returns whether it wrote.
 * Self-contained apart from `unreadReady`/`readUnread`/`inboxEntries`/`entrySig` (shipped beside it).
 */
export function seedStore(
	store: UnreadStorage,
	s: DashboardSnapshot,
	board: BoardPanel | null | undefined,
	now: number,
): boolean {
	if (!unreadReady(s, board)) return false;
	const state = readUnread(store);
	if (state.seeded) return false;
	const seen = { ...state.seen };
	for (const entry of inboxEntries(s, board)) seen[entry.id] = { sig: entrySig(entry), since: entry.since, at: now };
	store.set(JSON.stringify({ v: 1, seeded: true, seen }));
	return true;
}

/** Records an entry as read now: its {@link entrySig} and `since`. Self-contained apart from `readUnread`/`entrySig`. */
export function markSeen(store: UnreadStorage, entry: InboxEntry, now: number): void {
	const state = readUnread(store);
	state.seen[entry.id] = { sig: entrySig(entry), since: entry.since, at: now };
	store.set(JSON.stringify(state));
}

/**
 * Drops the marks of entries gone from the snapshot and read more than `UNREAD_KEEP_MS` ago, then the longest-read
 * gone ones past `UNREAD_MAX`; an entry still in the snapshot keeps its mark however old. Only on a snapshot that reads
 * the whole inbox ({@link unreadReady}); writes only when something goes. Returns whether it wrote. Self-contained apart
 * from `unreadReady`/`readUnread`/`inboxEntries`/`UNREAD_KEEP_MS`/`UNREAD_MAX` (shipped beside it).
 */
export function pruneStore(
	store: UnreadStorage,
	s: DashboardSnapshot,
	board: BoardPanel | null | undefined,
	now: number,
): boolean {
	if (!unreadReady(s, board)) return false;
	const state = readUnread(store);
	const present = new Set(inboxEntries(s, board).map((entry) => entry.id));
	const all = Object.entries(state.seen);
	const kept = all
		.filter(([id, mark]) => present.has(id) || now - mark.at <= UNREAD_KEEP_MS)
		.sort(([a, x], [b, y]) => Number(present.has(b)) - Number(present.has(a)) || y.at - x.at);
	const presentCount = kept.filter(([id]) => present.has(id)).length;
	const left = kept.slice(0, Math.max(UNREAD_MAX, presentCount));
	if (left.length === all.length) return false;
	store.set(JSON.stringify({ v: 1, seeded: state.seeded, seen: Object.fromEntries(left) }));
	return true;
}
