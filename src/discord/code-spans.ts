import { fenceCloseRun, fenceOpenRun } from "../channel/text";

/** Longest consecutive backtick run in `text` (O(n), no spread). */
export function maxBacktickRun(text: string): number {
	let max = 0;
	let cur = 0;
	for (let i = 0; i < text.length; i++) {
		cur = text[i] === "`" ? cur + 1 : 0;
		if (cur > max) max = cur;
	}
	return max;
}

/** Splits any backtick run reaching `maxRun` with U+200B so wrapping code fences stay trackable by `chunkText`. */
export function clampBacktickRuns(text: string, maxRun: number): string {
	if (maxRun < 2) return text;
	let out = "";
	let run = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === "`") {
			if (run === maxRun - 1) {
				out += "\u200B";
				run = 0;
			}
			out += ch;
			run += 1;
		} else {
			out += ch;
			run = 0;
		}
	}
	return out;
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes += 1;
	return backslashes % 2 === 1;
}

/**
 * Applies `convert` to inline non-code spans of `text` (outside line-head fences). An unescaped backtick run of
 * length `k` closes only on an unescaped run of the exact same length (same line for `k < 3`, anywhere for `k >= 3`).
 */
function convertInline(text: string, convert: (plain: string) => string): string {
	let out = "";
	let last = 0;
	let i = 0;
	const deadMulti = new Set<number>();
	let deadLine = new Set<number>();
	let lineEnd = text.indexOf("\n");
	if (lineEnd === -1) lineEnd = text.length;
	while (i < text.length) {
		if (i === lineEnd) {
			deadLine = new Set<number>();
			const next = text.indexOf("\n", i + 1);
			lineEnd = next === -1 ? text.length : next;
		}
		if (text[i] !== "`") {
			i += 1;
			continue;
		}
		let runEnd = i + 1;
		while (runEnd < text.length && text[runEnd] === "`") runEnd += 1;
		const len = runEnd - i;
		if (isEscaped(text, i)) {
			i += 1;
			continue;
		}
		const multiline = len >= 3;
		if ((multiline ? deadMulti : deadLine).has(len)) {
			i = runEnd;
			continue;
		}
		const limit = multiline ? text.length : lineEnd;
		let closeStart = -1;
		for (let j = runEnd; j < limit; ) {
			if (text[j] !== "`") {
				j += 1;
				continue;
			}
			let end = j + 1;
			while (end < limit && text[end] === "`") end += 1;
			if (end - j === len) {
				closeStart = j;
				break;
			}
			j = end;
		}
		if (closeStart === -1) {
			(multiline ? deadMulti : deadLine).add(len);
			i = runEnd;
			continue;
		}
		const closeEnd = closeStart + len;
		out += convert(text.slice(last, i)) + text.slice(i, closeEnd);
		last = closeEnd;
		i = closeEnd;
		if (multiline && closeEnd > lineEnd) {
			const next = text.indexOf("\n", closeEnd);
			lineEnd = next === -1 ? text.length : next;
			deadLine = new Set<number>();
		}
	}
	return out + convert(text.slice(last));
}

/**
 * Applies `convert` to text outside code fences and inline code spans. Line-head fences follow `fenceOpenRun` /
 * `fenceCloseRun` (so a 4-backtick fence wrapping 3-backtick lines keeps everything inside untouched).
 */
export function outsideCode(text: string, convert: (plain: string) => string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let plain: string[] = [];
	let fence = 0;
	const flushPlain = (): void => {
		if (plain.length === 0) return;
		out.push(convertInline(plain.join("\n"), convert));
		plain = [];
	};
	for (const line of lines) {
		if (fence === 0) {
			const open = fenceOpenRun(line);
			if (open !== undefined) {
				flushPlain();
				fence = open;
				out.push(line);
			} else {
				plain.push(line);
			}
		} else {
			out.push(line);
			if ((fenceCloseRun(line) ?? 0) >= fence) fence = 0;
		}
	}
	flushPlain();
	return out.join("\n");
}
