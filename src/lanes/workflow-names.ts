// The SUPER workflow names omp-superkit registers as commands, their legacy ULW spellings, and the read of a text's
// leading call. Ported from omp-superagent src/workflow.ts (c11a6e4), checked against omp-superkit super.ts.

export const WORKFLOW_NAMES = [
	"jevify",
	"super",
	"super-graph",
	"super-plan",
	"super-loop",
	"super-run",
	"super-research",
] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

/** The pre-SUPER name of each workflow; omp-superkit still registers these as legacy alias commands. */
const LEGACY_NAMES: Record<Exclude<WorkflowName, "jevify">, string> = {
	super: "ulw",
	"super-graph": "mass-ulw",
	"super-plan": "ulw-plan",
	"super-loop": "ulw-loop",
	"super-run": "ulw-execute",
	"super-research": "ulw-research",
};

const canonical = new RegExp(
	String.raw`^(${Object.keys(LEGACY_NAMES).join("|")})\b(?![-_.]?[A-Za-z0-9])(?=[\s:.,!?]|$)`,
	"i",
);
const aliases: Array<[WorkflowName, RegExp]> = [
	["super-research", /^(?:ulw|mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)[\s-]*research\b/i],
	["super-graph", /^(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)\b/i],
	["super-plan", /^ulw[\s-]*plan\b/i],
	["super-loop", /^ulw[\s-]*loop\b/i],
	["super-run", /^ulw[\s-]*execute\b/i],
];
const identifierTail = /^(?:[-_][A-Za-z0-9]|\.[A-Za-z0-9]|[-_.]?[A-Za-z0-9]*[/\\])/;
const leadingUri = /^\s*\/?[a-z][a-z0-9+.-]*:\/\//i;

/** The canonical workflow a name stands for, the legacy ULW spelling included; undefined = no workflow name. */
export function workflowNamed(name: string): WorkflowName | undefined {
	if ((WORKFLOW_NAMES as readonly string[]).includes(name)) return name as WorkflowName;
	return (Object.keys(LEGACY_NAMES) as Array<keyof typeof LEGACY_NAMES>).find((key) => LEGACY_NAMES[key] === name);
}

/** The workflow a text starts with and how many characters its call (name and slash prefix) takes. */
export function leadingWorkflow(text: string): { name: WorkflowName; length: number } | null {
	// Unlike the SUPER commands, native jevify is lowercase prose, never a slash command.
	const native = /^\s*jevify(?=$|[\s:.,!?])/.exec(text);
	if (native && !identifierTail.test(text.slice(native[0].length))) return { name: "jevify", length: native[0].length };
	// omp-superkit masks URLs before reading its selectors: `/super://x` is no call.
	if (leadingUri.test(text)) return null;
	const prefix = /^\s*\/?/.exec(text)?.[0].length ?? 0;
	const leading = text.slice(prefix);
	const primary = canonical.exec(leading);
	if (primary) return { name: primary[0].toLowerCase() as WorkflowName, length: prefix + primary[0].length };
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
	return { name: "super", length: prefix + plain[0].length };
}
