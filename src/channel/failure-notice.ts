/**
 * A failed turn's notice body, owner-shaped (`[turn failed] …`) or peer-shaped: one or two leading mentions (rendered
 * `<@id>` or raw `{{mention:id}}` tokens) and then the peer failure mark (`PEER_FAILURE_MARK`). The peer shape is
 * anchored at the head so an answer merely quoting the mark later is not one.
 */
const PEER_FAILURE_HEAD =
	/^(?:\{\{mention:[A-Za-z0-9_]+\}\}|<@[A-Za-z0-9_]+>)(?: (?:\{\{mention:[A-Za-z0-9_]+\}\}|<@[A-Za-z0-9_]+>))? 응답 실패\(/;

/** Both failure-notice shapes (owner `[turn failed] …`, peer mention head) finish the thread's status as failed. */
export function failureNoticeBody(body: string): boolean {
	return body.startsWith("[turn failed]") || PEER_FAILURE_HEAD.test(body);
}
