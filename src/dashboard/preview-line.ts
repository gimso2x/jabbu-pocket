import { QUOTED_HEADER } from "../core/normalize";
import { redact } from "../redact";
import { INJECTION_WARNING_HEAD } from "../safety/injection";
import { extractPeerPreview } from "./preview-peer";

/** Longest request line a turn shows. */
export const PREVIEW_CHARS = 80;
const QUOTE_HEADS = [QUOTED_HEADER.slice(0, QUOTED_HEADER.indexOf("]") + 1), INJECTION_WARNING_HEAD];

/** A request as one masked line: strips quotes/peer wrappers, folds links/attachments, masks secrets, and caps length. */
export function previewLine(text: string, fallback?: string, limit = PREVIEW_CHARS): string {
	const extracted = extractPeerPreview(text);
	let own = extracted.text.replace(/<<<quoted-([^>\n]*)>>>[\s\S]*?<<<end-quoted-\1>>>/g, "\n");
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
		(m) =>
			(m[1] ?? "")
				.replace(/\s+\([^)]*\)$/, "")
				.split("/")
				.pop() ?? "",
	);
	let line = folded
		.replace(/\[첨부: [^\]]*\]/g, "[첨부]")
		.replace(/\s+/g, " ")
		.trim();
	if (extracted.peer) {
		const body = line.replaceAll("[첨부]", "").trim();
		line = body === "" ? `${extracted.peer} 요청` : `${extracted.peer} 요청 · ${line}`;
	} else if (line.replaceAll("[첨부]", "").trim() === "") {
		const name = fallback === undefined ? files.filter((f) => f !== "").join(", ") : redact(fallback).trim();
		line = name === "" ? "[첨부]" : `[첨부] ${name.replace(/\s+/g, " ")}`;
	}
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : line;
}
