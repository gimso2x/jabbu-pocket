import { mentionToken, renderMentions } from "../channel/port";
import { redact } from "../redact";
import type { InboundRow } from "../store/db-rows";
import { ownerFailureTail } from "./failure-notice";
import type { ThreadSource } from "./mailbox-thread-context";
import { PEER_FAILURE_MARK } from "./types";

/**
 * Second half of a peer failure notice (`failedNotice` with a peer; the first is `PEER_FAILURE_MARK`). A peer turn
 * opened by a text that carries both never mentions back when it fails too: a failure notice answers a peer once,
 * never in a loop.
 */
const PEER_FAILURE_TAIL = "직접 검토해 주세요";
/** Characters of the failure reason a peer failure notice keeps (after redaction). */
const PEER_REASON_MAX = 80;

/** omp's start-up error when no provider is logged in and no API key is set (a fresh install that skipped `omp login`). */
export const NO_MODEL_SIGN = /No default model selected/;
/** The owner's notice for that error: the generic "send it again" would fail the same way until omp has a model. */
export const NO_MODEL_NOTICE =
	"[turn failed] omp_no_model — 봇을 돌리는 계정에서 omp가 쓸 모델을 찾지 못했습니다. 그 계정으로 `omp login`(또는 공급자 API 키 설정)을 한 뒤 다시 보내 주세요";

/** Final error of a turn the owner stopped with `!stop`. */
export const OWNER_STOP_ERROR = "owner_stop";
/** `!stop`'s answer when it stopped a turn; the session stays, so the owner just keeps talking. */
export const OWNER_STOPPED_TEXT = "⏹ 멈췄습니다. 세션은 그대로라 이어서 말하면 됩니다.";
/** `!stop`'s answer when no turn ran. */
export const NOTHING_TO_STOP_TEXT = "멈출 작업이 없습니다.";

/**
 * First line of an owner steer written before the turn's last answer reached the owner (2026-11-11: "어디갔어"
 * written in the same second as the answer made the model write the answer again). Model input only: the inbound
 * row keeps the owner's text as is.
 */
export const STEER_BEFORE_ANSWER_SEEN_NOTE =
	'[참고: 이 메시지는 네 직전 답이 오너에게 전달되기 전에 쓰인 것이다. 직전 답은 이미 전달됐으니 같은 내용을 다시 쓰지 않는다. 이 메시지에 새 질문·지시·명령(취소·변경 포함)이 있으면 그대로 처리하고, 직전 답을 찾는 말뿐이면 "위에 올렸습니다" 한 줄로 답한다.]';

/** The peer bot whose message opened a turn, and whether that message was itself a peer failure notice. */
export interface TurnPeer {
	userId: string;
	fromFailureNotice: boolean;
}

export function turnPeerOf(row: InboundRow): TurnPeer | undefined {
	if (row.peerUserId === null) return undefined;
	const marked = row.textRef.includes(PEER_FAILURE_MARK) && row.textRef.includes(PEER_FAILURE_TAIL);
	return { userId: row.peerUserId, fromFailureNotice: marked };
}

/**
 * The notice of a failed turn. A turn a peer bot opened answers that bot by mention on one line (`<@peer> <@this bot>
 * 응답 실패(<reason, redacted, 80 chars>) — …`), since a peer hears only messages that mention it; the owner's turns,
 * and a peer turn opened by a peer failure notice, keep the plain `[turn failed]` line. `botUserId` unknown (not yet
 * connected): the second mention is left out. When the visible `reason` is a short code (`omp_exited code=1`),
 * `rawReason` carries the underlying error/stderr for failure-kind classification.
 */
export function failedNotice(reason: string, peer?: TurnPeer, source?: ThreadSource, rawReason?: string): string {
	if (peer === undefined || peer.fromFailureNotice) {
		return `[turn failed] ${reason} — ${ownerFailureTail(rawReason ?? reason)}`;
	}
	const chars = [...redact(reason).replace(/\s+/g, " ").trim()];
	const short = chars.length > PEER_REASON_MAX ? `${chars.slice(0, PEER_REASON_MAX - 1).join("")}…` : chars.join("");
	const botUserId = source?.botUserId();
	const self = botUserId === undefined ? "" : ` ${mentionToken(botUserId)}`;
	const notice = `${mentionToken(peer.userId)}${self} ${PEER_FAILURE_MARK}${short}) — 다시 요청하거나 ${PEER_FAILURE_TAIL}`;
	// Rendered here, in the platform's own syntax: the peer reads the posted text, and the ledger keeps it as posted.
	return source === undefined ? notice : renderMentions(notice, source);
}
