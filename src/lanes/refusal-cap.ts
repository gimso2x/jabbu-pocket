import type { IntegrityRefusal } from "./integrity";

/** How many refusals one verdict reports (a claim is judged again after its remedies are applied). */
export const MAX_REFUSALS = 8;

/** Heaviest first: the order in which categories are kept when a verdict is over the cap. */
const RANK: Record<IntegrityRefusal["category"], number> = {
	lane_diff_unavailable: 0,
	guard_deletion_without_adversarial_regression: 1,
	undeclared_feature_removal: 2,
	stub_implementation: 3,
	skipped_test: 4,
	unproven_claim_word: 5,
	unfinished_work_marker: 6,
};

interface Entry {
	refusal: IntegrityRefusal;
	index: number;
}

const byRank = (a: Entry, b: Entry): number => RANK[a.refusal.category] - RANK[b.refusal.category] || a.index - b.index;

/**
 * At most `MAX_REFUSALS` refusals. Within the cap the list is kept as it is; over it, the first refusal of every
 * category comes first and the rest of the slots go to the other refusals by rank (original order within a
 * category), so a flood of one category never hides another. The result is in rank order.
 */
export function capRefusals(list: readonly IntegrityRefusal[]): IntegrityRefusal[] {
	if (list.length <= MAX_REFUSALS) return [...list];
	const ranked = list.map((refusal, index) => ({ refusal, index })).sort(byRank);
	const seen = new Set<IntegrityRefusal["category"]>();
	const firsts: Entry[] = [];
	const rest: Entry[] = [];
	for (const entry of ranked) {
		if (seen.has(entry.refusal.category)) rest.push(entry);
		else {
			seen.add(entry.refusal.category);
			firsts.push(entry);
		}
	}
	return [...firsts, ...rest]
		.slice(0, MAX_REFUSALS)
		.sort(byRank)
		.map((entry) => entry.refusal);
}

/** The card lines of an already capped list; a list at the cap says the rest may have been left out. */
export function refusalCardLines(refusals: readonly IntegrityRefusal[]): string[] {
	const lines = refusals.map((r) => `- ${r.category}: ${r.excerpt}`);
	if (refusals.length >= MAX_REFUSALS) {
		lines.push(`(${MAX_REFUSALS}건 상한으로 나머지가 생략됐을 수 있음 — 분류마다 한 건씩은 남김)`);
	}
	return lines;
}
