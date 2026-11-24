import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findToolCallResult } from "../omp/session-tail";
import type { LaneFileEvidence, LaneProgressEvidence } from "./status";

export type ProgressEvidenceResult = { ok: true; value: LaneProgressEvidence } | { ok: false; reason: string };

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

const hashFile = (path: string): Promise<string> =>
	new Promise<string>((done, fail) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", fail)
			.on("end", () => done(hash.digest("hex")));
	});

/**
 * The evidence of a `jabbu_lane_progress` report: exactly one of `{ file }` or `{ toolCallId }`.
 * - `{ file }`: a regular file inside the lane's worktree. A symbolic link (the file itself or a directory on its way)
 *   and a path outside the worktree are refused. The core hashes the file, so the report names content that existed
 *   when it was made.
 * - `{ toolCallId }`: a tool call the lane session finished without error (`sessionFile`, the session's jsonl). The
 *   reporting and board tools (`jabbu_*`) cannot vouch for themselves. The core hashes the call's result text.
 */
export async function verifyProgressEvidence(
	worktree: string,
	evidence: unknown,
	sessionFile?: string,
): Promise<ProgressEvidenceResult> {
	const given = typeof evidence === "object" && evidence !== null ? (evidence as Record<string, unknown>) : {};
	const toolCallId = given.toolCallId;
	if (toolCallId !== undefined) {
		if (given.file !== undefined) return { ok: false, reason: "evidence takes either file or toolCallId, not both" };
		return verifyToolCall(toolCallId, sessionFile);
	}
	const file = given.file;
	if (typeof file !== "string" || file.trim() === "") {
		return { ok: false, reason: "evidence.file (a file in the lane worktree) or evidence.toolCallId is required" };
	}
	try {
		const root = await realpath(worktree);
		const path = isAbsolute(file) ? file : resolve(root, file);
		const inside = (target: string): boolean => {
			const rel = relative(root, target);
			return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		};
		if (!inside(path)) return { ok: false, reason: `evidence.file is outside the lane worktree: ${file}` };
		const info = await lstat(path);
		if (info.isSymbolicLink()) return { ok: false, reason: `evidence.file is a symbolic link: ${file}` };
		if (!info.isFile()) return { ok: false, reason: `evidence.file is not a regular file: ${file}` };
		// A directory on the way may itself be a link out of the worktree.
		if (!inside(await realpath(path)))
			return { ok: false, reason: `evidence.file is outside the lane worktree: ${file}` };
		const sha256 = await hashFile(path);
		return { ok: true, value: { file: relative(root, path), sha256 } };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			ok: false,
			reason:
				code === "ENOENT"
					? `evidence.file does not exist: ${file}`
					: `evidence.file could not be read: ${code ?? "error"}`,
		};
	}
}

async function verifyToolCall(toolCallId: unknown, sessionFile: string | undefined): Promise<ProgressEvidenceResult> {
	if (typeof toolCallId !== "string" || toolCallId.trim() === "") {
		return { ok: false, reason: "evidence.toolCallId must be a non-empty string" };
	}
	if (sessionFile === undefined)
		return { ok: false, reason: "the lane has no session file to check evidence.toolCallId in" };
	let found: ReturnType<typeof findToolCallResult>;
	try {
		found = findToolCallResult(sessionFile, toolCallId);
	} catch (error) {
		return {
			ok: false,
			reason: `the lane session could not be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
		};
	}
	if (found === undefined) return { ok: false, reason: `no finished tool call ${toolCallId} in the lane session` };
	if (found.isError) return { ok: false, reason: `tool call ${toolCallId} (${found.tool}) failed` };
	if (found.tool.startsWith("jabbu_")) {
		return { ok: false, reason: `tool call ${toolCallId} is ${found.tool}: jabbu tools cannot be evidence` };
	}
	return { ok: true, value: { toolCallId, tool: found.tool, sha256: sha256Of(found.text) } };
}

/** How evidence reads on a card or the status message: `파일 a.txt(보존됨)` / `도구 호출 bash`. */
export const evidenceLabel = (evidence: LaneProgressEvidence): string =>
	"file" in evidence
		? `파일 ${evidence.file}${evidence.preserved === true ? "(보존됨)" : ""}`
		: `도구 호출 ${evidence.tool}`;

/** A file evidence that could not be kept: `artifact_drift` (the file changed or is gone) or `artifact_copy_failed`. */
export interface ArtifactProblem {
	event: "artifact_drift" | "artifact_copy_failed";
	detail: string;
}

/**
 * Copies the lane's file evidence from its worktree to `<artifactsDir>/<sha256>` just before the worktree goes. A file
 * that no longer has the recorded hash (or is no longer a plain file in the worktree) is not copied (`artifact_drift`);
 * a copy that fails or reads back with another hash is dropped (`artifact_copy_failed`). Never throws: the caller
 * removes the worktree whatever came out. `evidence` returns with `preserved` set on the files that were kept.
 */
export async function preserveFileEvidence(
	worktree: string,
	artifactsDir: string,
	evidence: readonly LaneProgressEvidence[],
): Promise<{ evidence: LaneProgressEvidence[]; problems: ArtifactProblem[] }> {
	const problems: ArtifactProblem[] = [];
	const kept: LaneProgressEvidence[] = [];
	for (const entry of evidence) {
		if (!("file" in entry)) {
			kept.push(entry);
			continue;
		}
		const current = await verifyProgressEvidence(worktree, { file: entry.file });
		if (!current.ok || !("file" in current.value) || current.value.sha256 !== entry.sha256) {
			problems.push({
				event: "artifact_drift",
				detail: `${entry.file}: ${current.ok ? "content changed since it was reported" : current.reason}`,
			});
			kept.push(entry);
			continue;
		}
		const target = join(artifactsDir, entry.sha256);
		const temp = `${target}.tmp`;
		try {
			await mkdir(artifactsDir, { recursive: true });
			await copyFile(resolve(worktree, entry.file), temp);
			if ((await hashFile(temp)) !== entry.sha256) throw new Error("hash differs after the copy");
			await rename(temp, target);
			const copied: LaneFileEvidence = { ...entry, preserved: true };
			kept.push(copied);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => undefined);
			problems.push({ event: "artifact_copy_failed", detail: `${entry.file}: ${String(error)}` });
			kept.push(entry);
		}
	}
	return { evidence: kept, problems };
}
