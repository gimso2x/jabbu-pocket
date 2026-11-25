// Lexing helpers of the form HTML parser (`form.ts`): entity decoding and a bounded, linear tag scanner.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const TAG_HEAD = /<(\/?)([a-zA-Z][^\s/>"'<]*)/y;
/** Longest attribute part of one tag, and the deepest open-element stack: real forms stay far below both. */
const MAX_TAG_ATTRS = 1024;
export const MAX_DEPTH = 256;
/** Longest form HTML parsed; a longer one is a form the card cannot take (cancelled). */
export const MAX_HTML = 64 * 1024;

/**
 * One tag at `lt`: `[whole, slash, name, attrs]` or null. A hand scan instead of a backtracking regex — an unclosed
 * `<a<a<a…` made the pattern cubic and froze the event loop — and bounded to MAX_TAG_ATTRS characters of attributes.
 */
export function matchTag(html: string, lt: number, cache: { gt: number }): [string, string, string, string] | null {
	// The first `>` bounds where the tag can end: none within reach fails before any scan (`<a<a<a…` stays linear).
	if (cache.gt < lt) {
		const found = html.indexOf(">", lt);
		cache.gt = found === -1 ? Number.POSITIVE_INFINITY : found;
	}
	if (cache.gt - lt > MAX_TAG_ATTRS) return null;
	TAG_HEAD.lastIndex = lt;
	const head = TAG_HEAD.exec(html);
	if (head === null) return null;
	const from = lt + head[0].length;
	const limit = Math.min(html.length, from + MAX_TAG_ATTRS);
	let at = from;
	while (at < limit) {
		const ch = html[at];
		if (ch === ">") return [html.slice(lt, at + 1), head[1] as string, head[2] as string, html.slice(from, at)];
		if (ch === '"' || ch === "'") {
			const close = html.indexOf(ch, at + 1);
			if (close === -1 || close >= limit) return null;
			at = close + 1;
		} else at += 1;
	}
	return null;
}

export function decode(text: string): string {
	return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
		const code = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
		if (code !== undefined)
			return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
				? String.fromCodePoint(code)
				: whole;
		return ENTITIES[(name as string).toLowerCase()] ?? whole;
	});
}
