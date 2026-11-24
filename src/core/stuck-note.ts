// The identical-output note omp appends to repeated tool results (see `toolFingerprint` in `stuck.ts`).

/**
 * omp 18.11+ appends a counter to the third identical read ("[You have received this identical output N times...]").
 * N changes every time, so it is stripped before hashing or a true repeat never matches.
 */
const OMP_REPEAT_MARK = "[You have received this identical output";
const OMP_REPEAT_COUNT = /^ \d+ times/;

/**
 * Linear: a regex with a leading `\n*` and a trailing `[\s\S]*` is quadratic on long input without the mark, and so was
 * scanning to the line end from every mark (qa-aa #41). omp appends the note on a line of its own at the very end, so
 * only the last line of the trimmed text can hold it: a mark mid-line or followed by more lines is result text.
 */
export function stripOmpRepeatNote(text: string): string {
	const body = text.trimEnd();
	if (!body.endsWith("]")) return text;
	const at = body.lastIndexOf("\n") + 1;
	if (!body.startsWith(OMP_REPEAT_MARK, at)) return text;
	const afterMark = at + OMP_REPEAT_MARK.length;
	const count = OMP_REPEAT_COUNT.exec(body.slice(afterMark, afterMark + 24));
	if (count === null || afterMark + count[0].length > body.length - 1) return text;
	let start = at;
	while (start > 0 && text[start - 1] === "\n") start -= 1;
	return text.slice(0, start);
}
