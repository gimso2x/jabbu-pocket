// Converts GFM Markdown tables for Discord mobile into stacked Markdown records instead of wide monospace blocks.
import { type FenceMark, fenceCloses, fenceOpen } from "../channel/fence";
import { splitRowCells, tableEndAt } from "../channel/text";
import { clampBacktickRuns } from "./code-spans";

/** Bounded inline-span regex (matches `format.ts`/legacy table cell stripper in linear time on hostile input). */
const HEADER_INLINE =
	/(?<!`)(`+)(?!`)(.{1,128}?)(?<!`)\1(?!`)|\[([^[\]]{1,256})\]\((?:[^()\n]|\([^()\n]{0,512}\)){0,1024}\)|\*\*(?=\S)(.{1,128}?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.{1,128}?)(?<=\S)__(?!\w)/g;

/** Strips inline code, links, and bold markers from a header cell before wrapping it in `**header**`. */
export function stripTableHeaderMarkdown(header: string): string {
	const stripped = header
		.replace(
			HEADER_INLINE,
			(match, _ticks, code?: string, linkLabel?: string, boldStar?: string, boldUnder?: string) => {
				const inner = linkLabel ?? boldStar ?? boldUnder;
				if (code !== undefined) return code;
				return inner === undefined ? match : stripTableHeaderMarkdown(inner);
			},
		)
		.replace(/[\r\n]+/g, " ")
		.trim();
	return clampBacktickRuns(stripped, 3);
}

/** Normalizes newlines and breaks up 3+ backtick runs inside stacked cells while keeping inline Discord markdown. */
export function sanitizeStackedCell(cell: string): string {
	const collapsed = cell.replace(/[\r\n]+/g, " ").trim();
	return clampBacktickRuns(collapsed, 3);
}

/** Formats parsed GFM table headers and rows into mobile-readable stacked Markdown blocks. */
export function formatStackedTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const cleanHeaders = headers.map(stripTableHeaderMarkdown);
	const rowBlocks: string[] = [];

	for (const rawRow of rows) {
		const cells = cleanHeaders.map((_, col) => sanitizeStackedCell(rawRow[col] ?? ""));
		if (cells.every((cell) => cell === "")) continue;
		const lines: string[] = [];
		const firstCell = cells[0] ?? "";
		const firstHeader = cleanHeaders[0] ?? "";
		if (firstCell !== "") {
			lines.push(firstHeader === "" ? firstCell : `**${firstHeader}**: ${firstCell}`);
		}
		for (let col = 1; col < cleanHeaders.length; col++) {
			const cell = cells[col] ?? "";
			if (cell === "") continue;
			const header = cleanHeaders[col] ?? "";
			lines.push(header === "" ? `- ${cell}` : `- ${header}: ${cell}`);
		}
		if (lines.length > 0) rowBlocks.push(lines.join("\n"));
	}

	if (rowBlocks.length === 0) {
		return cleanHeaders
			.filter((header) => header !== "")
			.map((header) => `**${header}**`)
			.join(" · ");
	}
	return rowBlocks.join("\n\n");
}

/** Converts GFM tables outside code fences into stacked Markdown blocks and tracks each converted `[start, end]` span. */
export function renderStackedTables(text: string): { text: string; spans: Array<[number, number]> } {
	const lines = text.split("\n");
	const out: string[] = [];
	const spans: Array<[number, number]> = [];
	let offset = 0;
	let fence: FenceMark | undefined;
	const push = (line: string): void => {
		out.push(line);
		offset += line.length + 1;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (fence === undefined) fence = fenceOpen(line);
		else if (fenceCloses(line, fence)) fence = undefined;
		const end = fence !== undefined ? undefined : tableEndAt(lines, i, 3);
		if (end === undefined) {
			push(line);
			continue;
		}
		const headers = splitRowCells(line);
		const rows = lines.slice(i + 2, end).map((row) => splitRowCells(row));
		const stacked = formatStackedTable(headers, rows);
		const start = offset;
		for (const outLine of stacked.split("\n")) push(outLine);
		spans.push([start, offset - 1]);
		i = end - 1;
	}
	return { text: out.join("\n"), spans };
}
