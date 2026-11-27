import type { BranchRule } from "../config";
import { TaskSpecError } from "./spec-error";

const BRANCH_MAX = 200;
/** What git's ref format forbids (space and control characters, `~ ^ : ? * [ \`) plus shell metacharacters and format controls. */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\s~^:?*[\]\\'"`$;&|<>(){}!#]/u;

/**
 * Why `branch` must not reach git or a remote shell, `undefined` when it may: `git check-ref-format --branch`'s rules
 * (Hangul and other letters pass) plus no leading `-`, no whitespace, control or shell metacharacter.
 */
export function branchProblem(branch: string): string | undefined {
	if (branch === "" || branch.length > BRANCH_MAX) return `브랜치 이름 길이가 1~${BRANCH_MAX}자가 아님`;
	if (branch.startsWith("-")) return "브랜치 이름이 -로 시작함";
	if (FORBIDDEN_CHARS.test(branch)) return "브랜치 이름에 공백·제어문자·셸 메타문자나 git이 거부하는 문자가 있음";
	if (branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch === "@")
		return "브랜치 이름에 .. // @{ 같은 git이 거부하는 꼴이 있음";
	if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith("."))
		return "브랜치 이름이 /로 시작하거나 /·.로 끝남";
	if (branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))
		return "브랜치 이름의 한 부분이 .로 시작하거나 .lock으로 끝남";
	return undefined;
}

export function assertBranchSafe(branch: string): void {
	const problem = branchProblem(branch);
	if (problem !== undefined) throw new Error(`unsafe branch: ${branch} (${problem})`);
}

/** `taskSpec.branch` as given: a non-empty string, trimmed; `undefined` when absent. */
export function parseBranchArg(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "")
		throw new TaskSpecError("taskSpec.branch는 비어 있지 않은 문자열이어야 합니다");
	return value.trim();
}

const stripSlashes = (path: string): string => path.replace(/\/+$/, "");
const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** The rule covering `repo`: the longest `repoPrefix` that contains it on a path boundary and does not `exclude` it. */
export function branchRuleFor(rules: readonly BranchRule[] | undefined, repo: string): BranchRule | undefined {
	const path = stripSlashes(repo);
	let best: BranchRule | undefined;
	for (const rule of rules ?? []) {
		const prefix = stripSlashes(rule.repoPrefix);
		if (!under(path, prefix) || (rule.exclude ?? []).some((skip) => under(path, stripSlashes(skip)))) continue;
		if (best === undefined || prefix.length > stripSlashes(best.repoPrefix).length) best = rule;
	}
	return best;
}

/**
 * The branch a new task gets: `branch` when given (and, under a rule, matching it), else `undefined` for the default
 * `task/<TASKID>`; throws the reason (with the rule's example) when the branch is refused.
 */
export function resolveTaskBranch(
	rules: readonly BranchRule[] | undefined,
	repo: string,
	branch: string | undefined,
): string | undefined {
	const rule = branchRuleFor(rules, repo);
	if (rule === undefined && branch === undefined) return undefined;
	if (rule !== undefined) {
		if (branch === undefined)
			throw new Error(`이 저장소는 브랜치 이름 규칙이 있어 taskSpec.branch가 필요합니다. 형식 예: ${rule.example}`);
		if (!new RegExp(rule.pattern).test(branch))
			throw new Error(`taskSpec.branch가 저장소 규칙에 맞지 않습니다: ${branch}. 형식 예: ${rule.example}`);
	}
	const problem = branch === undefined ? undefined : branchProblem(branch);
	if (problem !== undefined) throw new Error(`taskSpec.branch를 쓸 수 없습니다: ${branch} (${problem})`);
	return branch;
}
