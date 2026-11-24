import type { Database } from "bun:sqlite";

/**
 * The owner's answers to approval and choice cards: per card, one
 * row per answer id (the platform's interaction or message id) with the value it carried. `accepted` rows are the
 * answers the card took; `conflict` rows are other values that arrived after the owner had settled the card.
 */
export const CARD_ANSWERS_DDL = `CREATE TABLE IF NOT EXISTS card_answers (
	card_id TEXT NOT NULL,
	answer_id TEXT NOT NULL,
	value TEXT NOT NULL,
	verdict TEXT NOT NULL CHECK (verdict IN ('accepted','conflict')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (card_id, answer_id)
);`;

/**
 * What an owner answer does to a card. `duplicate`: the answer id was seen, or the owner already settled the card with
 * this value. `conflict`: the owner settled it with another value (`settled`); the answer is recorded as a conflict
 * and changes nothing. `new`: the card still takes it.
 */
export type CardAnswerVerdict = { kind: "new" } | { kind: "duplicate" } | { kind: "conflict"; settled: string };

/** The ledger side of {@link CardAnswerVerdict}, implemented by `Store`. */
export interface CardAnswerStore {
	judgeCardAnswer(cardId: string, answerId: string, value: string, now: number): CardAnswerVerdict;
	/** Records an answer the card took, so a later one can be judged against it. */
	recordCardAnswer(cardId: string, answerId: string, value: string, now: number): void;
}

/**
 * `status` is the card's approvals row status. Only an owner-settled card (`approved`, `denied`, `replied`) can
 * conflict: one that closed by timeout or abort (`expired`) was not settled by the owner.
 */
export function judgeCardAnswer(
	db: Database,
	status: string | undefined,
	cardId: string,
	answerId: string,
	value: string,
	now: number,
): CardAnswerVerdict {
	return db.transaction((): CardAnswerVerdict => {
		if (db.query("SELECT 1 FROM card_answers WHERE card_id = ? AND answer_id = ?").get(cardId, answerId)) {
			return { kind: "duplicate" };
		}
		if (status !== "approved" && status !== "denied" && status !== "replied") return { kind: "new" };
		const last = db
			.query(
				"SELECT value FROM card_answers WHERE card_id = ? AND verdict = 'accepted' ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(cardId) as { value: string } | null;
		const settled = last?.value ?? status;
		if (settled === value) return { kind: "duplicate" };
		insertCardAnswer(db, "conflict", cardId, answerId, value, now);
		return { kind: "conflict", settled };
	})();
}

/** Idempotent on `(cardId, answerId)`. `value` must already be redacted. */
export function insertCardAnswer(
	db: Database,
	verdict: "accepted" | "conflict",
	cardId: string,
	answerId: string,
	value: string,
	now: number,
): void {
	db.query(
		"INSERT OR IGNORE INTO card_answers (card_id, answer_id, value, verdict, created_at) VALUES (?, ?, ?, ?, ?)",
	).run(cardId, answerId, value, verdict, now);
}
