// Text for Discord: core text written as Slack mrkdwn becomes Discord markdown (`mrkdwnToDiscord`); a delivery body
// becomes Discord messages of at most 2000 characters (see `parts.ts`), cards and copy blocks split in `messages.ts`.
import { escapeMrkdwn } from "../channel/text";
import { outsideCode } from "./code-spans";

export { renderDiscordParts } from "./parts";
export { outsideCode };

const BARE_SPECIAL_MENTIONS = new Set(["here", "channel", "everyone"]);

function pickMarkers(text: string): [string, string] {
	let open: string | undefined;
	for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
		const ch = String.fromCharCode(cp);
		if (text.includes(ch)) continue;
		if (open === undefined) open = ch;
		else return [open, ch];
	}
	for (let cp = 0xf0000; cp <= 0x10fffd; cp++) {
		const ch = String.fromCodePoint(cp);
		if (text.includes(ch)) continue;
		if (open === undefined) open = ch;
		else return [open, ch];
	}
	throw new Error("unreachable");
}

function convertPlain(text: string): string {
	const urls: string[] = [];
	let markers: [string, string] | undefined;
	const stash = (url: string): string => {
		markers ??= pickMarkers(text);
		const idx = urls.length;
		urls.push(url);
		return `${markers[0]}${idx}${markers[1]}`;
	};
	let out = text
		// `here`/`channel`/`everyone` stay bare words so Discord never pings; other tokens (`subteam`, `date`, …) keep
		// their non-empty label unless it starts with `@here`/`@everyone`.
		.replace(/<!([a-z]{1,30})(?:[^|>]{0,200}(?:\|([^>]{0,200}))?)?>/g, (_, word: string, label?: string) => {
			if (BARE_SPECIAL_MENTIONS.has(word)) return word;
			const trimmed = label?.trim() ?? "";
			return trimmed !== "" && !trimmed.startsWith("@here") && !trimmed.startsWith("@everyone") ? trimmed : word;
		})
		.replace(/<#([0-9]+)\|[^>]{0,200}>/g, "<#$1>")
		// The label may not contain `[]()`: a label with `](` in it would move the link target into the label's own URL.
		.replace(
			/<((?:https?|mailto):[^|>\s]{1,512})\|([^>[\]()]{1,500})>/g,
			(_, u: string, t: string) => `[${t}](${stash(u)})`,
		)
		.replace(/<((?:https?|mailto):[^|>\s]{1,512})>/g, (_, u: string) => stash(u))
		.replace(/(?:https?|mailto):(?:[^\s<>()[\]]|\([^\s<>()]*\))+/g, (u: string, offset: number, src: string) => {
			const prev = offset > 0 ? src[offset - 1] : "";
			if ((prev === "*" || prev === "~") && u.endsWith(prev) && u.length > 1) {
				return `${stash(u.slice(0, -1))}${prev}`;
			}
			return stash(u);
		})
		// A `\*` / `\~` (`escapeDiscordMarkdown`) is a literal character, never a delimiter.
		.replace(/(^|[^\w*\\])\*(?=\S)([^*\n]+?)(?<=[^\s\\])\*(?![\w*])/g, "$1**$2**")
		.replace(/(^|[^\w~\\])~(?=\S)([^~\n]+?)(?<=[^\s\\])~(?![\w~])/g, "$1~~$2~~");
	if (markers !== undefined) {
		const [open, close] = markers;
		out = out.replace(new RegExp(`${open}(\\d+)${close}`, "g"), (_, i: string) => urls[Number(i)] ?? "");
	}
	// Slack's `&`/`<`/`>` escapes, undone last so a literal `<` never reads as a Slack token above.
	return out
		.replace(/&lt;(?=[@#!])/g, "\\<")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
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
