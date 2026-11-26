import { INJECTION_WARNING_HEAD } from "../safety/injection";

const PEER_REQ = /^\[피어 봇 ([^\]\n]+?)의 요청[^\]]*\]\s*/;

/**
 * Extracts a concise summary for peer-wrapped requests (`[피어 봇 <이름>의 요청 ...]`) and folds markdown links
 * `[label](http.../file...)` so raw filesystem URLs never crowd card titles.
 */
export function extractPeerPreview(text: string): { peer?: string; text: string } {
	const folded = text.replace(/\[([^\]]+)\]\((?:https?|file):\/\/[^)\s]+\)/g, "$1");
	const m = PEER_REQ.exec(folded);
	if (m === null) return { text: folded };
	const peer = (m[1] ?? "").trim();
	const rest = folded.slice(m[0].length);
	// If the message has own words outside quote blocks, keep them; otherwise pull the first meaningful line from the quote.
	const unquoted = rest
		.replace(/<<<quoted-([^>\n]*)>>>[\s\S]*?<<<end-quoted-\1>>>/g, "\n")
		.replace(/<<<quoted-[^>\n]*>>>[\s\S]*/g, "")
		.split("\n")
		.filter((l) => !l.trim().startsWith("[인용·") && !l.trim().startsWith(INJECTION_WARNING_HEAD))
		.join(" ")
		.trim();
	if (unquoted !== "") return { peer, text: unquoted };
	const qm = /<<<quoted-([^>\n]*)>>>([\s\S]*?)(?:<<<end-quoted-\1>>>|$)/.exec(rest);
	const lines = (qm?.[2] ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("```") && !l.startsWith("[인용·"));
	return { peer, text: lines[0] ?? "" };
}
