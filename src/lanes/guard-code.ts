/** An interpolation that only reads a value: `a`, `a.b`, `a?.b`, `a[0]`, `a["k"]`. Calls, operators and nesting are code. */
const PLAIN_EXPRESSION = /^\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\s*(?:\d+|"[^"\\]*"|'[^'\\]*')\s*\])*\s*$/;

interface TemplateFrame {
	start: number;
	plain: boolean;
	exprFrom: number;
	depth: number;
}

/** Index of the quote that closes the plain string opened at `start`, or -1. */
function quotedEnd(text: string, start: number): number {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") i += 1;
		else if (text[i] === quote) return i;
	}
	return -1;
}

function failTemplates(stack: readonly TemplateFrame[], unclosed: Set<number>): { end: number; plain: boolean } {
	for (const frame of stack) unclosed.add(frame.start);
	return { end: -1, plain: false };
}

/**
 * The backtick template opened at `start`: the index of its closing backtick (-1 when it never closes on this line)
 * and whether every `${…}` in it, at any depth, is a plain read. Uses an explicit stack and memoizes unclosed starts
 * so deeply nested/broken interpolations scan linearly without stack overflow.
 */
function templateEnd(text: string, start: number, unclosed: Set<number>): { end: number; plain: boolean } {
	if (unclosed.has(start)) return { end: -1, plain: false };
	const stack: TemplateFrame[] = [{ start, plain: true, exprFrom: -1, depth: 0 }];
	for (let i = start + 1; i < text.length; i++) {
		const frame = stack[stack.length - 1];
		if (frame === undefined) break;
		const ch = text[i] as string;
		if (frame.depth === 0) {
			if (ch === "\\") {
				i += 1;
			} else if (ch === "`") {
				stack.pop();
				const outer = stack[stack.length - 1];
				if (outer === undefined) return { end: i, plain: frame.plain };
				outer.plain = false;
			} else if (ch === "$" && text[i + 1] === "{") {
				frame.exprFrom = i + 2;
				frame.depth = 1;
				i += 1;
			}
		} else if (ch === '"' || ch === "'") {
			const end = quotedEnd(text, i);
			if (end < 0) return failTemplates(stack, unclosed);
			i = end;
		} else if (ch === "`") {
			if (unclosed.has(i)) return failTemplates(stack, unclosed);
			stack.push({ start: i, plain: true, exprFrom: -1, depth: 0 });
		} else if (ch === "{") {
			frame.depth += 1;
		} else if (ch === "}") {
			frame.depth -= 1;
			if (frame.depth === 0 && !PLAIN_EXPRESSION.test(text.slice(frame.exprFrom, i))) frame.plain = false;
		}
	}
	return failTemplates(stack, unclosed);
}

/**
 * A guard line's code for telling an edit from a deletion: quoted strings, templates whose interpolations only read a
 * value, and a trailing `//` comment become blanks; everything else stays as written. A template that calls,
 * computes or nests another template holds code and is kept, so editing it is still a change of the guard. Braces
 * inside `${…}` are counted by depth, not by a regular expression.
 */
export function guardCode(text: string): string {
	let out = "";
	const unclosed = new Set<number>();
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
			const { end, plain } = templateEnd(text, i, unclosed);
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
