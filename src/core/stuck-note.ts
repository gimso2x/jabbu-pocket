// The identical-output note omp appends to repeated tool results (see `toolFingerprint` in `stuck.ts`).

/**
 * omp 18.11+ appends a counter to the third identical read ("[You have received this identical output N times...]").
 * N changes every time, so it is stripped before hashing or a true repeat never matches.
 */
const OMP_REPEAT_MARK = "[You have received this identical output";
const OMP_REPEAT_COUNT = /^ \d+ times/;

/** Linear: a regex with a leading `\n*` and a trailing `[\s\S]*` is quadratic on long input without the mark. */
export function stripOmpRepeatNote(text: string): string {
	const body = text.trimEnd();
	if (!body.endsWith("]")) return text;
	let at = text.indexOf(OMP_REPEAT_MARK);
	while (at !== -1) {
		const afterMark = at + OMP_REPEAT_MARK.length;
		const count = OMP_REPEAT_COUNT.exec(text.slice(afterMark, afterMark + 24));
		// omp appends the note on lines of its own at the very end: a mark mid-line or followed by more lines is result text.
		const onOwnLine = at === 0 || text[at - 1] === "\n";
		const lineEnd = text.indexOf("\n", at);
		if (
			count !== null &&
			onOwnLine &&
			afterMark + count[0].length <= body.length - 1 &&
			(lineEnd === -1 || lineEnd >= body.length)
		) {
			let start = at;
			while (start > 0 && text[start - 1] === "\n") start -= 1;
			return text.slice(0, start);
		}
		at = text.indexOf(OMP_REPEAT_MARK, at + 1);
	}
	return text;
}
