// The `taskAutoLand.repos` / `lanes.land` paths doctor checks: `loadConfig` only asks that they are absolute,
// so a typo'd entry is a silent mismatch at runtime (`repoMatchesCommonDir` returns false) — auto-land never
// fires for that repo, and a `pr` landing silently falls back to a direct ff merge. Split out of `doctor.ts`
// to keep that file within its size ratchet.
import { type JabbuConfig, requireGitRepo } from "../config";

type Report = (ok: boolean, name: string, detail: string) => void;

/**
 * One `ok`/`fail` line per configured repository path (`taskAutoLand.repos` entries and `lanes.land` keys,
 * deduped): each must be a git work tree with a commit now. `lanes.land.*.remotes` values are paths on remote
 * hosts and are not checked locally. Nothing when neither key is configured.
 */
export function checkConfigRepos(
	config: Pick<JabbuConfig, "configPath" | "taskAutoLand" | "lanes">,
	report: Report,
	warn: (name: string, detail: string) => void,
): void {
	const seen = new Map<string, string>();
	for (const repo of config.taskAutoLand?.repos ?? []) seen.set(repo, "taskAutoLand.repos");
	for (const repo of Object.keys(config.lanes?.land ?? {})) {
		if (!seen.has(repo)) seen.set(repo, `lanes.land.${repo}`);
	}
	if (seen.size === 0) return;
	// qa-z #62: without git on PATH the spawn throws ENOENT and would kill the whole doctor run before the
	// discord check; a host without git has no checkout to report on anyway.
	if (Bun.which("git") === null) {
		warn("config repos", "git not on PATH; repo paths unchecked");
		return;
	}
	for (const [repo, field] of seen) {
		try {
			requireGitRepo(config.configPath, repo, field);
			report(true, "config repo", repo);
		} catch {
			report(false, "config repo", `${repo} is not a readable git repository (check ${field})`);
		}
	}
}
