// Shared line-head code-fence detection (backtick and tilde) and linear-time markdown link scanning.

export interface FenceMark {
	char: "`" | "~";
	len: number;
}

const LINK_LABEL_MAX = 512;
const LINK_URL_MAX = 1024;

/**
 * Code-fence opener at a line's start (`0..3` leading spaces, `3+` backticks or tildes). Backtick fences forbid
 * backticks in the info string so inline spans like ```` ```bash cmd``` ```` do not open a block.
 */
export function fenceOpen(line: string): FenceMark | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return undefined;
	const run = match[1] as string;
	const char = run[0] as "`" | "~";
	if (char === "`" && (match[2] ?? "").includes("`")) return undefined;
	return { char, len: run.length };
}

/** Whether `line` closes `open` (same fence character, run length at least `open.len`, only spaces/CR after). */
export function fenceCloses(line: string, open: FenceMark): boolean {
	const match = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(line);
	if (match === null) return false;
	const run = match[1] as string;
	return run[0] === open.char && run.length >= open.len;
}

/**
 * Moves a cut off a code fence mark: a cut inside a line opening with ``` or ~~~ goes to that line's start, a cut
 * inside a fence-char run to the run's start, and a cut inside a language tag right after a mid-line run to that run.
 */
export function fenceSafeCut(text: string, cut: number): number {
	if (cut <= 0 || cut >= text.length) return cut;
	const lineStart = text.lastIndexOf("\n", cut - 1) + 1;
	const newline = text.indexOf("\n", lineStart);
	const lineEnd = newline === -1 ? text.length : newline;
	if (cut < lineEnd && /^[ \t]*(?:```|~~~)/.test(text.slice(lineStart, lineEnd))) return lineStart;
	const runStart = (end: number, ch: string): number => {
		let start = end;
		while (start > 0 && text[start - 1] === ch) start -= 1;
		return start;
	};
	const prev = text[cut - 1];
	if ((prev === "`" || prev === "~") && text[cut] === prev) return runStart(cut - 1, prev);
	if (/\s/.test(text[cut] ?? " ")) return cut;
	let tag = cut;
	while (tag > lineStart && !/[\s`~]/.test(text[tag - 1] ?? " ")) tag -= 1;
	const ch = text[tag - 1];
	if (ch !== "`" && ch !== "~") return cut;
	const start = runStart(tag, ch);
	return tag - start >= 3 ? start : cut;
}

/**
 * Scans `segment` in O(n) without backtracking for markdown links/images (`[label](url)`, `![alt](url)`), allowing
 * balanced nested brackets inside the label (`1..512` chars) and balanced parentheses inside the URL (`0..1024` chars)
 * without newlines. Returns `[baseOffset + start, baseOffset + end)` spans.
 */
export function findLinkSpans(segment: string, baseOffset = 0): Array<readonly [number, number]> {
	const spans: Array<readonly [number, number]> = [];
	const stack: Array<{ spanStart: number; bracketStart: number; isImage: boolean }> = [];
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\n") {
			stack.length = 0;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length && segment[i + 1] !== "\n") {
			i += 1;
			continue;
		}
		if (ch === "!" && segment[i + 1] === "[") {
			stack.push({ spanStart: i, bracketStart: i + 1, isImage: true });
			i += 1;
			continue;
		}
		if (ch === "[") {
			stack.push({ spanStart: i, bracketStart: i, isImage: false });
			continue;
		}
		if (ch !== "]") continue;
		const open = stack.pop();
		if (open === undefined) continue;
		const labelLen = i - open.bracketStart - 1;
		if (labelLen < 1 || labelLen > LINK_LABEL_MAX || segment[i + 1] !== "(") continue;
		const urlStart = i + 2;
		const firstClose = segment.indexOf(")", urlStart);
		if (firstClose === -1 || firstClose - urlStart > LINK_URL_MAX) continue;
		let depth = 1;
		let k = urlStart;
		const maxEnd = Math.min(segment.length, urlStart + LINK_URL_MAX + 1);
		while (k < maxEnd) {
			const u = segment[k];
			if (u === "\n") break;
			if (u === "\\" && k + 1 < maxEnd && segment[k + 1] !== "\n") {
				k += 2;
				continue;
			}
			if (u === "(") depth += 1;
			else if (u === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
			k += 1;
		}
		if (depth === 0 && k - urlStart <= LINK_URL_MAX) {
			spans.push([baseOffset + open.spanStart, baseOffset + k + 1]);
			if (!open.isImage) stack.length = 0;
			i = k;
		}
	}
	return spans;
}
