// agy retries quota failures itself and reports each attempt only as a line of agent text. Regexes copied from omp
// (oh-my-pi eca7acfa45, MIT, `packages/ai/src/providers/antigravity-cli/host.ts` RETRY_NOTICE…NOTICE_ATTEMPT).
const RETRY_NOTICE = /(?:^|\n)[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?API error \(attempt \d+\):[^\S\n]*([^\n]+)/;
const QUOTA_EXHAUSTED = /\bRESOURCE_EXHAUSTED\b|\bcode 429\b/;
const NOTICE_HEAD = "API error (attempt ";
const NOTICE_ATTEMPT = /^\d*$|^\d+\)(?::.*)?$/;

function parseFenceOpen(line: string): { char: "`" | "~"; len: number } | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return undefined;
	const marks = match[1] as string;
	const char = marks[0] as "`" | "~";
	const info = match[2] ?? "";
	if (char === "`" && info.includes("`")) return undefined;
	return { char, len: marks.length };
}

function isFenceClose(line: string, char: "`" | "~", len: number): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
	if (match === null) return false;
	const marks = match[1] as string;
	return marks[0] === char && marks.length >= len;
}

function quotaRetryNoticeLine(line: string): string | undefined {
	const detail = RETRY_NOTICE.exec(line)?.[1]?.trim();
	return detail && QUOTA_EXHAUSTED.test(detail) ? detail : undefined;
}

/** The quota detail of an agy retry notice outside fenced code blocks ("RESOURCE_EXHAUSTED (code 429): …"), else undefined. */
export function quotaRetryNotice(text: string): string | undefined {
	let fence: { char: "`" | "~"; len: number } | undefined;
	for (const line of text.split("\n")) {
		if (fence === undefined) {
			fence = parseFenceOpen(line);
			if (fence !== undefined) continue;
			const hit = quotaRetryNoticeLine(line);
			if (hit !== undefined) return hit;
		} else if (isFenceClose(line, fence.char, fence.len)) {
			fence = undefined;
		}
	}
	return undefined;
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
	fenceChar?: "`" | "~";
	fenceLen?: number;
}

/** Clears accumulated turn text and resets the incremental retry-notice scan cursors. */
export function resetTurnText(state: NoticeScanState): void {
	state.text = "";
	state.lastNewline = -1;
	state.quotaScanFrom = 0;
	state.quotaLineDead = false;
	delete state.fenceChar;
	delete state.fenceLen;
}

function advanceFence(state: NoticeScanState, line: string): boolean {
	if (state.fenceChar === undefined) {
		const open = parseFenceOpen(line);
		if (open === undefined) return false;
		state.fenceChar = open.char;
		state.fenceLen = open.len;
		return true;
	}
	if (isFenceClose(line, state.fenceChar, state.fenceLen ?? 3)) {
		delete state.fenceChar;
		delete state.fenceLen;
	}
	return true;
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
 * only newly completed lines and the live trailing line outside code fences are inspected.
 */
export function appendTurnChunk(state: NoticeScanState, chunk: string): { quota?: string; shown: string } {
	const prevLen = state.text.length;
	state.text += chunk;
	let lineStart = state.lastNewline + 1;
	let nl = chunk.indexOf("\n");
	while (nl !== -1) {
		const lineEnd = prevLen + nl;
		const line = state.text.slice(lineStart, lineEnd);
		if (!advanceFence(state, line) && state.fenceChar === undefined) {
			const quota = quotaRetryNoticeLine(line);
			if (quota !== undefined) return { quota, shown: state.text };
		}
		state.lastNewline = lineEnd;
		state.quotaScanFrom = lineEnd + 1;
		state.quotaLineDead = false;
		lineStart = lineEnd + 1;
		nl = chunk.indexOf("\n", nl + 1);
	}
	if (state.fenceChar !== undefined) {
		state.quotaLineDead = true;
		return { shown: state.text };
	}
	const tailStart = state.lastNewline + 1;
	if (!state.quotaLineDead) {
		const quota = quotaRetryNoticeLine(state.text.slice(tailStart));
		if (quota !== undefined) return { quota, shown: state.text };
	}
	if (state.quotaLineDead) return { shown: state.text };
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
