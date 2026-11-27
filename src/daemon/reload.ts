import type { JabbuConfig } from "../config";
import { applyLiveChannelsReload } from "./discord-policy";
import { CLI_FIELDS, LIVE_FIELDS, RESTART_FIELDS } from "./reload-fields";

export { CLI_FIELDS, LIVE_FIELDS, RESTART_FIELDS };

/**
 * Config reload without a restart: `jabbu-pocket reload` or SIGHUP re-reads config.json. Policy fields apply live
 * (`channels.discord`'s connection keys too); restart-bound ones are only reported, and an invalid file changes nothing.
 */

/** Compile-time guard: a new config field must land in one of the three lists, or `reload` never reports it;
 * `schemaVersion`, `homeDir`, `configPath` and `warnings` are not settings in the file. */
type UnclassifiedField = Exclude<
	keyof JabbuConfig,
	| (typeof LIVE_FIELDS)[number]
	| (typeof RESTART_FIELDS)[number]
	| (typeof CLI_FIELDS)[number]
	| "schemaVersion"
	| "homeDir"
	| "configPath"
	| "warnings"
>;
true satisfies [UnclassifiedField] extends [never] ? true : never;

export interface ReloadPlan {
	/** The config the daemon runs with after the reload: live fields from the new file, everything else unchanged. */
	next: JabbuConfig;
	changed: string[];
	restartRequired: string[];
	cli: string[];
}

/** What `jabbu-pocket reload` (IPC op `reload`) answers. */
export type ReloadResult =
	| { ok: true; changed: string[]; restartRequired: string[]; cli: string[] }
	| { ok: false; error: string };

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

export function planReload(current: JabbuConfig, fresh: JabbuConfig): ReloadPlan {
	const next: JabbuConfig = { ...current };
	const changed: string[] = [];
	for (const field of LIVE_FIELDS) {
		if (!differs(current[field], fresh[field])) continue;
		changed.push(field);
		if (fresh[field] === undefined) delete next[field];
		else (next as unknown as Record<string, unknown>)[field] = fresh[field];
	}
	const restartRequired = RESTART_FIELDS.filter((field) => differs(current[field], fresh[field]));
	changed.push(...applyLiveChannelsReload(next, current, fresh, restartRequired));
	return {
		next,
		changed,
		restartRequired,
		cli: CLI_FIELDS.filter((field) => differs(current[field], fresh[field])),
	};
}
