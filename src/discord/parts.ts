// A delivery body as Discord messages: GFM tables rendered as stacked Markdown for mobile readability and split into
// parts of at most 2000 characters with code fences closed in each part and surrogate pairs kept whole.
import { chunkText, inlineSpans, REDELIVERED_PREFIX } from "../channel/text";
import { renderStackedTables } from "./table";
import { MESSAGE_CONTENT_LIMIT } from "./transport";

/**
 * Room kept in every part for the footer suffix (`\n_…_`) on the last part: `formatFooter` is an elapsed time and a
 * tool count (`✅ 00:42 · 도구 6회`, ~20 chars), so 64 covers any footer it can produce in practice, with room for a
 * multi-hour turn. The redelivered mark (`(중복 가능: 재전송)\n`, 13 chars) is reserved the same way below.
 */
const FOOTER_RESERVE = 64;

/**
 * The body budget every Discord part is chunked at, whatever the redelivery mark and footer of this render are. A
 * resume re-renders the body, and `sentParts` is an index into the first send's parts — so the chunking must not
 * depend on this render's mark or footer: after a restart the status is gone (no footer at all) while the resume
 * carries the redelivered mark, and a per-render limit would move every boundary, silently losing the slice between
 * the old and the new cut or posting it twice (round 14 F1). The reserve keeps every assembled part within the
 * 2000-character limit: first part ≤ 13 + limit, last part ≤ limit + 64, a single part ≤ 13 + limit + 64 = 2000.
 */
export const DISCORD_PART_LIMIT = MESSAGE_CONTENT_LIMIT - (REDELIVERED_PREFIX.length + 1) - FOOTER_RESERVE;

/**
 * One delivery body as Discord messages: GFM tables rendered as stacked Markdown for mobile readability and split into
 * parts of at most 2000 characters with code fences closed in each part and surrogate pairs kept whole. The body is
 * chunked at {@link DISCORD_PART_LIMIT}, never at this render's own mark/footer budget, so a resume re-renders the
 * same chunks the first send did.
 */
export function renderDiscordParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const parts = chunkPlain(body, DISCORD_PART_LIMIT);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/** Plain text in parts of at most `limit`: stacked tables kept whole when they fit, fences closed in each part. */
export function chunkPlain(body: string, limit: number): string[] {
	const { text, spans } = renderStackedTables(body);
	// A stacked table longer than one message splits on `\n\n` row boundaries; inline spans inside it stay whole.
	const whole = [...spans, ...inlineSpans(text)].filter(([start, end]) => end - start <= limit);
	return chunkText(text, limit, whole);
}
