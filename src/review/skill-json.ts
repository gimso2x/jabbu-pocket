// JSON candidate scanning for skill proposals: kept apart so `skills.ts` stays under its LOC baseline.

const MAX_START_ATTEMPTS = 64;

/** End index (inclusive) of the bracket group opening at `start`, string-literal aware; -1 when unbalanced. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i += 1;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "[" || ch === "{") depth += 1;
		else if (ch === "]" || ch === "}") {
			depth -= 1;
			if (depth <= 0) return depth === 0 ? i : -1;
		}
	}
	return -1;
}

/**
 * Each JSON array of objects / object in `text` that parses, in order. Each "[" or "{" is tried as a start (the
 * attempt budget is shared across candidates), its balanced end is parsed; prose brackets like "[결과]" or "[1]"
 * simply fail or carry no objects and are skipped. A yielded candidate is skipped past, so a `{"proposals":[...]}`
 * wrapper never leaks its inner array as a second candidate.
 */
export function* jsonListCandidates(text: string): Generator<unknown[]> {
	let attempts = 0;
	for (let i = 0; i < text.length && attempts < MAX_START_ATTEMPTS; i++) {
		if (text[i] !== "[" && text[i] !== "{") continue;
		attempts += 1;
		const end = balancedEnd(text, i);
		if (end < 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(i, end + 1));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) {
			yield [parsed];
			i = end;
			continue;
		}
		if (parsed.length === 0 || parsed.some((entry) => typeof entry === "object" && entry !== null)) {
			yield parsed;
			i = end;
		}
	}
}
