// An answer as Discord messages: `renderDiscordParts` text and valid ```card fences as embeds (` ```copy ` stays inline).
import { cardRuns, validateCard } from "../channel/card";
import { errorText, REDELIVERED_PREFIX } from "../channel/text";
import { cardToEmbed, type DiscordEmbed } from "./card";
import { chunkPlain, DISCORD_PART_LIMIT, renderDiscordParts } from "./parts";

/** One Discord message of an answer: text or a card's embed (whose content is only the redelivered/footer lines). */
export interface DiscordPart {
	content: string;
	embeds?: DiscordEmbed[];
}

/** `renderDiscordMessages`' result; `cardIssues` lists why card fences stayed text (`card <n>: <issue>`). */
export type DiscordParts = DiscordPart[] & { cardIssues?: readonly string[] };

/**
 * `renderDiscordParts` with cards: each valid ` ```card ` fence (see `splitCards`, at most `MAX_CARDS`) becomes a message
 * of its own in place with its embed from `cardToEmbed`, while ` ```copy ` fences stay inline as ordinary code blocks
 * in the text. Text around cards is split as usual; a card that fails validation or throws stays text with its issues
 * in `cardIssues`. Without a card the result equals `renderDiscordParts`.
 */
export function renderDiscordMessages(body: string, redelivered: boolean, footer?: string): DiscordParts {
	const issues: string[] = [];
	const prefix = redelivered ? `${REDELIVERED_PREFIX}\n` : "";
	const suffix = footer === undefined ? "" : `\n_${footer}_`;
	// Text runs chunk at the same fixed budget as `renderDiscordParts`: a resume must re-render the same pieces
	// the first send did, whatever this render's mark and footer are (round 14 F1). Cards are messages of their own
	// and still cap at the platform limit.
	const limit = DISCORD_PART_LIMIT;
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
		0,
	);
	const pieces = runs.flatMap(
		(run): Array<{ text: string } | { embed: DiscordEmbed }> =>
			run.kind === "card" ? [run] : chunkPlain(run.text, limit).map((text) => ({ text })),
	);
	const last = pieces.length - 1;
	const parts: DiscordParts = pieces.some((piece) => "embed" in piece)
		? pieces.map((piece, i): DiscordPart => {
				const head = i === 0 ? prefix : "";
				const tail = i === last ? suffix : "";
				return "embed" in piece
					? { content: `${head}${tail}`.trim(), embeds: [piece.embed] }
					: { content: `${head}${piece.text}${tail}` };
			})
		: renderDiscordParts(body, redelivered, footer).map((content) => ({ content }));
	if (issues.length > 0) parts.cardIssues = issues;
	return parts;
}
