import type { OmpbotConfig } from "../config";
import { CLI_FIELDS, LIVE_FIELDS, RESTART_FIELDS } from "./reload-fields";

export { CLI_FIELDS, LIVE_FIELDS, RESTART_FIELDS };

/**
 * Config reload without a restart (gajae-way SIGHUP reload): `ompbot reload` or SIGHUP re-reads config.json. Policy
 * fields apply live, fields bound to startup resources are reported as needing a restart and left untouched, and
 * fields only the CLI reads (gc, backup) take effect on its next run anyway. A config that fails validation changes
 * nothing.
 */

/**
 * Compile-time guard: a new config field must land in one of the three lists, or `reload` never reports it.
 * `schemaVersion`, `homeDir` and `configPath` come from where the file was loaded, and `warnings` from which key
 * names it uses, not from a setting in it.
 */
type UnclassifiedField = Exclude<
	keyof OmpbotConfig,
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
	next: OmpbotConfig;
	changed: string[];
	restartRequired: string[];
	cli: string[];
}

/** What `ompbot reload` (IPC op `reload`) answers. */
export type ReloadResult =
	| { ok: true; changed: string[]; restartRequired: string[]; cli: string[] }
	| { ok: false; error: string };

const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

export function planReload(current: OmpbotConfig, fresh: OmpbotConfig): ReloadPlan {
	const next: OmpbotConfig = { ...current };
	const changed: string[] = [];
	for (const field of LIVE_FIELDS) {
		if (!differs(current[field], fresh[field])) continue;
		changed.push(field);
		if (fresh[field] === undefined) delete next[field];
		else (next as unknown as Record<string, unknown>)[field] = fresh[field];
	}
	return {
		next,
		changed,
		restartRequired: RESTART_FIELDS.filter((field) => differs(current[field], fresh[field])),
		cli: CLI_FIELDS.filter((field) => differs(current[field], fresh[field])),
	};
}
