// Text for Discord: core text written as Slack mrkdwn becomes Discord markdown (`mrkdwnToDiscord`), and a delivery body
// becomes Discord messages of at most 2000 characters (`renderDiscordParts`); cards and copy blocks split in `messages.ts`.
import { chunkText, escapeMrkdwn, inlineSpans, REDELIVERED_PREFIX } from "../channel/text";
import { outsideCode } from "./code-spans";
import { renderStackedTables } from "./table";
import { MESSAGE_CONTENT_LIMIT } from "./transport";

export { outsideCode };

function convertPlain(text: string): string {
	return (
		text
			// Slack special mentions (`<!here>`, `<!channel|@channel>`, `<!subteam^ID>`) become their bare word: Discord
			// would ping `@here`/`@everyone`, and nothing the core writes means to.
			.replace(/<!([a-z]{1,30})[^>]{0,200}>/g, "$1")
			.replace(/<#([0-9]+)\|[^>]{0,200}>/g, "<#$1>")
			// The label may not contain `[]()`: a label with `](` in it would move the link target into the label's own URL.
			.replace(/<((?:https?|mailto):[^|>\s]{1,512})\|([^>[\]()]{1,500})>/g, (_, u: string, t: string) => `[${t}](${u})`)
			.replace(/<((?:https?|mailto):[^|>\s]{1,512})>/g, "$1")
			// A `\*` / `\~` (`escapeDiscordMarkdown`) is a literal character, never a delimiter.
			.replace(/(^|[^\w*\\])\*(?=\S)([^*\n]+?)(?<=[^\s\\])\*(?![\w*])/g, "$1**$2**")
			.replace(/(^|[^\w~\\])~(?=\S)([^~\n]+?)(?<=[^\s\\])~(?![\w~])/g, "$1~~$2~~")
			// Slack's `&`/`<`/`>` escapes, undone last so a literal `<` never reads as a Slack token above.
			.replace(/&lt;(?=[@#!])/g, "\\<")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
	);
}

/**
 * Slack mrkdwn (what `OutboundMessage.text` carries) → Discord markdown: `*bold*`, `~strike~`, `<url|label>`, `<url>`
 * and the `&amp;`/`&lt;`/`&gt;` escapes. `<@id>` and `<#id>` mean the same on both. Code spans stay as they are.
 */
export function mrkdwnToDiscord(text: string): string {
	return outsideCode(text, convertPlain);
}

/**
 * Owner text quoted into core text bound for Discord (an inject marker's preview): Discord's markdown characters are
 * backslash-escaped so they show as typed, and `&`/`<`/`>` get the core text escapes `mrkdwnToDiscord` undoes.
 */
export function escapeDiscordMarkdown(text: string): string {
	return escapeMrkdwn(text.replace(/[\\*_`~|>()[\]]/g, "\\$&").replace(/(^|\n)( {0,3})(#)/g, "$1$2\\$3"));
}

/**
 * One delivery body as Discord messages: GFM tables rendered as stacked Markdown for mobile readability and split into
 * parts of at most 2000 characters with code fences closed in each part and surrogate pairs kept whole.
 */
export function renderDiscordParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const parts = chunkPlain(body, MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/** Plain text in parts of at most `limit`: stacked tables kept whole when they fit, fences closed in each part. */
export function chunkPlain(body: string, limit: number): string[] {
	const { text, spans } = renderStackedTables(body);
	// A stacked table longer than one message splits on `\n\n` row boundaries; inline spans inside it stay whole.
	const whole = [...spans, ...inlineSpans(text)].filter(([start, end]) => end - start <= limit);
	return chunkText(text, limit, whole);
}
