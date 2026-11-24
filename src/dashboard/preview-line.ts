import { QUOTED_HEADER } from "../core/normalize";
import { redact } from "../redact";
import { INJECTION_WARNING_HEAD } from "../safety/injection";

/** Longest request line a turn shows. */
export const PREVIEW_CHARS = 80;

/** Lines ompbot puts around quoted material (`wrapQuoted`): the header and the injection warning. */
const QUOTE_HEADS = [QUOTED_HEADER.slice(0, QUOTED_HEADER.indexOf("]") + 1), INJECTION_WARNING_HEAD];

/**
 * A request as one masked line: ompbot's quote wrapping removed (every header and warning line and every
 * `<<<quoted-…>>>` block; an open marker with no end drops the rest), secrets masked, mrkdwn links and attachment notes
 * folded, whitespace collapsed, cut to the limit. With none of the owner's words left (only quotes or attachments) the
 * line is `[첨부]` and `fallback` (a flow's first TASK title), else the attachment file names. `limit`: longest line.
 */
export function previewLine(text: string, fallback?: string, limit = PREVIEW_CHARS): string {
	let own = text.replace(/<<<quoted-([^>\n]*)>>>[\s\S]*?<<<end-quoted-\1>>>/g, "\n");
	const open = own.search(/<<<quoted-[^>\n]*>>>/);
	if (open >= 0) own = own.slice(0, open);
	own = own
		.replace(/<<<end-quoted-[^>\n]*>>>/g, "")
		.split("\n")
		.filter((line) => !QUOTE_HEADS.some((head) => line.trim().startsWith(head)))
		.join("\n");
	const folded = redact(own)
		.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
		.replace(/<https?:\/\/([^>]+)>/g, "$1");
	const files = [...folded.matchAll(/\[첨부: ([^\]]*)\]/g)].map(
		(match) =>
			(match[1] ?? "")
				.replace(/\s+\([^)]*\)$/, "")
				.split("/")
				.pop() ?? "",
	);
	let line = folded
		.replace(/\[첨부: [^\]]*\]/g, "[첨부]")
		.replace(/\s+/g, " ")
		.trim();
	if (line.replaceAll("[첨부]", "").trim() === "") {
		const name = fallback === undefined ? files.filter((file) => file !== "").join(", ") : redact(fallback).trim();
		line = name === "" ? "[첨부]" : `[첨부] ${name.replace(/\s+/g, " ")}`;
	}
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : line;
}
