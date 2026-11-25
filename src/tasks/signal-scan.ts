export const CHECK_OPEN = "[check:";

/** Index just past the closing quote of the JSON string opening at `i`; `-1` when it is never closed. */
export function skipString(s: string, i: number): number {
	let end = i + 1;
	while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
	return end < s.length ? end + 1 : -1;
}

/** Double quotes of `s` that a backslash does not escape (a backslash pair, then a quote, still counts). */
export function unescapedQuotes(s: string): number {
	let count = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\") i += 1;
		else if (s[i] === '"') count += 1;
	}
	return count;
}

/**
 * Index of the bracket closing the one at `open` (quotes and nesting respected); `-1` when it never closes.
 * With `cache`, memoizes matched pairs and unclosed opens so repeated backward scans stay linear overall.
 */
export function closingBracket(s: string, open: number, cache?: Map<number, number>): number {
	const known = cache?.get(open);
	if (known !== undefined) return known;
	const stack: number[] = [];
	const fail = (): -1 => {
		if (cache !== undefined) {
			for (const pos of stack) cache.set(pos, -1);
		}
		return -1;
	};
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === '"') {
			const past = skipString(s, i);
			if (past === -1) return fail();
			i = past - 1;
		} else if (c === "[" || c === "{") {
			const cached = cache?.get(i);
			if (cached === -1) return fail();
			if (cached !== undefined) {
				i = cached;
				continue;
			}
			stack.push(i);
		} else if (c === "]" || c === "}") {
			const start = stack.pop();
			if (start === undefined) return -1;
			cache?.set(start, i);
			if (stack.length === 0) return i;
		}
	}
	return fail();
}

/** Finds the `[check:` open index matching the last character of trimmed `t`, else `-1`. */
export function trailingCheckOpen(t: string, cache: Map<number, number>): number {
	const tail = t[t.length - 1];
	if (tail !== "]" && tail !== "}") return -1;
	let open = t.lastIndexOf(CHECK_OPEN);
	while (open !== -1 && closingBracket(t, open, cache) !== t.length - 1) {
		open = open === 0 ? -1 : t.lastIndexOf(CHECK_OPEN, open - 1);
	}
	return open;
}
