// An answer as Discord messages: `renderDiscordParts` text, its valid ```card fences embeds and its ```copy fences plain
// messages of their own.
import { cardRuns, validateCard } from "../channel/card";
import { errorText, REDELIVERED_PREFIX } from "../channel/text";
import { cardToEmbed, type DiscordEmbed } from "./card";
import { chunkPlain, renderDiscordParts } from "./format";
import { MESSAGE_CONTENT_LIMIT } from "./transport";

/** One Discord message of an answer: text, a card's embed (whose content is only the redelivered/footer lines) or a copy block (content = its text). */
export interface DiscordPart {
	content: string;
	embeds?: DiscordEmbed[];
}

/** `renderDiscordMessages`' result; `cardIssues` lists why card fences stayed text (`card <n>: <issue>`). */
export type DiscordParts = DiscordPart[] & { cardIssues?: readonly string[] };

/**
 * `renderDiscordParts` with cards and copy blocks: each valid ` ```card ` fence (see `splitCards`, at most `MAX_CARDS`)
 * becomes a message of its own in place, its embed from `cardToEmbed`; a ` ```copy ` fence becomes a message whose
 * content is its text alone, so a long press copies exactly that (one blank, or over the message limit, stays a code
 * block). The text around them is split as usual. A card that fails validation or whose embed rendering throws stays
 * text (a code block), its issues in `cardIssues`. The redelivered line opens the first message and the footer closes
 * the last; a copy message carries neither, so they go in a message of their own before/after it. Without a card or
 * copy block the result equals `renderDiscordParts`.
 */
export function renderDiscordMessages(body: string, redelivered: boolean, footer?: string): DiscordParts {
	const issues: string[] = [];
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	const limit = MESSAGE_CONTENT_LIMIT - prefix.length - suffix.length;
	const runs = cardRuns<{ embed: DiscordEmbed }>(
		body,
		issues,
		(json) => {
			const validated = validateCard(json);
			if (!validated.ok) return validated.issues;
			let embed: DiscordEmbed;
			try {
				embed = cardToEmbed(validated.card, validated.tone);
			} catch (err) {
				// A validated card the embed renderer still chokes on stays text, like an invalid one: the answer goes out.
				return [errorText(err)];
			}
			// A card with nothing to show (no title, text, fields or image) would be an empty message Discord refuses.
			return Object.keys(embed).every((key) => key === "color") ? ["the card has nothing to show"] : { embed };
		},
		MESSAGE_CONTENT_LIMIT,
	);
	const pieces = runs.flatMap(
		(run): Array<{ text: string } | { embed: DiscordEmbed } | { copy: string }> =>
			run.kind === "card"
				? [run]
				: run.kind === "copy"
					? [{ copy: run.text }]
					: chunkPlain(run.text, limit).map((text) => ({ text })),
	);
	const last = pieces.length - 1;
	const parts: DiscordParts = pieces.some((piece) => "embed" in piece || "copy" in piece)
		? pieces.flatMap((piece, i): DiscordPart[] => {
				const head = i === 0 ? prefix : "";
				const tail = i === last ? suffix : "";
				if ("copy" in piece) {
					return [
						...(head === "" ? [] : [{ content: head.trim() }]),
						{ content: piece.copy },
						...(tail === "" ? [] : [{ content: tail.trim() }]),
					];
				}
				return [
					"embed" in piece
						? { content: `${head}${tail}`.trim(), embeds: [piece.embed] }
						: { content: `${head}${piece.text}${tail}` },
				];
			})
		: renderDiscordParts(body, redelivered, footer).map((content) => ({ content }));
	if (issues.length > 0) parts.cardIssues = issues;
	return parts;
}
