/**
 * `omp: current (/path/to/extension)` → `omp: current`: drops a trailing `(/…)` or `(~…)` group. Linear in the line
 * length (a regex with `\s*` around the group backtracks quadratically on a long run of spaces; qa-z #63).
 */
export function stripExtensionPath(line: string): string {
	const text = line.trimEnd();
	if (!text.endsWith(")")) return text;
	const open = text.lastIndexOf("(");
	const inner = text.slice(open + 1, -1);
	if (open < 0 || !(inner.startsWith("/") || inner.startsWith("~")) || inner.includes(")")) return text;
	return text.slice(0, open).trimEnd();
}

/** Newline-separated lines joined by single spaces, each trimmed; linear (the `\s*\n\s*` regex is quadratic on a long space run). */
export function joinLines(text: string): string {
	return text
		.split("\n")
		.map((part) => part.trim())
		.join(" ");
}
