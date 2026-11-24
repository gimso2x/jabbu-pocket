/** An interpolation that only reads a value: `a`, `a.b`, `a?.b`, `a[0]`, `a["k"]`. Calls, operators and nesting are code. */
const PLAIN_EXPRESSION = /^\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\s*(?:\d+|"[^"\\]*"|'[^'\\]*')\s*\])*\s*$/;

/** Index of the quote that closes the plain string opened at `start`, or -1. */
function quotedEnd(text: string, start: number): number {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") i += 1;
		else if (text[i] === quote) return i;
	}
	return -1;
}

/**
 * The backtick template opened at `start`: the index of its closing backtick (-1 when it never closes on this line)
 * and whether every `${…}` in it, at any depth, is a plain read. A `${…}` is followed to its matching brace, counting
 * brackets and skipping strings and nested templates, so a template inside an interpolation cannot end the outer one.
 */
function templateEnd(text: string, start: number): { end: number; plain: boolean } {
	let plain = true;
	for (let i = start + 1; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === "\\") i += 1;
		else if (ch === "`") return { end: i, plain };
		else if (ch === "$" && text[i + 1] === "{") {
			const from = i + 2;
			let depth = 1;
			let j = from;
			for (; j < text.length && depth > 0; j++) {
				const c = text[j] as string;
				if (c === '"' || c === "'") {
					const end = quotedEnd(text, j);
					if (end < 0) return { end: -1, plain: false };
					j = end;
				} else if (c === "`") {
					const inner = templateEnd(text, j);
					if (inner.end < 0) return { end: -1, plain: false };
					plain = false;
					j = inner.end;
				} else if (c === "{") depth += 1;
				else if (c === "}") depth -= 1;
			}
			if (depth > 0) return { end: -1, plain: false };
			if (!PLAIN_EXPRESSION.test(text.slice(from, j - 1))) plain = false;
			i = j - 1;
		}
	}
	return { end: -1, plain };
}

/**
 * A guard line's code for telling an edit from a deletion: quoted strings, templates whose interpolations only read a
 * value, and a trailing `//` comment become blanks; everything else stays as written. A template that calls,
 * computes or nests another template holds code and is kept, so editing it is still a change of the guard. Braces
 * inside `${…}` are counted by depth, not by a regular expression.
 */
export function guardCode(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === '"' || ch === "'") {
			const end = quotedEnd(text, i);
			if (end >= 0) {
				out += '""';
				i = end;
				continue;
			}
		} else if (ch === "`") {
			const { end, plain } = templateEnd(text, i);
			if (end >= 0) {
				out += plain ? '""' : text.slice(i, end + 1);
				i = end;
				continue;
			}
		} else if (ch === "/" && text[i + 1] === "/") break;
		out += ch;
	}
	return out.trim();
}
