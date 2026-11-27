// `jabbu-pocket skills lock|verify` CLI 하위 명령.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultHomeDir } from "../config";
import { verifySkillLock, writeSkillLock } from "../review/skill-lock";
import { agentSkillsRoot } from "../review/skills";

export const SKILLS_LOCK_USAGE = `  skills lock [--dir <d>] [--file <f>] [--json]    pin SHA-256 checksums of installed skills into a lockfile
  skills verify [--dir <d>] [--file <f>] [--strict] [--json]    verify skills against the lockfile and scan high-risk patterns
`;

function resolveRootDir(rawDir: string | undefined, env: Record<string, string | undefined>): string {
	if (rawDir !== undefined) return resolve(rawDir);
	return env.JABBU_TEST_HOOKS === "1" && env.JABBU_SKILLS_DIR
		? resolve(env.JABBU_SKILLS_DIR)
		: agentSkillsRoot(env.HOME || undefined);
}

function resolveLockPath(rawFile: string | undefined, env: Record<string, string | undefined>): string {
	return rawFile !== undefined ? resolve(rawFile) : join(defaultHomeDir(env), "skills.lock.json");
}

/** `jabbu-pocket skills <lock|verify>` 실행기. */
export function skillsLockCommand(
	sub: "lock" | "verify",
	args: string[],
	env: Record<string, string | undefined> = process.env,
): number {
	if (sub === "lock") {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				dir: { type: "string" },
				file: { type: "string" },
				json: { type: "boolean" },
			},
		});
		if (positionals.length > 0 || values.dir === "" || values.file === "") {
			process.stderr.write(`usage: jabbu-pocket skills lock [--dir <d>] [--file <f>] [--json]\n${SKILLS_LOCK_USAGE}`);
			return 2;
		}
		const rootDir = resolveRootDir(values.dir, env);
		const lockPath = resolveLockPath(values.file, env);
		try {
			const lock = writeSkillLock(rootDir, lockPath);
			if (values.json === true) {
				process.stdout.write(`${JSON.stringify({ ...lock, file: resolve(lockPath) })}\n`);
			} else {
				process.stdout.write(
					`skill_lock files=${Object.keys(lock.files).length} root=${lock.root} file=${resolve(lockPath)}\n`,
				);
			}
			return 0;
		} catch (error) {
			process.stderr.write(`skills lock failed: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	}

	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			dir: { type: "string" },
			file: { type: "string" },
			strict: { type: "boolean" },
			json: { type: "boolean" },
		},
	});
	if (positionals.length > 0 || values.dir === "" || values.file === "") {
		process.stderr.write(
			`usage: jabbu-pocket skills verify [--dir <d>] [--file <f>] [--strict] [--json]\n${SKILLS_LOCK_USAGE}`,
		);
		return 2;
	}
	const rootDir = resolveRootDir(values.dir, env);
	const lockPath = resolveLockPath(values.file, env);
	const strict = values.strict === true;
	try {
		const result = verifySkillLock(rootDir, lockPath);
		const passed = result.ok && (!strict || result.warnings.length === 0);
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify({ ...result, strict, passed })}\n`);
		} else {
			process.stdout.write(
				`skill_verify ok=${passed} locked=${result.totalLocked} current=${result.totalCurrent} added=${result.added.length} modified=${result.modified.length} removed=${result.removed.length} symlinks=${result.symlinks.length} warnings=${result.warnings.length}\n`,
			);
			for (const path of result.added) process.stdout.write(`added ${path}\n`);
			for (const path of result.modified) process.stdout.write(`modified ${path}\n`);
			for (const path of result.removed) process.stdout.write(`removed ${path}\n`);
			for (const path of result.symlinks) process.stdout.write(`symlink ${path}\n`);
			for (const w of result.warnings)
				process.stdout.write(`warning ${w.path}:${w.line} rule=${w.rule} ${w.excerpt}\n`);
		}
		return passed ? 0 : 1;
	} catch (error) {
		process.stderr.write(`skills verify failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
