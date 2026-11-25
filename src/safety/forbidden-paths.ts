import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Credential stores under the user's home no upload may come from (the bot home's `secrets` is added per call). */
const PROTECTED_HOME_DIRS = [
	".jabbu/secrets",
	".ssh",
	".gnupg",
	".aws",
	".omp/agent",
	".git-credentials",
	".netrc",
	".config/gh",
	".config/gcloud",
	".npmrc",
	".kube",
	".docker",
];

/** The real path of `path`; a path that is not there stays as given. */
export function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The real paths an upload must not come from: the bot home's `secrets`, the built-in credential stores under
 * `userHome`, and `extra` (`~/…` resolved against `userHome`). Each is compared after resolving symlinks.
 */
export function protectedDirs(homeDir: string, userHome: string, extra: readonly string[] = []): string[] {
	const added = extra.map((path) => (path.startsWith("~/") ? join(userHome, path.slice(2)) : path));
	return [join(homeDir, "secrets"), ...PROTECTED_HOME_DIRS.map((rel) => join(userHome, rel)), ...added].map(realOrSelf);
}
