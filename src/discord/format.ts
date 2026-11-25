// Text for Discord: core text written as Slack mrkdwn becomes Discord markdown (`mrkdwnToDiscord`), and a delivery body
// (the model's markdown, which Discord mostly draws as is) becomes messages of at most 2000 characters
// (`renderDiscordParts`); cards and copy blocks are cut out in `messages.ts`.
import { tableToAscii } from "../channel/card";
import {
	chunkText,
	delimiterAligns,
	escapeMrkdwn,
	fenceCloseRun,
	fenceOpenRun,
	REDELIVERED_PREFIX,
	splitRowCells,
	tableEndAt,
} from "../channel/text";
import { maxBacktickRun, outsideCode } from "./code-spans";
import { MESSAGE_CONTENT_LIMIT } from "./transport";

export { outsideCode };

function convertPlain(text: string): string {
	return (
		text
			// Slack special mentions (`<!here>`, `<!channel|@channel>`, `<!subteam^ID>`) become their bare word: Discord
			// would ping `@here`/`@everyone`, and nothing the core writes means to.
			.replace(/<!([a-z]{1,30})[^>]{0,200}>/g, "$1")
			.replace(/<#([0-9]+)\|[^>]{0,200}>/g, "<#$1>")
			.replace(/<((?:https?|mailto):[^|>\s]{1,512})\|([^>]{1,500})>/g, (_, u: string, t: string) => `[${t}](${u})`)
			.replace(/<((?:https?|mailto):[^|>\s]{1,512})>/g, "$1")
			// A `\*` / `\~` (`escapeDiscordMarkdown`) is a literal character, never a delimiter.
			.replace(/(^|[^\w*\\])\*(?=\S)([^*\n]+?)(?<=[^\s\\])\*(?![\w*])/g, "$1**$2**")
			.replace(/(^|[^\w~\\])~(?=\S)([^~\n]+?)(?<=[^\s\\])~(?![\w~])/g, "$1~~$2~~")
			// Slack's `&`/`<`/`>` escapes, undone last so a literal `<` never reads as a Slack token above.
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
	return escapeMrkdwn(text.replace(/[\\*_`~|>]/g, "\\$&"));
}

/** Inline `code`, `[label](url)`, `**bold**`, `__bold__` show literally in a fence; spans are capped (linear time). */
const CELL_INLINE =
	/(?<!`)(`+)(?!`)(.{1,128}?)(?<!`)\1(?!`)|\[([^[\]]{1,256})\]\((?:[^()\n]|\([^()\n]{0,512}\)){0,1024}\)|\*\*(?=\S)(.{1,128}?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.{1,128}?)(?<=\S)__(?!\w)/g;

function stripCellMarkdown(cell: string): string {
	return cell.replace(
		CELL_INLINE,
		(match, _ticks, code?: string, linkLabel?: string, boldStar?: string, boldUnder?: string) => {
			if (code !== undefined) return code;
			if (linkLabel !== undefined) return stripCellMarkdown(linkLabel);
			if (boldStar !== undefined) return stripCellMarkdown(boldStar);
			if (boldUnder !== undefined) return stripCellMarkdown(boldUnder);
			return match;
		},
	);
}

/**
 * GFM tables (a header row, a `|---|` rule of 3+ hyphens a cell, more rows) outside code fences, each aligned by
 * `displayWidth` and wrapped in a code fence: Discord does not draw tables. Returns the text and the wrapped spans,
 * which a split must keep whole.
 */
function fenceTables(text: string): { text: string; spans: Array<[number, number]> } {
	const lines = text.split("\n");
	const out: string[] = [];
	const spans: Array<[number, number]> = [];
	let offset = 0;
	let fenceRun = 0;
	const push = (line: string): void => {
		out.push(line);
		offset += line.length + 1;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// A fence opens on a line of 3+ backticks and an info string without backticks, and closes on a line of backticks
		// alone at least as long; a fence closed on its own line (```bash x```) opens nothing.
		if (fenceRun === 0) fenceRun = fenceOpenRun(line) ?? 0;
		else if ((fenceCloseRun(line) ?? 0) >= fenceRun) fenceRun = 0;
		const end = fenceRun > 0 ? undefined : tableEndAt(lines, i, 3);
		if (end === undefined) {
			push(line);
			continue;
		}
		const headers = splitRowCells(line).map(stripCellMarkdown);
		const rows = lines.slice(i + 2, end).map((row) => {
			const cells = splitRowCells(row).map(stripCellMarkdown);
			return headers.map((_, col) => cells[col] ?? "");
		});
		// The delimiter row's `:` markers pick the padding side; the markers themselves never reach the output.
		const align = delimiterAligns(lines[i + 1] ?? "");
		const ascii = tableToAscii({ headers, rows }, { rule: true, align });
		const fence = "`".repeat(Math.max(3, maxBacktickRun(ascii) + 1));
		const start = offset;
		push(fence);
		for (const row of ascii.split("\n")) push(row);
		push(fence);
		spans.push([start, offset - 1]);
		i = end - 1;
	}
	return { text: out.join("\n"), spans };
}

/**
 * One delivery body as Discord messages: tables fenced, split into parts of at most 2000 characters with code fences
 * closed in each part and surrogate pairs kept whole. A redelivered answer is marked in its first part; `footer`
 * (elapsed time, tool count) closes the last one as an italic line.
 */
export function renderDiscordParts(body: string, redelivered: boolean, footer?: string): string[] {
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const parts = chunkPlain(body, MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length);
	return parts.map((part, i) => `${i === 0 ? prefix : ""}${part}${i === parts.length - 1 ? suffix : ""}`);
}

/** Plain text in parts of at most `limit`: tables fenced and kept whole when they fit, fences closed in each part. */
export function chunkPlain(body: string, limit: number): string[] {
	const { text, spans } = fenceTables(body);
	// A table longer than a message cannot stay whole; it is split like any fenced block.
	return chunkText(
		text,
		limit,
		spans.filter(([start, end]) => end - start <= limit),
	);
}
