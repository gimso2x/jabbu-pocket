import { workflowLine } from "../lanes/workflow";
import { leadingWorkflow } from "../lanes/workflow-names";

const QUOTED_FENCE = /<<<quoted-([^>\n]*)>>>[\s\S]*?<<<end-quoted-\1>>>/g;

/**
 * Character ranges of a turn prompt's blocks that are fenced material: `<<<quoted-…>>>` fences (an unclosed one runs
 * to the end) and backtick fences (`composeTurnPrompt`'s block bodies: a line of three or more backticks opens one,
 * the same line closes it). A head-looking line inside is the material's own text, no block.
 */
export function fencedRanges(blocks: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const match of blocks.matchAll(QUOTED_FENCE)) ranges.push([match.index, match.index + match[0].length]);
	const lastClosed = ranges.at(-1)?.[1] ?? 0;
	const open = blocks.slice(lastClosed).search(/<<<quoted-[^>\n]*>>>/);
	if (open >= 0) ranges.push([lastClosed + open, blocks.length]);
	let from = 0;
	let fence = "";
	let start = 0;
	for (const line of blocks.split("\n")) {
		if (fence === "" && /^`{3,}$/.test(line)) {
			fence = line;
			start = from;
		} else if (fence !== "" && line === fence) {
			ranges.push([start, from + line.length]);
			fence = "";
		}
		from += line.length + 1;
	}
	if (fence !== "") ranges.push([start, blocks.length]);
	return ranges;
}

/** Whether `line` is the first line `composeTurnPrompt` lifts a leading SUPER call to (the name, then its default keyword). */
export function isLiftedCall(line: string): boolean {
	const call = leadingWorkflow(line);
	return call !== null && call.name !== "jevify" && (line === call.name || line === workflowLine(call.name, ""));
}
