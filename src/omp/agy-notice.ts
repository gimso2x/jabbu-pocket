// agy retries quota failures itself and reports each attempt only as a line of agent text. Regexes copied from omp
// (oh-my-pi eca7acfa45, MIT, `packages/ai/src/providers/antigravity-cli/host.ts` RETRY_NOTICE…NOTICE_ATTEMPT).
const RETRY_NOTICE = /(?:^|\n)[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?API error \(attempt \d+\):[^\S\n]*([^\n]+)/;
const QUOTA_EXHAUSTED = /\bRESOURCE_EXHAUSTED\b|\bcode 429\b/;
const NOTICE_HEAD = "API error (attempt ";
const NOTICE_ATTEMPT = /^\d*$|^\d+\)(?::.*)?$/;

/** The quota detail of an agy retry notice in `text` ("RESOURCE_EXHAUSTED (code 429): …"), else undefined. */
export function quotaRetryNotice(text: string): string | undefined {
	const detail = RETRY_NOTICE.exec(text)?.[1]?.trim();
	return detail && QUOTA_EXHAUSTED.test(detail) ? detail : undefined;
}

/** True when an agy error/text directly indicates a 429 / RESOURCE_EXHAUSTED quota failure. */
export function isQuotaErrorText(text: string): boolean {
	return QUOTA_EXHAUSTED.test(text);
}

/** Incremental cursor state for streaming `agent_message_chunk` scans in O(chunk) time. */
export interface NoticeScanState {
	text: string;
	lastNewline: number;
	quotaScanFrom: number;
	quotaLineDead: boolean;
}

/** Clears accumulated turn text and resets the incremental retry-notice scan cursors. */
export function resetTurnText(state: NoticeScanState): void {
	state.text = "";
	state.lastNewline = -1;
	state.quotaScanFrom = 0;
	state.quotaLineDead = false;
}

const INLINE_SPACE = /[^\S\n]/;
const isInlineSpace = (ch: string | undefined): boolean =>
	ch !== undefined && (ch === " " || ch === "\t" || (ch !== "\n" && INLINE_SPACE.test(ch)));

function skipNoticePrefix(text: string, start: number): number {
	let i = start;
	while (isInlineSpace(text[i])) i += 1;
	if (text[i] === "⚠") {
		i += 1;
		if (text[i] === "\uFE0F") i += 1;
		while (isInlineSpace(text[i])) i += 1;
	}
	return i;
}

/**
 * Appends `chunk` and updates line/notice cursors in O(chunk.length), returning `{ quota, shown }`:
 * only the live trailing line and lines opened by `chunk` are inspected instead of re-scanning `state.text`.
 */
export function appendTurnChunk(state: NoticeScanState, chunk: string): { quota?: string; shown: string } {
	const prevLen = state.text.length;
	state.text += chunk;
	const firstNl = chunk.indexOf("\n");
	const lastNl = firstNl === -1 ? -1 : chunk.lastIndexOf("\n");
	if (state.quotaLineDead && firstNl === -1) return { shown: state.text };
	const scanFrom = state.quotaLineDead ? prevLen + firstNl + 1 : state.quotaScanFrom;
	const quota = quotaRetryNotice(state.text.slice(scanFrom));
	if (quota !== undefined) return { quota, shown: state.text };
	if (lastNl !== -1) {
		state.lastNewline = prevLen + lastNl;
		state.quotaScanFrom = state.lastNewline + 1;
		state.quotaLineDead = false;
	}
	const tailStart = state.lastNewline + 1;
	let ws = Math.max(tailStart, state.quotaScanFrom);
	while (isInlineSpace(state.text[ws])) ws += 1;
	if (ws === state.text.length) {
		state.quotaScanFrom = ws;
		return { shown: state.text.slice(0, tailStart) };
	}
	if (state.text[ws] !== "⚠") state.quotaScanFrom = ws;
	const head = skipNoticePrefix(state.text, ws);
	const rest = state.text.slice(head);
	const pending =
		rest.length < NOTICE_HEAD.length
			? NOTICE_HEAD.startsWith(rest)
			: rest.startsWith(NOTICE_HEAD) && NOTICE_ATTEMPT.test(rest.slice(NOTICE_HEAD.length));
	if (!pending) state.quotaLineDead = true;
	return { shown: pending ? state.text.slice(0, tailStart) : state.text };
}
