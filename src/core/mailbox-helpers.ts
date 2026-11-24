/** Argument keys whose value usually names what the tool is doing (`{"command": "git status"}` -> `command=git status`). */
const ARG_KEYS = /^(command|cmd|path|file_path|filePath|file|url|query|pattern|script|expr|name|title)$/;

/**
 * Status-line text for a `tool_execution_start` event: the tool name plus omp's `intent` (the call's own one-line
 * purpose, sent beside the args), else an `i` still in the args, else a short scalar-argument preview.
 */
export function toolActivityText(toolName: string, args: unknown, intent?: unknown): string {
	const stated =
		typeof intent === "string" && intent.trim() !== ""
			? intent
			: typeof args === "object" && args !== null && "i" in args && typeof args.i === "string"
				? args.i
				: "";
	if (stated.trim() !== "") return `${toolName} · ${stated.replace(/\s+/g, " ").trim()}`;
	if (typeof args === "string") {
		const flat = args.trim();
		return flat === "" ? toolName : `${toolName} ${flat}`;
	}
	if (typeof args !== "object" || args === null) return toolName;
	const scalar = Object.entries(args).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v));
	const named = scalar.filter(([k]) => ARG_KEYS.test(k));
	const picked = (named.length > 0 ? named : scalar).slice(0, 2);
	const preview = picked.map(([k, v]) => `${k}=${String(v)}`).join(" ");
	return preview === "" ? toolName : `${toolName} ${preview}`;
}

/** `/model-jabbu-pocket <arg>`: an exact `provider/id`, a 1-based index into `options`, or a substring matching exactly one. */
export function pickOption(options: readonly string[], arg: string): string | undefined {
	if (options.includes(arg)) return arg;
	if (/^\d+$/.test(arg)) return options[Number(arg) - 1];
	const needle = arg.toLowerCase();
	const matches = options.filter((option) => option.toLowerCase().includes(needle));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Key prefix for the last billed session-file entry (`<sessionFile>\t<entryId>`) in `slack_cursors`, so between-turn
 * `model_usage` records (such as idle compaction) are picked up once on the next charge.
 */
const CHARGED_CURSOR_PREFIX = "charged:";

export function chargedCursorKey(originKey: string): string {
	return `${CHARGED_CURSOR_PREFIX}${originKey}`;
}

export function parseChargedCursor(raw: string | undefined): { sessionFile: string; entryId: string } | undefined {
	if (raw === undefined) return undefined;
	const sep = raw.lastIndexOf("\t");
	if (sep <= 0 || sep === raw.length - 1) return undefined;
	return { sessionFile: raw.slice(0, sep), entryId: raw.slice(sep + 1) };
}

/**
 * The one line after `브리핑 이미지를 만들지 못했습니다:`: a busy render says why in its own message, anything else is
 * its own text cut to one line (a stack trace never reaches the thread).
 */
export function briefingReason(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const line =
		text
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part !== "") ?? "이유 없음";
	return line.slice(0, 300);
}
