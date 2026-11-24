import { join } from "node:path";
import type { OmpbotConfig } from "../config";
import type { LaneLandMode } from "./pr-land-steps";

/** `<recordsRepo>/release/denylist.txt` — the leak-check denylist, as `LaneLandMode.denylistFile` carries it. */
export const denylistOf = (recordsRepo: string | undefined): Pick<LaneLandMode, "denylistFile"> =>
	recordsRepo === undefined ? {} : { denylistFile: join(recordsRepo, "release", "denylist.txt") };

/** How a [TASK] repository on a `dispatchHosts` host lands: the local repository's `lanes.land` entry, and the host to reach it. */
export interface RemoteLandMode extends LaneLandMode {
	mode: "ff" | "pr";
	/** The `lanes.land` key: the repository's path on this machine. */
	localRepo: string;
	/** The repository's path on `host` (`remotes[host]`). */
	remoteRepo: string;
	/** `dispatchHosts[host].ssh`. */
	ssh: string;
}

/**
 * The `lanes.land` entry whose `remotes[host]` is `repo` (the task's repository on that host); `undefined` when no
 * entry names it or the host is not configured.
 */
export function landModeOfRemote(
	config: Pick<OmpbotConfig, "lanes" | "recordsRepo" | "dispatchHosts">,
	host: string,
	repo: string,
): RemoteLandMode | undefined {
	const ssh = config.dispatchHosts?.[host]?.ssh;
	if (ssh === undefined) return undefined;
	for (const [localRepo, entry] of Object.entries(config.lanes?.land ?? {})) {
		if (entry.remotes?.[host] !== repo) continue;
		return { mode: entry.mode, localRepo, remoteRepo: repo, ssh, config: entry, ...denylistOf(config.recordsRepo) };
	}
	return undefined;
}
