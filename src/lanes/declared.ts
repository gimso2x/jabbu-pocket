import { join } from "node:path";
import { readRegularFile } from "../tasks/host";
import type { LaneRow } from "./status";

/** How many plan files one task or lane brings in as declared text. */
const MAX_DECLARED_PLANS = 5;

/** The repository-relative `doc/plans/<name>.md` paths `text` names, first `MAX_DECLARED_PLANS`, each once. */
export function planPathsIn(text: string): string[] {
	const paths = new Set(text.match(/(?<![\w./-])doc\/plans\/[\w.-]+\.md(?![\w/-]|\.\w)/g) ?? []);
	return [...paths].slice(0, MAX_DECLARED_PLANS);
}

/**
 * What the lane was asked to do, for the integrity check: its brief and the `doc/plans/*.md` files the brief names,
 * read from the lane's worktree. The worker owns that tree, so a plan is read as a regular file only (a FIFO, a
 * device or a symlink the worker put there is not opened for content). A plan that cannot be read only declares less.
 * With `plansRoot` (the records repository) the plans are read from there, never from outside it.
 */
export async function laneDeclared(lane: LaneRow, plansRoot?: string): Promise<string> {
	const brief = lane.meta.brief ?? "";
	const root = plansRoot ?? lane.meta.worktree ?? lane.cwd;
	const plans = await Promise.all(
		planPathsIn(brief).map(async (path) => {
			try {
				return (await readRegularFile(join(root, path), root))?.toString("utf8") ?? "";
			} catch {
				return "";
			}
		}),
	);
	return [brief, ...plans].join("\n");
}

/** The prompt lines saying where the records repository holds each plan the brief names (read-only for the lane). */
export function planLocations(brief: string | undefined, recordsRepo: string | undefined): string {
	const plans = recordsRepo === undefined ? [] : planPathsIn(brief ?? "");
	if (recordsRepo === undefined || plans.length === 0) return "";
	return `\n\n스펙 위치:\n${plans.map((path) => `- ${path} → ${join(recordsRepo, path)} (읽기 전용)`).join("\n")}`;
}
