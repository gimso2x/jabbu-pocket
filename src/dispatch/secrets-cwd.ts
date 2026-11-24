import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** A bot home's secrets directory anywhere in a path: `~/.jabbu/secrets`, `~/.jabbu-songbak/secrets`, … */
const BOT_SECRETS_PATH = /(?:^|\/)\.jabbu[^/]*\/secrets(?:\/|$)/;

/**
 * A path as the file system resolves it (symlinks followed). A path that does not exist yet keeps its missing tail
 * as written, after its nearest existing ancestor is resolved: `link-to-secrets/new` is still inside secrets.
 */
function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		const full = resolve(path);
		const parent = dirname(full);
		return parent === full ? full : join(realOrResolved(parent), basename(full));
	}
}

/**
 * Why a worker must not start in `cwd`: inside the bot's secrets directory or a `~/.jabbu*` home's `secrets`. A local
 * path is judged after symlinks; a remote one, which this machine cannot resolve, by any `secrets` path component.
 */
export function secretsCwdProblem(cwd: string, remote: boolean, homeDir: string): string | undefined {
	const refused = `워커 cwd를 비밀 디렉터리 안으로 줄 수 없습니다: ${cwd}`;
	if (remote) return cwd.split("/").includes("secrets") ? refused : undefined;
	if (!isAbsolute(cwd)) return undefined;
	const real = realOrResolved(cwd);
	const secrets = realOrResolved(join(homeDir, "secrets"));
	const inside = real === secrets || real.startsWith(`${secrets}${sep}`) || BOT_SECRETS_PATH.test(real);
	return inside ? refused : undefined;
}
