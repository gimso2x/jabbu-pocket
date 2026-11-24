import { LaneInputError } from "./manager-constants";

// Ported from omp-superagent src/workflow.ts (fdeeb6a), checked against omp-ulw/ulw.ts: only the six ULW workflows
// and native jevify are recognised, never arbitrary mentions or skill prose in a brief. A lane prompt needs only the
// first line, so the runtime-context fence of that file is not carried over.

export const WORKFLOW_NAMES = [
	"jevify",
	"ulw",
	"mass-ulw",
	"ulw-plan",
	"ulw-loop",
	"ulw-execute",
	"ulw-research",
] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

/** The head's pick (`ompbot_work_start` `workflow`): the name goes on the prompt's first line, the reason is shown. */
export interface WorkflowChoice {
	name: WorkflowName;
	reason: string;
}

const aliases: Array<[WorkflowName, RegExp]> = [
	["ulw-research", /^(?:ulw|mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)[\s-]*research\b/i],
	["mass-ulw", /^(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i],
	["ulw-plan", /^ulw[\s-]*plan\b/i],
	["ulw-loop", /^ulw[\s-]*loop\b/i],
	["ulw-execute", /^ulw[\s-]*execute\b/i],
];
const identifierTail = /^(?:[-_][A-Za-z0-9]|\.[A-Za-z0-9]|[-_.]?[A-Za-z0-9]*[/\\])/;
const nativeWords =
	/(?<![\p{L}\p{N}_./\\-])(?<!::)(?:ultrathink|orchestrate|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;
/** The omp keyword each workflow adds after its name (`jevify` and plain `ulw` add none). */
const nativeWord: Partial<Record<WorkflowName, string>> = {
	"ulw-plan": "ultrathink",
	"ulw-loop": "orchestrate",
	"ulw-execute": "orchestrate",
	"mass-ulw": "workflowz",
	"ulw-research": "workflowz",
};

/** The workflow a text starts with and how many characters its call (name and slash prefix) takes. */
export function leadingWorkflow(text: string): { name: WorkflowName; length: number } | null {
	// Unlike the ULW commands, native jevify is lowercase prose, never a slash command.
	const native = /^\s*jevify(?=$|[\s:.,!?])/.exec(text);
	if (native && !identifierTail.test(text.slice(native[0].length))) return { name: "jevify", length: native[0].length };
	const prefix = /^\s*\/?/.exec(text)?.[0].length ?? 0;
	const leading = text.slice(prefix);
	for (const [name, expression] of aliases) {
		const match = expression.exec(leading);
		if (
			match &&
			/^(?:[\s:.,!?]|$)/.test(leading.slice(match[0].length)) &&
			!identifierTail.test(leading.slice(match[0].length))
		) {
			return { name, length: prefix + match[0].length };
		}
	}
	const plain = /^(?:ultrawork|ulw)\b/i.exec(leading);
	if (!plain) return null;
	const tail = leading.slice(plain[0].length);
	if (/^[-_.]?[A-Za-z0-9]*[/\\]/.test(tail)) return null;
	// Native ULW permits a suffix only for its named workflow family; other identifiers and paths are data.
	if (identifierTail.test(tail) && !/^[-_](?:loop|plan|research|execute|mass)(?![-_.]?[A-Za-z0-9])/i.test(tail)) {
		return null;
	}
	return { name: "ulw", length: prefix + plain[0].length };
}

/** `ompbot_work_start` `workflow` as the tool received it; `undefined` = none chosen. */
export function workflowChoice(value: unknown): WorkflowChoice | undefined {
	if (value === undefined) return undefined;
	const refused = () =>
		new LaneInputError(`workflow에는 이름(${WORKFLOW_NAMES.join("·")})과 비어 있지 않은 reason이 필요합니다.`);
	if (value === null || typeof value !== "object") throw refused();
	const choice = value as Record<string, unknown>;
	const { name, reason } = choice;
	if (
		typeof name !== "string" ||
		!(WORKFLOW_NAMES as readonly string[]).includes(name) ||
		typeof reason !== "string" ||
		reason.trim() === "" ||
		Object.keys(choice).some((key) => key !== "name" && key !== "reason")
	) {
		throw refused();
	}
	return { name: name as WorkflowName, reason };
}

/** What the owner's own `작업:` brief starts with: its workflow call is cut from the brief, the rest is the brief. */
export function triggerWorkflow(brief: string): { choice: WorkflowChoice; brief: string } | undefined {
	const call = leadingWorkflow(brief);
	if (call === null) return undefined;
	let rest = brief.slice(call.length);
	const keyword = nativeWord[call.name];
	// Its own default keyword goes back on the first line; any other keyword the owner wrote stays in the brief.
	if (keyword !== undefined) rest = rest.replace(new RegExp(`^[ \\t]+${keyword}(?![\\p{L}\\p{N}_-])`, "u"), "");
	return { choice: { name: call.name, reason: "오너 직접 호출" }, brief: rest.trim() };
}

/** The workflow's ULW command (`jevify` is omp's own notice, not a command). */
export const isUlwWorkflow = (name: WorkflowName): boolean => name !== "jevify";

/**
 * First line of a lane prompt: the workflow name, then omp's default keyword for it unless the brief already carries
 * a native keyword of its own. `undefined` = no workflow chosen, no line.
 */
export function workflowLine(name: WorkflowName | undefined, brief: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	const keyword = nativeWord[name];
	return keyword === undefined || nativeWords.test(brief ?? "") ? name : `${name} ${keyword}`;
}

/**
 * Whether omp's `get_available_commands` lists the workflow's extension command (exact name, `source` extension).
 * The description is not compared: omp-ulw's SUPER rebrand (c11a6e4) keeps these names only as legacy aliases
 * ("Legacy alias for /super-plan"), and its wording is not a contract.
 */
export function advertisedWorkflow(
	commands: ReadonlyArray<{ name?: string; source?: string; description?: string }>,
	name: WorkflowName,
): boolean {
	return commands.some((command) => command.name === name && command.source === "extension");
}
