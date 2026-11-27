import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The `index.lock` path of a checkout. A plain checkout's `.git` is a directory holding the lock, but a linked
 * worktree's `.git` is a file whose `gitdir:` line names the real git dir (`<common>/.git/worktrees/<name>`):
 * the lock lives there, so `<worktree>/.git/index.lock` never exists for a lane/task worktree. A `gitdir:` path
 * may be relative to the worktree. An unreadable `.git` falls back to the plain path, which then simply does
 * not exist.
 */
export function indexLockOf(repo: string): string {
	const dotGit = join(repo, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return join(dotGit, "index.lock");
		const gitdir = /^gitdir:[ \t]*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
		if (gitdir !== undefined && gitdir !== "") return join(resolve(repo, gitdir), "index.lock");
	} catch {
		// No readable `.git`: the plain path below is the only candidate.
	}
	return join(dotGit, "index.lock");
}
