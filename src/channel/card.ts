/** Platform-neutral ` ```card ` spec parser/validator and ASCII table/chart helpers (Discord embeds live in `src/discord/card.ts`). */
import { CardSpecError, standardComponentDefinitions, toCard } from "@json-render/chat";
import type { CardChild, CardElement } from "chat";
import { isRecord } from "../omp/type-guards";
import { graphIssues, reservedIds } from "./card-graph";
import { type FenceMark, fenceCloses, fenceOpen } from "./fence";
import { type ColumnAlign, displayWidth } from "./text";

export type { CardElement } from "chat";

type ChartChild = Extract<CardChild, { type: "chart" }>;

/** The standard json-render components without `Actions`/`Button`: a model-made button must not reach `onAction`. */
const { Actions: _actions, Button: _button, ...CARD_COMPONENTS } = standardComponentDefinitions;

export { CARD_COMPONENTS };

/** Per-card limits the spec is validated against (kept for every platform: 1 table, 2 charts). */
export const CARD_LIMITS = {
	tables: 1,
	charts: 2,
	tableRows: 100,
	chartLabel: 20,
	chartTitle: 50,
	chartPoints: 200,
} as const;

/** Card fences one answer turns into card parts at most; later ones stay text. */
export const MAX_CARDS = 3;

export type CardSegment =
	| { kind: "text"; text: string }
	| { kind: "card"; json: string; raw: string }
	| { kind: "copy"; text: string; raw: string };

/** Cuts `body` at ` ```card ` and ` ```copy ` fences (joining segments with "\n" preserves `body` byte for byte). */
export function splitCards(body: string): CardSegment[] {
	const lines = body.split("\n");
	const segments: CardSegment[] = [];
	let text: string[] = [];
	/** Open fence mark (undefined = none): only same char of at least `len` closes it. */
	let fence: FenceMark | undefined;
	let cards = 0;
	let noClose = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (fence !== undefined) {
			text.push(line);
			if (fenceCloses(line, fence)) fence = undefined;
			continue;
		}
		const opens = /^```(card|copy)\s*$/.exec(line)?.[1];
		if (!noClose && opens !== undefined && (opens === "copy" || cards < MAX_CARDS)) {
			let close = -1;
			for (let j = i + 1; j < lines.length; j++) {
				if (/^```\s*$/.test(lines[j] ?? "")) {
					close = j;
					break;
				}
			}
			if (close === -1) {
				noClose = true;
			} else {
				if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
				text = [];
				const inner = lines.slice(i + 1, close).join("\n");
				const raw = lines.slice(i, close + 1).join("\n");
				if (opens === "card") {
					segments.push({ kind: "card", json: inner, raw });
					cards += 1;
				} else {
					segments.push({ kind: "copy", text: inner, raw });
				}
				i = close;
				continue;
			}
		}
		fence = fenceOpen(line);
		text.push(line);
	}
	if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
	return segments;
}

export type CardRun<T> =
	| { kind: "text"; text: string }
	| { kind: "copy"; text: string }
	| ({ kind: "card"; raw: string } & T);

/** `body` as text runs and validated cards (`issues` collects `card <n>: <issue>` for refused cards; blank/long `copy` stays text). */
export function cardRuns<T extends object>(
	body: string,
	issues: string[],
	accept: (json: string, first: boolean) => T | readonly string[],
	copyLimit: number,
): CardRun<T>[] {
	const runs: CardRun<T>[] = [];
	let text: string[] = [];
	let n = 0;
	const flush = (): void => {
		const joined = text
			.join("\n")
			.replace(/^(?:[ \t]*\n)+/, "")
			.trimEnd();
		if (joined.trim() !== "") runs.push({ kind: "text", text: joined });
		text = [];
	};
	for (const segment of splitCards(body)) {
		if (segment.kind === "text") {
			text.push(segment.text);
			continue;
		}
		if (segment.kind === "copy") {
			const copy = segment.text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
			if (copy.trim() === "" || copy.length > copyLimit) {
				text.push(segment.raw);
				continue;
			}
			flush();
			runs.push({ kind: "copy", text: copy });
			continue;
		}
		n += 1;
		const card = accept(segment.json, runs.length === 0 && text.join("\n").trim() === "");
		if (Array.isArray(card)) {
			for (const issue of card.slice(0, 50)) issues.push(`card ${n}: ${issue}`);
			text.push(segment.raw);
			continue;
		}
		flush();
		runs.push({ kind: "card", raw: segment.raw, ...(card as T) });
	}
	flush();
	return runs;
}

/** A card's risk colour (root Card prop `tone`): Discord draws it as the embed's colour. */
export type CardTone = "ok" | "warn" | "danger" | "info";

/** The tone palette (hex); Discord takes the same value as an integer (`toneColorInt`). */
export const CARD_TONE_COLORS: Readonly<Record<CardTone, string>> = {
	ok: "#2EB67D",
	warn: "#ECB22E",
	danger: "#E01E5A",
	info: "#36C5F0",
};

/** A tone's colour as the integer a Discord embed's `color` takes. */
export const toneColorInt = (tone: CardTone): number => Number.parseInt(CARD_TONE_COLORS[tone].slice(1), 16);

export type ValidatedCard = { ok: true; card: CardElement; tone?: CardTone } | { ok: false; issues: string[] };

/**
 * The root Card's `tone` prop, taken out of the spec before `toCard` (whose `buildCard` copies only title, subtitle
 * and imageUrl). A value outside the palette is dropped without an issue: the card goes out without a colour.
 */
function takeTone(spec: Record<string, unknown>): CardTone | undefined {
	const elements = spec.elements;
	if (!isRecord(elements) || typeof spec.root !== "string" || !Object.hasOwn(elements, spec.root)) return undefined;
	const root = elements[spec.root];
	if (!isRecord(root) || !isRecord(root.props) || !Object.hasOwn(root.props, "tone")) return undefined;
	const tone = root.props.tone;
	delete root.props.tone;
	return typeof tone === "string" && Object.hasOwn(CARD_TONE_COLORS, tone) ? (tone as CardTone) : undefined;
}

/**
 * Light repair before validation: an element without `children` gets `[]`, without `props` `{}`; a spec without
 * `root` whose elements hold exactly one `Card` gets that key as root. Nothing else is touched.
 */
function repairSpec(spec: Record<string, unknown>): void {
	const elements = spec.elements;
	if (!isRecord(elements)) return;
	for (const element of Object.values(elements)) {
		if (!isRecord(element)) continue;
		element.children ??= [];
		element.props ??= {};
	}
	if (spec.root === undefined) {
		const cards = Object.entries(elements).filter(([, element]) => isRecord(element) && element.type === "Card");
		if (cards.length === 1) spec.root = cards[0]?.[0];
	}
}

/**
 * The first top-level JSON object of `json` when only stray closing brackets follow it (a model that wrote one `}`
 * too many); undefined otherwise. Brackets inside strings are skipped.
 */
function withoutStrayClosers(json: string): string | undefined {
	const start = json.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	for (let i = start; i < json.length; i++) {
		const ch = json[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				const rest = json.slice(i + 1);
				return /^[\s}\]]+$/.test(rest) ? json.slice(0, i + 1) : undefined;
			}
		}
	}
	return undefined;
}

/**
 * One issue per URL (the card's own image, every Image and every Link, sections searched too) that is not an
 * `http(s)` URL, which no platform may be handed.
 */
export function cardUrlIssues(card: CardElement): string[] {
	const issues: string[] = [];
	const check = (kind: "image" | "link", url: string): void => {
		if (!/^https?:\/\//i.test(url)) issues.push(`${kind} url "${url.slice(0, 60)}" must be an http(s) URL`);
	};
	const walk = (children: readonly CardChild[]): void => {
		for (const child of children) {
			if (child.type === "image" || child.type === "link") check(child.type, child.url);
			else if (child.type === "section") walk(child.children);
		}
	};
	if (card.imageUrl) check("image", card.imageUrl);
	walk(card.children);
	return issues;
}

/**
 * One issue per chart category given twice (sections searched too): every platform draws a chart's values by
 * category, so a repeated one would show the first value twice.
 */
function repeatedCategories(children: readonly CardChild[]): string[] {
	const issues: string[] = [];
	for (const child of children) {
		if (child.type === "section") issues.push(...repeatedCategories(child.children));
		if (child.type !== "chart" || child.chart.type === "pie") continue;
		const seen = new Set<string>();
		for (const category of child.chart.categories) {
			if (seen.has(category)) issues.push(`chart "${child.title}": category "${category}" is repeated`);
			seen.add(category);
		}
	}
	return issues;
}

/** A card fence's JSON as a validated card; never throws. Bad JSON and a `CardSpecError` come back as `issues`. */
export function validateCard(json: string): ValidatedCard {
	let spec: unknown;
	try {
		spec = JSON.parse(json);
	} catch (err) {
		const trimmed = withoutStrayClosers(json);
		try {
			if (trimmed === undefined) throw err;
			spec = JSON.parse(trimmed);
		} catch {
			return { ok: false, issues: [`JSON: ${err instanceof Error ? err.message : String(err)}`] };
		}
	}
	if (!isRecord(spec) || Array.isArray(spec))
		return { ok: false, issues: ["spec must be a JSON object with root and elements"] };
	repairSpec(spec);
	const reserved = reservedIds(spec);
	if (reserved.length > 0) return { ok: false, issues: reserved.map((id) => `element id "${id}" is reserved`) };
	const graph = graphIssues(spec);
	if (graph.length > 0) return { ok: false, issues: graph };
	const tone = takeTone(spec);
	try {
		// The spec's shape is checked by toCard itself (zod catalog and structure validation).
		const card = toCard(spec as unknown as Parameters<typeof toCard>[0], {
			components: CARD_COMPONENTS,
			limits: CARD_LIMITS,
		});
		const badUrls = cardUrlIssues(card);
		if (badUrls.length > 0) return { ok: false, issues: badUrls };
		const repeated = repeatedCategories(card.children);
		if (repeated.length > 0) return { ok: false, issues: repeated };
		return tone === undefined ? { ok: true, card } : { ok: true, card, tone };
	} catch (err) {
		// json-render measures titles and labels in UTF-16 units (an emoji counts 2) but calls them characters.
		if (err instanceof CardSpecError)
			return { ok: false, issues: err.issues.map((issue) => issue.replace(/ characters$/, " UTF-16 units")) };
		return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
	}
}

/**
 * A fixed-width table: columns padded to their widest cell by display width (Hangul = 2), ` | ` between them.
 * With `rule: true`, inserts a `---+---` rule row directly under the header row. `align` pads a column on the left
 * (right), both sides (center) or the right (left, the default); the alignment markers themselves are never printed.
 */
export function tableToAscii(
	table: { headers: readonly string[]; rows: ReadonlyArray<readonly string[]> },
	options?: { rule?: boolean; align?: readonly ColumnAlign[] | undefined },
): string {
	const rows = [table.headers, ...table.rows];
	// A loop, not `Math.max(...)`: a spread of a huge table's rows overflows the argument stack.
	const widths = table.headers.map((_, column) => {
		let widest = 0;
		for (const row of rows) widest = Math.max(widest, displayWidth(row[column] ?? ""));
		return widest;
	});
	const lines = rows.map((row) =>
		row
			.map((cell, column) => {
				const text = cell ?? "";
				const missing = Math.max(0, (widths[column] ?? 0) - displayWidth(text));
				const align = options?.align?.[column] ?? "left";
				// from dbc-hbin/omp-superagent (MIT): `pad` in src/discord-markdown.ts (center splits the gap, left half down)
				if (align === "right") return `${" ".repeat(missing)}${text}`;
				if (align === "center") {
					const left = Math.floor(missing / 2);
					return `${" ".repeat(left)}${text}${" ".repeat(missing - left)}`;
				}
				return `${text}${" ".repeat(missing)}`;
			})
			.join(" | ")
			.trimEnd(),
	);
	if (options?.rule) lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("-+-"));
	return lines.join("\n");
}

/** A chart as its title over an ASCII table of its values (pie: label/value; others: one column per series). */
export function chartToAscii(element: ChartChild): string {
	const { chart, title } = element;
	if (chart.type === "pie") {
		const table = tableToAscii({
			headers: ["Label", "Value"],
			rows: chart.segments.map((segment) => [segment.label, String(segment.value)]),
		});
		return `${title}\n${table}`;
	}
	const values = chart.series.map((s) => new Map(s.data.map((p) => [p.label, p.value] as const).reverse()));
	const table = tableToAscii({
		headers: [chart.xLabel ?? "", ...chart.series.map((s) => s.name)],
		rows: chart.categories.map((category) => [
			category,
			...values.map((byLabel) => {
				const value = byLabel.get(category);
				return value === undefined ? "" : String(value);
			}),
		]),
	});
	return `${title}\n${table}`;
}
