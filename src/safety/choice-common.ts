import type { OmpDialogRequest, OmpDialogResponse } from "../omp/driver";
import type { ChoiceCardHandle } from "./choice-types";

/** More options than this: a numbered list and "번호로 답장" instead of buttons. */
export const MAX_CHOICE_BUTTONS = 5;
/** A card allows at most 25 elements in one actions block; an `ask` question past it is answered by number. */
export const MAX_CARD_BUTTONS = 25;
/**
 * omp times a dialog out by itself at its `timeout`; the card's own deadline comes this much earlier so a partly
 * answered `ask` reaches omp with the owner's answers (omp's own timeout would overwrite them with its defaults).
 */
const DEADLINE_LEAD_MS = 1_000;
const TIMEOUT_LINE = (fallback: string) => `⌛ 시간 초과: ${fallback}로 처리됨`;
export const CANCELLED_LINE = "🚫 취소됨";

/** Card deadline for a dialog: just before omp's own `timeout`, else the broker default. */
export function deadlineOf(request: OmpDialogRequest): number | undefined {
	if (!("timeout" in request) || request.timeout === undefined) return undefined;
	return Math.max(request.timeout - DEADLINE_LEAD_MS, 0);
}

/** A reply naming an option: its 1-based number or its exact label. */
export function optionOf(labels: readonly string[], text: string): number | undefined {
	const trimmed = text.trim();
	if (/^\d+$/.test(trimmed)) {
		const index = Number(trimmed) - 1;
		return index >= 0 && index < labels.length ? index : undefined;
	}
	const exact = labels.indexOf(trimmed);
	return exact === -1 ? undefined : exact;
}

/** Ends the card for a non-answer: the timeout or the withdrawal line, and the matching omp response. */
export async function endUnanswered(
	card: ChoiceCardHandle,
	kind: "timeout" | "cancelled",
	fallback: string,
): Promise<OmpDialogResponse> {
	await card.close(kind === "timeout" ? TIMEOUT_LINE(fallback) : CANCELLED_LINE);
	return kind === "timeout" ? { cancelled: true, timedOut: true } : { cancelled: true };
}
