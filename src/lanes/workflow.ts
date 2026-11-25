import { LaneInputError } from "./manager-constants";
import { leadingWorkflow, WORKFLOW_NAMES, type WorkflowName, workflowNamed } from "./workflow-names";

// Ported from omp-superagent src/workflow.ts (c11a6e4), checked against omp-superkit super.ts: only the six SUPER
// workflows (their ULW spellings as legacy aliases) and native jevify are recognised, never arbitrary mentions or skill
// prose in a brief. A lane prompt needs only the first line, so the runtime-context fence of that file is not carried over.

/** The head's pick (`jabbu_work_start` `workflow`): the name goes on the prompt's first line, the reason is shown. */
export interface WorkflowChoice {
	name: WorkflowName;
	reason: string;
}

const nativeWords =
	/(?<![\p{L}\p{N}_./\\-])(?<!::)(?:ultrathink|orchestrate|workflowz|jevify)(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;
/** The omp keyword each workflow adds after its name (`jevify` and plain `super` add none). */
const nativeWord: Partial<Record<WorkflowName, string>> = {
	"super-plan": "ultrathink",
	"super-loop": "orchestrate",
	"super-run": "orchestrate",
	"super-graph": "workflowz",
	"super-research": "workflowz",
};

/**
 * `jabbu_work_start` `workflow` as the tool received it; `undefined` = none chosen. A legacy ULW name (a reservation
 * frozen before the SUPER rename) is read as its SUPER workflow.
 */
export function workflowChoice(value: unknown): WorkflowChoice | undefined {
	if (value === undefined) return undefined;
	const refused = () =>
		new LaneInputError(`workflow에는 이름(${WORKFLOW_NAMES.join("·")})과 비어 있지 않은 reason이 필요합니다.`);
	if (value === null || typeof value !== "object") throw refused();
	const choice = value as Record<string, unknown>;
	const { reason } = choice;
	const name = typeof choice.name === "string" ? workflowNamed(choice.name) : undefined;
	if (
		name === undefined ||
		typeof reason !== "string" ||
		reason.trim() === "" ||
		Object.keys(choice).some((key) => key !== "name" && key !== "reason")
	) {
		throw refused();
	}
	return { name, reason };
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

/** The workflow's SUPER command (`jevify` is omp's own notice, not a command). */
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
 * The description is not compared: its wording is not a contract.
 */
export function advertisedWorkflow(
	commands: ReadonlyArray<{ name?: string; source?: string; description?: string }>,
	name: WorkflowName,
): boolean {
	return commands.some((command) => command.name === name && command.source === "extension");
}
