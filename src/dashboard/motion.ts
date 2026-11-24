import { esc } from "./text";

/** Where a number's change is bad news: a count that grew (`up`) or a remaining share that fell (`down`). */
type RollBad = "up" | "down";

/** One header number that changed between two draws. */
interface RollChange {
	key: string;
	from: number;
	to: number;
	delta: number;
}

/**
 * Header number roll: the keys whose value differs from the last draw, with the step. `prev` is the page's memory of
 * the last values (never read back from the DOM); `next` is the memory to keep. The first draw (empty `prev`) changes
 * nothing, and a key that was not there before is not a change. Self-contained (shipped to the page).
 */
export function rollDiff(
	prev: Map<string, number>,
	items: Array<{ key: string; value: number }>,
): { changes: RollChange[]; next: Map<string, number> } {
	const next = new Map<string, number>();
	const changes: RollChange[] = [];
	for (const item of items) {
		next.set(item.key, item.value);
		const from = prev.get(item.key);
		if (prev.size === 0 || from === undefined || from === item.value) continue;
		changes.push({ key: item.key, from, to: item.value, delta: item.value - from });
	}
	return { changes, next };
}

/** The effects the page plays for `changes`: none when the reader asked for less motion (it draws the final numbers). Self-contained. */
export function rollEffects(changes: RollChange[], reduced: boolean): RollChange[] {
	return reduced ? [] : changes;
}

/** A change's step as shown (`+2`, `−1`) and its tone: `bad` when it moved the way `bad` names. Self-contained. */
export function rollLabel(change: RollChange, bad: RollBad | undefined): { text: string; tone: "good" | "bad" } {
	const up = change.delta > 0;
	return {
		text: `${up ? "+" : "−"}${Math.abs(change.delta)}`,
		tone: bad === undefined ? "good" : (bad === "up") === up ? "bad" : "good",
	};
}

/** An inbox card the owner should see arrive: a card not in the last draw, or one that moved to another column. */
interface FreshCard {
	id: string;
	kind: "card" | "task";
	col: string;
	title: string;
	why: "new" | "moved";
}

/**
 * New event cards: of `entries`, those whose id was not in the last draw (`prev`: id → column memory) and those whose
 * column changed. The first draw (empty `prev`) and `quiet` (the read marks' first visit) give none. `next` is the
 * memory to keep. Self-contained (shipped to the page).
 */
export function freshCards(
	prev: Map<string, string>,
	entries: Array<{ id: string; kind: "card" | "task"; col: string; title: string }>,
	quiet: boolean,
): { cards: FreshCard[]; next: Map<string, string> } {
	const next = new Map<string, string>();
	const cards: FreshCard[] = [];
	for (const entry of entries) {
		next.set(entry.id, entry.col);
		if (prev.size === 0 || quiet) continue;
		const was = prev.get(entry.id);
		if (was === entry.col) continue;
		cards.push({
			id: entry.id,
			kind: entry.kind,
			col: entry.col,
			title: entry.title,
			why: was === undefined ? "new" : "moved",
		});
	}
	return { cards, next };
}

/** A card on the event stack. */
export interface StackCard extends FreshCard {
	at: number;
}

/** The stack after `fresh` cards arrive: newest first, one per id, at most six kept. Self-contained. */
export function pushStack(list: StackCard[], fresh: FreshCard[], now: number): StackCard[] {
	const ids = new Set(fresh.map((card) => card.id));
	return [...fresh.map((card) => ({ ...card, at: now })).reverse(), ...list.filter((card) => !ids.has(card.id))].slice(
		0,
		6,
	);
}

/**
 * The stack after untouched time: the oldest card goes once `ttl` has passed since the later of its arrival and
 * `since` (the last touch or the last card that went), one card per call. Nothing goes when the reader asked for less
 * motion — the cards then stay until closed. Self-contained.
 */
export function expireStack(list: StackCard[], now: number, since: number, ttl: number, reduced: boolean): StackCard[] {
	const oldest = list[list.length - 1];
	if (reduced || oldest === undefined || now - Math.max(since, oldest.at) < ttl) return list;
	return list.slice(0, -1);
}

/** The stack's cards as HTML (front card first, three shown) and its one-line announcement. Self-contained. */
export function stackHtml(list: StackCard[]): { html: string; say: string } {
	const COLS: Record<string, string> = { attention: "확인 필요", working: "진행 중", wait: "완료·대기" };
	const shown = list.slice(0, 3);
	const cards = shown.map((card, i) => {
		const kind = card.kind === "task" ? "task" : "card";
		return `<a class="es-card is-${card.col === "attention" ? "attention" : "plain"}" style="--i:${i}" href="?${kind}=${esc(
			encodeURIComponent(card.id),
		)}" data-${kind}="${esc(card.id)}" data-es-card="${esc(card.id)}"><span class="es-tag">${card.why === "new" ? "새 카드" : "상태 바뀜"} · ${esc(
			COLS[card.col] ?? card.col,
		)}</span><span class="es-title">${esc(card.title)}</span></a>`;
	});
	const first = list[0];
	const say =
		first === undefined
			? ""
			: `${first.why === "new" ? "새 카드" : "상태 바뀜"}: ${first.title}${list.length > 1 ? ` 외 ${list.length - 1}건` : ""}`;
	return {
		html:
			list.length === 0
				? ""
				: `<div class="es-list" style="--n:${shown.length}">${cards.join("")}</div><button type="button" class="es-x" data-es-close aria-label="알림 닫기">×</button>`,
		say,
	};
}

/**
 * How a card's state pill moves when its state key (`column:card status:TASK status`) changes: `ok` (check draw) when
 * the new status is done or delivered, `bad` (shake) when failed or gone, else empty (the plain flash). No previous
 * key or the same key gives empty. Self-contained.
 */
export function pillMotion(prev: string | undefined, next: string): "ok" | "bad" | "" {
	if (prev === undefined || prev === next) return "";
	const parts = next.split(":");
	const status = parts[2] || parts[1] || "";
	if (new Set(["done", "done-claimed", "delivered", "answered", "approved"]).has(status)) return "ok";
	if (new Set(["failed", "failed_no_retry", "gone", "dead", "denied"]).has(status)) return "bad";
	return "";
}

/**
 * Live steps: a key per finished step (`name`, `summary`, time and failure, counted when they repeat) and the keys not
 * seen before. `seen` null is the first look at a block: nothing is new. Self-contained.
 */
export function freshSteps(
	seen: Set<string> | null,
	steps: Array<{ name?: unknown; summary?: unknown; ms?: unknown; failed?: unknown }>,
): { keys: string[]; fresh: number[] } {
	const counts = new Map<string, number>();
	const keys = steps.map((step) => {
		const base = [step.name, step.summary, step.ms, step.failed === true].join("\u0000");
		const n = (counts.get(base) ?? 0) + 1;
		counts.set(base, n);
		return `${base}#${n}`;
	});
	return { keys, fresh: seen === null ? [] : keys.flatMap((key, i) => (seen.has(key) ? [] : [i])) };
}
