import { redact } from "../redact";

const REGEX_WORKER_CODE = `self.onmessage = (e) => {
	try {
		const { source, flags, input } = e.data;
		self.postMessage({ ok: true, matched: new RegExp(source, flags).test(input) });
	} catch {
		self.postMessage({ ok: false });
	}
};`;

/** True when `value` is or recursively contains a non-finite number (`Infinity`, `-Infinity`, `NaN`). */
export function hasNonFiniteNumber(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value);
	if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).some(hasNonFiniteNumber);
	}
	return false;
}

/** Deep JSON value equality independent of object key order; non-finite numbers never match `null`. */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const listB = b as unknown[];
		return a.length === listB.length && a.every((item, index) => jsonDeepEqual(item, listB[index]));
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	const recA = a as Record<string, unknown>;
	const recB = b as Record<string, unknown>;
	return keysA.every((key) => Object.hasOwn(recB, key) && jsonDeepEqual(recA[key], recB[key]));
}

/** Stringifies a JSON value for failure details without collapsing non-finite numbers to `null`. */
export function jsonDetailText(value: unknown): string {
	return (
		JSON.stringify(value, (_key, entry: unknown) =>
			typeof entry === "number" && !Number.isFinite(entry) ? String(entry) : entry,
		) ?? "undefined"
	);
}

/** Looks up `path` in a parsed JSON value using own properties only (`__proto__`/`constructor` never match). */
export function digJsonPath(value: unknown, path: readonly (string | number)[]): { found: boolean; value: unknown } {
	let current = value;
	for (const key of path) {
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
			return { found: false, value: undefined };
		}
		current = (current as Record<string | number, unknown>)[key];
	}
	return { found: true, value: current };
}

/** The last characters of an output on one line, masked before clipping so secrets never leak into check_json. */
export const signalTail = (text: string): string => {
	const line = redact(text).replace(/\s+/g, " ").trim();
	return line.length > 80 ? `…${line.slice(-80)}` : line;
};

/** Checks `json:` expectation against `bytes`; returns the Korean mismatch reason or `undefined` when it matches. */
export function verifyJsonField(
	bytes: Uint8Array,
	pathName: string,
	fieldPath: readonly (string | number)[],
	expected: unknown,
): string | undefined {
	let document: unknown;
	try {
		document = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return `JSON이 아닙니다: ${pathName}`;
	}
	const field = `.${fieldPath.join(".")}`;
	const hit = digJsonPath(document, fieldPath);
	if (!hit.found) return `${field} 필드가 없습니다`;
	if (!jsonDeepEqual(hit.value, expected)) {
		return `${field}가 ${signalTail(jsonDetailText(hit.value))}입니다(기대 ${signalTail(jsonDetailText(expected))})`;
	}
	return undefined;
}

/**
 * Evaluates `new RegExp(pattern.source, pattern.flags).test(input)` on a background Bun Worker thread so catastrophic
 * backtracking never stalls the daemon event loop; terminates the worker after `timeoutMs`.
 */
export function testRegexBounded(
	pattern: RegExp,
	input: string,
	timeoutMs = 250,
): Promise<"match" | "no_match" | "timeout"> {
	const url = URL.createObjectURL(new Blob([REGEX_WORKER_CODE], { type: "application/javascript" }));
	return new Promise((resolve) => {
		let settled = false;
		let worker: Worker | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: "match" | "no_match" | "timeout"): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			try {
				worker?.terminate();
			} catch {
				// worker already closed
			}
			URL.revokeObjectURL(url);
			resolve(outcome);
		};
		try {
			worker = new Worker(url);
			timer = setTimeout(() => finish("timeout"), timeoutMs);
			worker.onmessage = (event: MessageEvent<{ ok?: boolean; matched?: boolean }>) => {
				if (event.data?.ok !== true) {
					finish("timeout");
					return;
				}
				finish(event.data.matched ? "match" : "no_match");
			};
			worker.onerror = () => finish("timeout");
			worker.onmessageerror = () => finish("timeout");
			worker.postMessage({ source: pattern.source, flags: pattern.flags, input });
		} catch {
			finish("timeout");
		}
	});
}
