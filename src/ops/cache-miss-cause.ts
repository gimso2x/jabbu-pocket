/**
 * Which side changed when a `child_restart` cache miss happens: jabbu's own spawn prompt (hash kept in a small file of
 * the session dir, so a daemon restart does not forget it) or omp's (the `system-prompt-digest` records omp appends to
 * the session file). Both read off the disk, never from mailbox memory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPAWN_PROMPT_FILE = ".jabbu-spawn-prompt.sha256";
const DIGEST_PATTERN = /"customType":"system-prompt-digest","data":"([^"]*)"/g;

export type CauseVerdict = "true" | "false" | "unknown";

/** The session file's digest records as they stood when a child was spawned. */
export interface SpawnSnapshot {
	sessionDir: string;
	file: string | undefined;
	digests: string[];
}

/** Writes this spawn's prompt hash to the session dir, the previous spawn's hash on the second line. */
export function recordSpawnPrompt(sessionDir: string, prompt: string): void {
	const file = join(sessionDir, SPAWN_PROMPT_FILE);
	const previous = readHashes(sessionDir)[0] ?? "";
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(file, `${createHash("sha256").update(prompt).digest("hex")}\n${previous}\n`);
}

function readHashes(sessionDir: string): string[] {
	try {
		return readFileSync(join(sessionDir, SPAWN_PROMPT_FILE), "utf8").split("\n");
	} catch {
		return [];
	}
}

function digestsOf(file: string | undefined): string[] {
	if (file === undefined) return [];
	try {
		return [...readFileSync(file, "utf8").matchAll(DIGEST_PATTERN)].map((match) => match[1] ?? "");
	} catch {
		return [];
	}
}

/** Before the child starts: the digests `file` (the session it resumes) holds. */
export function spawnSnapshot(sessionDir: string, file: string | undefined): SpawnSnapshot {
	return { sessionDir, file, digests: digestsOf(file) };
}

/**
 * `jabbu_prompt_changed`: this spawn's prompt hash against the previous spawn's (unknown without a previous one).
 * `omp_digest_changed`: the newest digest written since the spawn against the last one before it (unknown when either
 * does not exist).
 */
export function childRestartCause(spawn: SpawnSnapshot): Record<string, CauseVerdict> {
	const [current, previous] = readHashes(spawn.sessionDir);
	const now = digestsOf(spawn.file);
	const before = spawn.digests.at(-1);
	const after = now.length > spawn.digests.length ? now.at(-1) : undefined;
	return {
		jabbu_prompt_changed: !current || !previous ? "unknown" : (String(current !== previous) as CauseVerdict),
		omp_digest_changed:
			before === undefined || after === undefined ? "unknown" : (String(before !== after) as CauseVerdict),
	};
}
