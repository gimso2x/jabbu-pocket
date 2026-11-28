// Platform-neutral text helpers every adapter shares: message chunking, the redelivery mark, the running status line
// and the final marks a finished turn leaves.
import type { RecentTool, TurnProgress } from "../core/mailbox";
import { typicalNote } from "../store/turn-duration";
import { type FenceMark, fenceCloses, fenceOpen, fenceSafeCut, findLinkSpans } from "./fence";

export const CHUNK_LIMIT = 3900;
export const REDELIVERED_PREFIX = "(중복 가능: 재전송)";
/** What a non-owner gets back for a command or a button click (ephemeral). */
export const DENIED_TEXT = "권한 없음: 이 봇은 오너만 사용할 수 있습니다.";

/**
 * Room kept in every chunk so a code fence cut by a split can be closed ("\n```") and reopened ("```\n"); `chunkText`
 * keeps two more characters per extra backtick of the longest fence in the text.
 */
export const FENCE_RESERVE = 8;

/** Minimum gap between two edits of one running status message. */
export const STATUS_MIN_INTERVAL_MS = 15_000;
/** Longest text of one progress line (a tool call, the current task-list item) in the running status message. */
const ACTIVITY_MAX = 60;

/** Running-status text while the turn has emitted no omp event for the stall window (120 s). */
export const STALL_STATUS_TEXT = "⏸ 응답 없음 2분";

/** The text format of `OutboundMessage.text` escapes only &, < and >; core text quoted into it goes through this. */
export const escapeMrkdwn = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function splitAt(text: string, limit: number, keepWhole: (cut: number) => number): [string, string] {
	if (text.length <= limit) return [text, ""];
	let cut = text.lastIndexOf("\n\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf("\n", limit);
	if (cut < limit / 2) cut = text.lastIndexOf(" ", limit);
	if (cut < limit / 2) {
		cut = limit;
		// never split a surrogate pair
		if (text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
		// A limit of 1 on an emoji: the code point goes out whole rather than not at all.
		if (cut === 0) cut = 2;
	}
	cut = keepWhole(cut);
	// The fence fix only moves the cut back; it is dropped when nothing would be left before it (the loop of
	// `chunkText` must always advance) or when it lands inside a span kept whole.
	const fenced = fenceSafeCut(text, cut);
	if (fenced > 0 && keepWhole(fenced) === fenced) cut = fenced;
	return [text.slice(0, cut), text.slice(cut).replace(/^\n+/, "")];
}

/**
 * Splits into messages of at most `limit` characters, preferring paragraph/line boundaries and keeping code fences
 * balanced; a fence mark and a line opening a fence are never cut in two. A cut inside one of the `keepWhole` spans
 * (each at most the limit) moves to the line break before it, or past it when the span opens the message. Text within
 * the limit is one chunk; a chunk of only whitespace is dropped (the first stays when every chunk is blank).
 *
 * The contract holds for every `limit >= 1`: the call returns, and with `limit >= 2` every chunk, the fence it closes
 * and the fence it reopens included, is at most `limit` long. A chunk the fences leave no room in is cut as plain text
 * (no fence reopened). The smallest unit is one code point, so at `limit` 1 a surrogate pair is a chunk of length 2.
 */
export function chunkText(
	text: string,
	limit = CHUNK_LIMIT,
	keepWhole: ReadonlyArray<readonly [number, number]> = [],
): string[] {
	// Text that fits is one message: the fence reserve below is for cuts, so it must not split a 1,993–2,000 char text.
	if (text.length <= limit) return [text];
	const maxRun = Math.max(16, Math.floor(limit / 4));
	const emitFor = (len: number): number => (len <= maxRun ? len : 3);
	let longest = 3;
	for (const line of text.split("\n")) {
		const open = fenceOpen(line);
		if (open !== undefined) longest = Math.max(longest, emitFor(open.len));
	}
	const budget = limit - FENCE_RESERVE - 2 * (longest - 3);
	const chunks: string[] = [];
	// Line-head fences track their full `closeLen` so only `>= closeLen` of the same char closes them, while chunk
	// boundaries emit `emitLen` (`<= maxRun`, else 3). Mid-line ``` toggles a 3-backtick state (`lineHead: false`).
	type FenceState = { char: "`" | "~"; closeLen: number; emitLen: number; lineHead: boolean };
	let state: FenceState | undefined;
	const scan = (chunk: string, from: FenceState | undefined): FenceState | undefined => {
		let cur = from === undefined ? undefined : { ...from };
		for (const line of chunk.split("\n")) {
			if (cur?.lineHead) {
				if (fenceCloses(line, { char: cur.char, len: cur.closeLen })) cur = undefined;
				continue;
			}
			const opened = cur === undefined ? fenceOpen(line) : undefined;
			if (opened !== undefined) {
				cur = { char: opened.char, closeLen: opened.len, emitLen: emitFor(opened.len), lineHead: true };
			} else if ((line.match(/```/g) ?? []).length % 2 === 1) {
				cur = cur === undefined ? { char: "`", closeLen: 3, emitLen: 3, lineHead: false } : undefined;
			}
		}
		return cur;
	};
	let rest = text;
	while (rest.length > 0) {
		const base = text.length - rest.length;
		// A chunk too long once its fences are added is cut again, shorter by the overflow.
		let [room, head, tail, out] = [budget, "", "", ""];
		for (;;) {
			if (room < 1) {
				head = cutCodePointSafe(rest, limit);
				if (head === "") head = String.fromCodePoint(rest.codePointAt(0) ?? 0);
				tail = rest.slice(head.length);
				out = head;
				state = undefined;
				break;
			}
			[head, tail] = splitAt(rest, room, (cut) => {
				const span = keepWhole.find(([start, end]) => start < base + cut && base + cut < end);
				if (span === undefined) return cut;
				const before = span[0] - base - (rest[span[0] - base - 1] === "\n" ? 1 : 0);
				return before > 0 ? before : span[1] - base;
			});
			const next = scan(head, state === undefined ? undefined : { ...state, lineHead: true });
			out = state !== undefined ? `${state.char.repeat(state.emitLen)}\n${head}` : head;
			if (next !== undefined) out = `${out}\n${next.char.repeat(next.emitLen)}`;
			if (out.length <= limit) {
				state = next;
				break;
			}
			room -= out.length - limit;
		}
		const atLineBreak = head.length === 0 || rest[head.length] === "\n" || rest[head.length - 1] === "\n";
		chunks.push(out);
		rest = tail;
		// A cut just before the fence's own closing line: this chunk already ends with a closer, so that line is dropped
		// instead of opening an empty block in the next chunk.
		if (state?.lineHead && atLineBreak) {
			const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:(?:\r?\n)+|$)/.exec(rest);
			const run = closer?.[1];
			if (closer !== null && run !== undefined && run[0] === state.char && run.length >= state.closeLen) {
				rest = rest.slice(closer[0].length);
				state = undefined;
			}
		}
	}
	// A chunk of only whitespace is dropped (Discord refuses an empty message); a text of nothing else keeps its first.
	const kept = chunks.filter((chunk) => chunk.trim() !== "");
	return kept.length > 0 ? kept : [chunks[0] ?? ""];
}

/**
 * The backtick count of a line opening a fence (up to 3 spaces, 3+ backticks, an info string without backticks);
 * `undefined` when the line opens none. The one line-head rule every renderer's fence handling shares.
 */
export const fenceOpenRun = (line: string): number | undefined => /^ {0,3}(`{3,})[^`]*$/.exec(line)?.[1]?.length;

/**
 * The backtick count of a line closing a fence (up to 3 spaces, backticks alone, optional trailing spaces and CR);
 * `undefined` when the line closes none. A fence closes only on a line at least as long as its opening run.
 */
export const fenceCloseRun = (line: string): number | undefined => /^ {0,3}(`+)[ \t]*\r?$/.exec(line)?.[1]?.length;

/**
 * How a thread's ⏳ status message and 👀 reaction end: normal close, failure, a cancelled wait, or an answer the
 * delivery ledger gave up on (ambiguous send, retries spent, expired).
 */
export type FinalOutcome = "done" | "failed" | "cancelled" | "undelivered";

/** One place deciding how each final outcome reads in the status line and which reaction mark it leaves. */
export const FINAL_MARKS: Record<FinalOutcome, { label: string; mark: string }> = {
	done: { label: "✅ 완료", mark: "white_check_mark" },
	cancelled: { label: "🚫 취소됨", mark: "x" },
	failed: { label: "⚠️ 실패", mark: "warning" },
	undelivered: { label: "⚠️ 답을 보내지 못했습니다", mark: "warning" },
};

/**
 * The footer an answer carries when it takes the place of the thread's deleted `⏳` status: `✅ 00:42 · 도구 6회`
 * (the outcome's mark and elapsed time, then the tool count when the turn ran any). The adapter
 * decides from its own status entry whether the answer gets one at all.
 */
export function formatFooter(outcome: "done" | "failed", elapsedMs: number, tools: number): string {
	const mark = FINAL_MARKS[outcome].label.split(" ")[0];
	return `${mark} ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}`;
}

/** A thrown value as one log field: its message, or the value itself when it is not an Error. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export { errorFields } from "./error-fields";

/** Collapses control characters, line separators and bidi overrides so untrusted text cannot start a new prompt line. */
export const oneLine = (text: string, max: number): string =>
	cutCodePointSafe(text.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, " ").trim(), max);

/** Cuts to at most `limit` UTF-16 units without leaving a lone high surrogate at the end; "" for `limit <= 0`. */
export function cutCodePointSafe(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (text.length <= limit) return text;
	const last = text.charCodeAt(limit - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/** One progress line: a single line of at most `ACTIVITY_MAX`, never ending in a lone high surrogate. */
export function progressLine(text: string): string {
	const cut = oneLine(text, ACTIVITY_MAX);
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The running status message: `⏳ 작업 중 · mm:ss · 도구 N회` (or the stalled text and the elapsed time), then the
 * task-list, steer, retry and recent-tool lines; a line whose value is 0 or unknown is left out.
 */
export function runningStatusText(stalled: boolean, elapsedMs: number, progress: TurnProgress | undefined): string {
	const tools = progress?.tools ?? 0;
	const note = typicalNote(elapsedMs, progress?.typical);
	const usual = note === undefined ? "" : ` · ${note}`;
	const head = stalled
		? `${STALL_STATUS_TEXT} · ${formatElapsed(elapsedMs)}`
		: `⏳ 작업 중 · ${formatElapsed(elapsedMs)}${tools > 0 ? ` · 도구 ${tools}회` : ""}${usual}`;
	if (progress === undefined) return head;
	const lines = [head];
	const { todo } = progress;
	if (todo !== undefined && todo.total > 0) {
		const current = todo.current === undefined ? "" : progressLine(todo.current);
		lines.push(`📋 ${todo.done}/${todo.total}${current === "" ? "" : ` · ${current}`}`);
	}
	if (progress.steers > 0) {
		const capped = progress.steerCapped ? " · 이후 메시지는 이 작업 뒤에 이어서 처리" : "";
		lines.push(`📨 추가 메시지 ${progress.steers}건 반영${capped}`);
	}
	if (progress.retries > 0) lines.push(`🔁 모델 재시도 ${progress.retries}회`);
	lines.push(...toolLines(progress.recentTools));
	return lines.join("\n");
}

/** Tool lines of the status: `▸` running, `✓`/`✗` with the time it took; equal text and state in a row merge to `×N`. */
function toolLines(tools: readonly RecentTool[]): string[] {
	const out: string[] = [];
	let last: { line: string; count: number; key: string } | undefined;
	for (const tool of tools) {
		const text = progressLine(tool.text);
		if (text === "") continue;
		const key = `${tool.state}\n${text}`;
		if (last?.key === key) {
			last.count += 1;
			out[out.length - 1] = `${last.line} ×${last.count}`;
			continue;
		}
		const took = tool.endedAt === undefined ? "" : ` · ${formatElapsed(tool.endedAt - tool.startedAt)}`;
		const mark = tool.state === "running" ? "▸" : tool.state === "ok" ? "✓" : "✗";
		const line = `${mark} ${text}${took}`;
		last = { line, count: 1, key };
		out.push(line);
	}
	return out;
}

/** Terminal-style width of `text` (`Bun.stringWidth`): East Asian wide/fullwidth, emoji and ZWJ sequences count 2 columns, marks 0. */
export const displayWidth = (text: string): number => Bun.stringWidth(text);

/** Splits one GFM table row into trimmed cells; `\|` is a literal pipe, and a pipe inside a backtick span stays cell content. */
export function splitRowCells(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
	// An unclosed backtick run opens no span (GFM: the pipe still separates): split the row plainly.
	return scanRowCells(trimmed, true) ?? scanRowCells(trimmed, false) ?? [];
}

/** Cells of a row with pipes outside backtick runs splitting it; undefined when a run is still open at the end. */
// from dbc-hbin/omp-superagent (MIT): the backtick-run tracking of `splitRow` in src/discord-markdown.ts
function scanRowCells(trimmed: string, ticks: boolean): string[] | undefined {
	const cells: string[] = [];
	let cell = "";
	let tick = 0;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			cell += "|";
			i++;
			continue;
		}
		if (ticks && ch === "`") {
			// GFM: a code span opens with a run of N backticks and closes with the next run of exactly N.
			let run = 1;
			while (trimmed[i + run] === "`") run++;
			tick = tick === run ? 0 : tick === 0 ? run : tick;
			cell += "`".repeat(run);
			i += run - 1;
			continue;
		}
		if (ch === "|" && tick === 0) {
			cells.push(cell.trim());
			cell = "";
			continue;
		}
		cell += ch;
	}
	if (tick !== 0) return undefined;
	cells.push(cell.trim());
	return cells;
}

/** A column's alignment from its GFM delimiter row (`:---:` center, `---:` right, otherwise left). */
// from dbc-hbin/omp-superagent (MIT): `parseDelimiter` in src/discord-markdown.ts
export type ColumnAlign = "left" | "center" | "right";

/**
 * Per-column alignment of a delimiter row (`splitRowCells` of the row between header and body). Undefined when the row
 * is not a delimiter row at all; a cell without colons is left-aligned.
 */
export function delimiterAligns(line: string): ColumnAlign[] | undefined {
	const cells = splitRowCells(line);
	if (cells.length === 0) return undefined;
	const rule = /^:?-+:?$/;
	if (!cells.every((cell) => rule.test(cell))) return undefined;
	return cells.map((cell) =>
		cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
	);
}

const INDENTED_CODE = /^(?: {4}|\t)/;
const BLOCK_START = /^(?: {4}|\t| {0,3}(?:>|#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)))/;

/**
 * When a GFM table starts at line `i`, the index of the first line after it: a row of 2+ cells, a delimiter row of the
 * same count (hyphens, at least `minDashes` per cell, optional colons) and the rows after it holding an unescaped pipe.
 * Indented code lines (4 spaces or tab) never open a table; a quote, heading or list line after rows ends the table.
 */
export function tableEndAt(lines: readonly string[], i: number, minDashes = 1): number | undefined {
	const headerLine = lines[i] ?? "";
	const delimLine = lines[i + 1];
	if (delimLine === undefined || INDENTED_CODE.test(headerLine) || INDENTED_CODE.test(delimLine)) return undefined;
	const header = splitRowCells(headerLine);
	const delimiter = splitRowCells(delimLine);
	if (header.length < 2 || header.length !== delimiter.length) return undefined;
	const rule = new RegExp(`^\\s*:?-{${minDashes},}:?\\s*$`);
	if (!delimiter.every((cell) => rule.test(cell))) return undefined;
	let j = i + 2;
	while (j < lines.length && /(?<!\\)\|/.test(lines[j] ?? "") && !BLOCK_START.test(lines[j] ?? "")) j++;
	return j;
}

/** A Discord timestamp, spoiler or autolink (markdown links are scanned by `findLinkSpans`). */
const INLINE_SPAN = /<t:\d{1,20}(?::[dDfFtTR])?>|\|\|[^|]{1,4096}\|\||<(?:https?|mailto):[^>\s]{1,512}>/g;

/** `[start, end)` spans of markdown links, timestamps, spoilers and autolinks outside code fences. */
export function inlineSpans(text: string): Array<readonly [number, number]> {
	const spans: Array<readonly [number, number]> = [];
	let fence: FenceMark | undefined;
	let [offset, from] = [0, 0];
	const flush = (to: number): void => {
		if (to <= from) return;
		const segment = text.slice(from, to);
		const found: Array<readonly [number, number]> = [...findLinkSpans(segment, from)];
		for (const m of segment.matchAll(INLINE_SPAN)) {
			const start = from + (m.index ?? 0);
			found.push([start, start + m[0].length]);
		}
		found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
		spans.push(...found);
	};
	for (const line of text.split("\n")) {
		if (fence === undefined) {
			fence = fenceOpen(line);
			if (fence !== undefined) flush(offset);
		} else if (fenceCloses(line, fence)) {
			fence = undefined;
			from = offset + line.length + 1;
		}
		offset += line.length + 1;
	}
	if (fence === undefined) flush(text.length);
	return spans;
}

/** `[start, end)` character spans of the GFM tables outside code fences: a chunk cut must not fall inside one. */
export function tableSpans(text: string): Array<readonly [number, number]> {
	const lines = text.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const spans: Array<readonly [number, number]> = [];
	// Fences follow the line-head rule of `fenceOpen`/`fenceCloses` (backtick or tilde); prose ``` opens nothing.
	let fence: FenceMark | undefined;
	let i = 0;
	while (i < lines.length) {
		const end = fence !== undefined ? undefined : tableEndAt(lines, i);
		if (end !== undefined) spans.push([starts[i] ?? 0, (starts[end - 1] ?? 0) + (lines[end - 1] ?? "").length]);
		else {
			const line = lines[i] ?? "";
			if (fence === undefined) fence = fenceOpen(line);
			else if (fenceCloses(line, fence)) fence = undefined;
			i++;
		}
		if (end !== undefined) i = end;
	}
	return spans;
}
