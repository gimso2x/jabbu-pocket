import type { ChannelPort } from "../channel/port";
import type { Logger } from "../log";
import type { CardAnswerStore, CardAnswerVerdict } from "../store/card-answers";

/** What the broker hands the answer ledger: the store, its log, the card's platform port and the clock. */
export interface AnswerLedgerContext {
	store: CardAnswerStore;
	log: Logger;
	port(channel: string): ChannelPort;
	now(): number;
}

/** A ledger answer value with its particle, as the owner reads it in "이미 <값> 처리됨". */
function answerLabel(value: string): string {
	if (value === "approved") return "승인으로";
	if (value === "denied") return "거부로";
	if (value === "replied") return "답장으로";
	const index = /^choice:(\d+)$/.exec(value)?.[1];
	return index === undefined ? `${value}(으)로` : `${Number(index) + 1}번 선택으로`;
}

/**
 * Judges an owner answer against the card's ledger: true when nothing more is to be done with it — a repeat of an
 * answer already taken is dropped silently, and a different value on a card the owner settled is refused with an
 * `answer_conflict` event and a line in the card's thread. Without an `answerId` (a platform that gives none) the
 * answer is judged by the card alone, as before.
 */
export function answerSeen(
	ctx: AnswerLedgerContext,
	card: { channel: string; ts: string },
	answerId: string | undefined,
	value: string,
): boolean {
	if (answerId === undefined) return false;
	const { log } = ctx;
	const cardId = `${card.channel}:${card.ts}`;
	let verdict: CardAnswerVerdict;
	try {
		verdict = ctx.store.judgeCardAnswer(cardId, answerId, value, ctx.now());
	} catch (error) {
		log.warn("card_answer_judge_failed", { card: cardId, error: String(error) });
		return false;
	}
	if (verdict.kind === "new") return false;
	if (verdict.kind === "duplicate") {
		log.info("answer_duplicate", { card: cardId, answer: answerId });
		return true;
	}
	log.warn("answer_conflict", { card: cardId, answer: answerId, value, settled: verdict.settled });
	ctx
		.port(card.channel)
		.post({ conversationId: card.channel, threadId: card.ts }, { text: `이미 ${answerLabel(verdict.settled)} 처리됨` })
		.catch((error: unknown) => log.warn("answer_conflict_notice_failed", { card: cardId, error: String(error) }));
	return true;
}

/** Files an answer the card took; a ledger failure is logged and the answer stands. */
export function recordAnswer(
	ctx: AnswerLedgerContext,
	cardId: string,
	answerId: string | undefined,
	value: string,
): void {
	if (answerId === undefined) return;
	try {
		ctx.store.recordCardAnswer(cardId, answerId, value, ctx.now());
	} catch (error) {
		ctx.log.warn("card_answer_record_failed", { card: cardId, error: String(error) });
	}
}
