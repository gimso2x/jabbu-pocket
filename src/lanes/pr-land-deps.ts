import { checkLeaks, findGitleaks } from "../release/leak-check";
import { defaultPrTools, type PrTools } from "./pr";
import type { PrLandDeps, PrLandSeams } from "./pr-land-steps";
import type { LanePrLand } from "./pr-land-types";
import { defaultGit } from "./verify";

/** What a caller of the PR landing supplies; everything else is the real git, gh, leak check and gitleaks (or a test seam). */
interface PrLandDepsInput {
	seams?: PrLandSeams | undefined;
	tools?: PrTools | undefined;
	signal: AbortSignal;
	removeWorktree: PrLandDeps["removeWorktree"];
	beforeCleanup?: PrLandDeps["beforeCleanup"];
	worktree?: PrLandDeps["worktree"];
	now(): number;
	save(prLand: LanePrLand): void;
}

/** The `PrLandDeps` of a lane's or a task's PR landing. */
export function prLandDeps(input: PrLandDepsInput): PrLandDeps {
	const seams = input.seams ?? {};
	return {
		git: seams.git ?? defaultGit,
		tools: input.tools ?? defaultPrTools,
		signal: input.signal,
		checkLeaks: seams.checkLeaks ?? checkLeaks,
		gitleaks: "gitleaks" in seams ? seams.gitleaks : findGitleaks(),
		removeWorktree: input.removeWorktree,
		now: input.now,
		save: input.save,
		...(input.beforeCleanup === undefined ? {} : { beforeCleanup: input.beforeCleanup }),
		...(input.worktree === undefined ? {} : { worktree: input.worktree }),
		...(seams.crash === undefined ? {} : { crash: seams.crash }),
	};
}
