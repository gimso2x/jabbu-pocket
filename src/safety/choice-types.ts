/** A choice card (`ApprovalBroker.choose`): an omp dialog put to the owner in the asking conversation. */
export interface ChoiceCard {
	/** Card body; redacted and cut by the broker. */
	text: string;
	/** Button labels; button `n` carries `ompbot:choice:<n>:<channel>:<ts>`. Empty: the owner answers by reply only. */
	buttons: readonly string[];
	/** Indexes of the recommended buttons (one per `ask` question at most): drawn `primary`, the rest unstyled. */
	recommended?: readonly number[] | undefined;
	/** What an unanswered card turns into, for the deadline line (`…까지 답이 없으면 <fallback>로 처리됩니다`). */
	fallback: string;
	/** Deadline of this card; default: the broker's `timeoutMs`. */
	timeoutMs?: number | undefined;
	/**
	 * Which reply texts the card takes as an answer. A text it refuses is not consumed (the conversation message goes
	 * its normal way, a card-thread reply is ignored) and the card shows `rejectHint` once. Default: every text.
	 */
	acceptsText?: ((text: string) => boolean) | undefined;
	rejectHint?: string | undefined;
}

/** One owner input on a choice card: a button click or a text answer (card-thread or conversation reply). */
export type ChoiceEvent = { kind: "choice"; index: number } | { kind: "text"; text: string };
/** What waiting on a choice card yields: owner input, or the end of the wait (deadline, withdrawn by the caller). */
export type ChoiceResult = ChoiceEvent | { kind: "timeout" } | { kind: "cancelled" };

/** An open choice card. Inputs queue up until read; `timeout`/`cancelled` end it and are returned from then on. */
export interface ChoiceCardHandle {
	next(): Promise<ChoiceResult>;
	/** Rewrites the open card (a partly answered `ask`); no-op once closed. */
	update(text: string, buttons: readonly string[]): Promise<void>;
	/** Final card text: the body plus `finalLine`, buttons removed. `answer` (what was chosen) settles the ledger row as replied. */
	close(finalLine: string, answer?: string): Promise<void>;
}

/** Where a queued choice input came from: a card-thread reply's ts, and who waits to learn whether it was read. */
export interface ChoiceSource {
	replyTs?: string;
	/** Called once: true when the card read the input, false when the card closed with it still unread. */
	onRead?: (read: boolean) => void;
}

export interface ChoicePending {
	originKey: string;
	buttons: number;
	/** Queues one owner input; false once the card is closed or ended. */
	push: (event: ChoiceEvent, source?: ChoiceSource) => boolean;
	isOpen: () => boolean;
	/** Card-thread reply ts already taken (a backfill replay is a duplicate). */
	replies: Set<string>;
}

/** What omp does with an unanswered `ask` (`timedOutAskDialogResult`): each question's recommended option, else its first. */
export const ASK_FALLBACK = "추천(없으면 1번) 선택지";
export const ASK_TIMEOUT_LINE = `⌛ 시간 초과: ${ASK_FALLBACK}로 자동 선택`;
