import { workflowLine } from "../lanes/workflow";
import { leadingWorkflow } from "../lanes/workflow-names";
import { INJECTION_WARNING_HEAD } from "../safety/injection";

/**
 * The backtick fence for a text: longer than any backtick run inside (at least three), so the text cannot close it.
 * omp's magic keywords and omp-superkit's SUPER calls skip fenced text, so a keyword quoted in it switches no mode on.
 */
export function fenceFor(body: string): string {
	const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

/** `body` between its own fences, one per line. */
export function fenced(body: string): string {
	const fence = fenceFor(body);
	return `${fence}\n${body}\n${fence}`;
}

/**
 * A context block with everything after its head line (and the injection warning line in front of it) fenced. The head
 * lines stay outside, where the trace view (`splitTurnPrompt`) finds them. A one-line block stays as it is.
 */
function fencedBlock(block: string): string {
	const lines = block.split("\n");
	const headLines = lines[0]?.startsWith(INJECTION_WARNING_HEAD) ? 2 : 1;
	const body = lines.slice(headLines).join("\n");
	return body.trim() === "" ? block : `${lines.slice(0, headLines).join("\n")}\n${fenced(body)}`;
}

/**
 * The blocks of a new turn's prompt with fenced bodies, behind the first line a request that opens with a SUPER call
 * earns: omp-superkit reads a call only at the very start of the prompt, which the blocks would push down. The line is
 * the call's name without the slash (omp runs `/…` texts as commands) and the workflow's default keyword, which
 * superkit would withhold when a keyword sits anywhere in the text, a fenced one included. `lift` off (a steer) keeps
 * the fences only.
 */
export function guardedBlocks(blocks: readonly string[], text: string, lift: boolean): string {
	const call = lift ? leadingWorkflow(text) : null;
	const first = call === null || call.name === "jevify" ? "" : `${workflowLine(call.name, text)}\n\n`;
	return `${first}${blocks.map(fencedBlock).join("\n\n")}`;
}
