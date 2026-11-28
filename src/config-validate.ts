// Config field-validation primitives (the `ConfigError` contract and the field parsers `loadConfig` judges with):
// messages carry the offending path and field names only, never file contents or values.
import { isAbsolute } from "node:path";
import { LANE_MODEL_TIERS } from "./model-tiers";
import { baseProblem } from "./tasks/base-ref";
import { TASK_PATH_PATTERN } from "./tasks/docs";

export type ConfigErrorCode =
	| "home_missing"
	| "home_permissions"
	| "home_relative"
	| "config_missing"
	| "config_unreadable"
	| "config_invalid_json"
	| "config_invalid"
	| "secret_missing"
	| "secret_permissions";

export class ConfigError extends Error {
	readonly code: ConfigErrorCode;
	readonly path: string;

	constructor(code: ConfigErrorCode, path: string, detail?: string) {
		super(`${code}: ${path}${detail ? ` (${detail})` : ""}`);
		this.name = "ConfigError";
		this.code = code;
		this.path = path;
	}
}

/** `taskAutoLand.review.timeoutMs`: default and upper bound of one lane review run. */
export const LANE_REVIEW_TIMEOUT_MAX_MS = 1_800_000;

export interface ConfigWarning {
	field: string;
	reason: "unknown_key" | "unsafe_name" | "unusable" | "config_key_ignored";
}

export function invalid(path: string, field: string): never {
	throw new ConfigError("config_invalid", path, `field=${field}`);
}

/** A gate's optional `timeoutMs`: a positive integer of at most `LANE_REVIEW_TIMEOUT_MAX_MS`. */
export function gateTimeoutMs(configPath: string, value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > LANE_REVIEW_TIMEOUT_MAX_MS) {
		invalid(configPath, field);
	}
	return value;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Control characters (NUL included) never belong in a path, argument or name that later reaches spawn or the filesystem. */
const CONTROL_CHARS = /\p{Cc}/u;

export function requiredString(configPath: string, obj: Record<string, unknown>, key: string, field = key): string {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "" || CONTROL_CHARS.test(value)) invalid(configPath, field);
	return value;
}

export function optionalString(
	configPath: string,
	obj: Record<string, unknown>,
	key: string,
	field = key,
): string | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "" || CONTROL_CHARS.test(value)) invalid(configPath, field);
	return value;
}

/** An optional safe integer in `[min, max]`. */
export function optionalInt(
	configPath: string,
	obj: Record<string, unknown>,
	key: string,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(configPath, key);
	return value;
}

/** An optional argument list: an array of non-empty strings (copied), else `field` is invalid. */
export function optionalArgList(
	configPath: string,
	obj: Record<string, unknown>,
	key: string,
	field: string = key,
): string[] | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string" || arg.trim() === "")) {
		invalid(configPath, field);
	}
	return [...(value as string[])];
}

/** `lanes.models`: each tier one of `LANE_MODEL_TIERS`, each model `provider/id`. */
export function checkLaneModels(configPath: string, value: unknown): void {
	const models = asRecord(value);
	if (models === undefined) invalid(configPath, "lanes.models");
	for (const [tier, model] of Object.entries(models)) {
		if (!(LANE_MODEL_TIERS as readonly string[]).includes(tier)) invalid(configPath, `lanes.models.${tier}`);
		if (typeof model !== "string" || !/^[^/\s\p{Cc}]+\/[^\s\p{Cc}]+$/u.test(model)) {
			invalid(configPath, `lanes.models.${tier}`);
		}
	}
}

/**
 * How one repository's closed lanes land (`lanes.land[<absolute repo path>]`): `ff`
 * (default) merges and pushes the base branch; `pr` pushes the lane branch to `remote`, opens a PR, waits for its
 * GitHub Actions CI (`requiredChecks`, else the jobs of `.github/workflows/ci.yml`) and squash-merges it.
 */
export interface LaneLandRepoConfig {
	mode: "ff" | "pr";
	/** Remote the lane branch is pushed to and `gh` works on (default `origin`). */
	remote?: string;
	/** After the push, no check run at all still counts as pending this long (default 5 minutes). */
	ciGraceMs?: number;
	/** CI not green this long after the push: the landing is held for the owner (default 1 hour). */
	ciTimeoutMs?: number;
	requiredChecks?: string[];
	/**
	 * Where this repository lives on a `dispatchHosts` host (host name → absolute path): a [TASK] of that host's
	 * repository lands by this entry's mode.
	 */
	remotes?: Record<string, string>;
}

const LANE_LAND_KEYS = new Set(["mode", "remote", "ciGraceMs", "ciTimeoutMs", "requiredChecks", "remotes"]);
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `lanes.land`, keyed by absolute repository path (trailing slashes dropped). */
export function laneLandOf(configPath: string, value: unknown): Record<string, LaneLandRepoConfig> {
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "lanes.land");
	const land: Record<string, LaneLandRepoConfig> = {};
	for (const [repo, raw] of Object.entries(record)) {
		const field = `lanes.land.${repo}`;
		const entry = asRecord(raw);
		if (!isAbsolute(repo) || CONTROL_CHARS.test(repo) || entry === undefined) invalid(configPath, field);
		for (const key of Object.keys(entry)) if (!LANE_LAND_KEYS.has(key)) invalid(configPath, `${field}.${key}`);
		const mode = entry.mode ?? "ff";
		if (mode !== "ff" && mode !== "pr") invalid(configPath, `${field}.mode`);
		const remote = optionalString(configPath, entry, "remote", `${field}.remote`);
		if (remote !== undefined && !REMOTE_NAME.test(remote)) invalid(configPath, `${field}.remote`);
		const ms = (key: "ciGraceMs" | "ciTimeoutMs"): number | undefined => {
			const ms = entry[key];
			if (ms !== undefined && (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0)) {
				invalid(configPath, `${field}.${key}`);
			}
			return ms;
		};
		const ciGraceMs = ms("ciGraceMs");
		const ciTimeoutMs = ms("ciTimeoutMs");
		const required = entry.requiredChecks;
		if (
			required !== undefined &&
			(!Array.isArray(required) || required.some((name) => typeof name !== "string" || name.trim() === ""))
		) {
			invalid(configPath, `${field}.requiredChecks`);
		}
		const remotesRaw = entry.remotes === undefined ? undefined : asRecord(entry.remotes);
		if (entry.remotes !== undefined && remotesRaw === undefined) invalid(configPath, `${field}.remotes`);
		const remotes = Object.entries(remotesRaw ?? {}).map(([host, path]) => {
			if (!isRecordsPath(path)) invalid(configPath, `${field}.remotes.${host}`);
			return [host, (path as string).replace(/(?<=.)\/+$/, "")] as const;
		});
		land[repo.replace(/(?<=.)\/+$/, "")] = {
			mode,
			...(remote === undefined ? {} : { remote }),
			...(ciGraceMs === undefined ? {} : { ciGraceMs }),
			...(ciTimeoutMs === undefined ? {} : { ciTimeoutMs }),
			...(required === undefined ? {} : { requiredChecks: [...(required as string[])] }),
			...(remotesRaw === undefined ? {} : { remotes: Object.fromEntries(remotes) }),
		};
	}
	return land;
}

/**
 * `lanes.land.<repo>.remotes` against `dispatchHosts` (parsed apart from `lanes`, so the file's key order does not
 * matter): every host must be configured, and one (host, path) may belong to one repository only.
 */
export function checkLaneLandRemotes(
	configPath: string,
	land: Record<string, LaneLandRepoConfig> | undefined,
	dispatchHosts: Record<string, DispatchHostConfig> | undefined,
): void {
	const seen = new Set<string>();
	for (const [repo, entry] of Object.entries(land ?? {})) {
		for (const [host, path] of Object.entries(entry.remotes ?? {})) {
			const field = `lanes.land.${repo}.remotes.${host}`;
			if (dispatchHosts === undefined || !Object.hasOwn(dispatchHosts, host)) invalid(configPath, field);
			const key = JSON.stringify([host, path]);
			if (seen.has(key)) invalid(configPath, field);
			seen.add(key);
		}
	}
}

/** One `dispatchHosts` entry: ssh target, remote work directory, remote herdr binary, worker omp extra arguments. */
export interface DispatchHostConfig {
	ssh: string;
	workDir?: string;
	herdrBin?: string;
	ompArgs?: string[];
	recordsDir?: string;
	/** Branch-name rules of [TASK]s in this host's repositories (see {@link BranchRule}). */
	branchRules?: BranchRule[];
}

/** A branch-name rule for the repositories under `repoPrefix` on a host: a new [TASK] there must give a matching `taskSpec.branch`. */
export interface BranchRule {
	/** Absolute directory on the host; matches on a path boundary, the longest prefix wins. */
	repoPrefix: string;
	/** Absolute repository paths the rule leaves out. */
	exclude?: string[];
	/** Regular expression the branch name must match. */
	pattern: string;
	/** A conforming name, shown when a branch is refused. */
	example: string;
	/** Ref a new [TASK] worktree in these repositories forks from unless `taskSpec.base` names one (default `HEAD`). */
	base?: string;
}

/** The keys of a `dispatchHosts` entry; a typo (`workdir`) must not silently fall back to the default. */
const DISPATCH_HOST_KEYS = new Set(["ssh", "workDir", "herdrBin", "ompArgs", "recordsDir", "branchRules"]);
const BRANCH_RULE_KEYS = new Set(["repoPrefix", "exclude", "pattern", "example", "base"]);
/** A `dispatchHosts.<h>.ssh` target: not an ssh option (no leading `-`), no whitespace or control character (NUL throws in spawn). */
const DISPATCH_SSH = /^[^\s-][^\s\p{Cc}]*$/u;
/** A `dispatchHosts.<h>.workDir` / `herdrBin`: non-empty (an empty word would reach the remote command) and no control character (NUL throws in spawn). */
const isHostPath = (value: unknown): boolean => typeof value === "string" && /^[^\p{Cc}]+$/u.test(value);
/** `recordsRepo` / `recordsDir`, a `remotes` path: absolute, shell-inert, no `..`. */
export const isRecordsPath = (value: unknown): boolean =>
	typeof value === "string" && TASK_PATH_PATTERN.test(value) && !value.includes("..");

const FORBIDDEN_HOST_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** `dispatchHosts.<h>.branchRules`: absolute prefixes and excludes, a compilable pattern and a one-line example; throws `config_invalid`. */
function checkBranchRules(configPath: string, value: unknown, field: string): void {
	if (!Array.isArray(value)) invalid(configPath, field);
	value.forEach((entry, index) => {
		const at = `${field}[${index}]`;
		const rule = asRecord(entry);
		if (rule === undefined) invalid(configPath, at);
		for (const key of Object.keys(rule)) if (!BRANCH_RULE_KEYS.has(key)) invalid(configPath, `${at}.${key}`);
		if (!isRecordsPath(rule.repoPrefix)) invalid(configPath, `${at}.repoPrefix`);
		const exclude = rule.exclude;
		if (exclude !== undefined && (!Array.isArray(exclude) || !exclude.every(isRecordsPath))) {
			invalid(configPath, `${at}.exclude`);
		}
		if (typeof rule.pattern !== "string" || rule.pattern === "") invalid(configPath, `${at}.pattern`);
		try {
			new RegExp(rule.pattern);
		} catch {
			invalid(configPath, `${at}.pattern`);
		}
		if (typeof rule.example !== "string" || !/^[^\p{Cc}]+$/u.test(rule.example)) invalid(configPath, `${at}.example`);
		if (rule.base !== undefined && (typeof rule.base !== "string" || baseProblem(rule.base) !== undefined))
			invalid(configPath, `${at}.base`);
	});
}

/** `dispatchHosts`: each entry's ssh target, paths and arguments judged; `undefined` when the key is absent. */
export function dispatchHostsOf(
	configPath: string,
	value: unknown,
	warnings: ConfigWarning[],
): Record<string, DispatchHostConfig> | undefined {
	if (value === undefined) return undefined;
	const hosts = asRecord(value);
	if (hosts === undefined) invalid(configPath, "dispatchHosts");
	for (const [name, entry] of Object.entries(hosts)) {
		if (name.trim() === "" || FORBIDDEN_HOST_NAMES.has(name)) invalid(configPath, `dispatchHosts.${name}`);
		const record = asRecord(entry);
		if (record === undefined || typeof record.ssh !== "string" || !DISPATCH_SSH.test(record.ssh)) {
			invalid(configPath, `dispatchHosts.${name}.ssh`);
		}
		for (const key of ["workDir", "herdrBin", "recordsDir"]) {
			const valid = key === "recordsDir" ? isRecordsPath : isHostPath;
			if (record[key] !== undefined && !valid(record[key])) invalid(configPath, `dispatchHosts.${name}.${key}`);
		}
		optionalArgList(configPath, record, "ompArgs", `dispatchHosts.${name}.ompArgs`);
		if (record.branchRules !== undefined)
			checkBranchRules(configPath, record.branchRules, `dispatchHosts.${name}.branchRules`);
		for (const key of Object.keys(record)) {
			if (!DISPATCH_HOST_KEYS.has(key)) invalid(configPath, `dispatchHosts.${name}.${key}`);
		}
	}
	// A name is printed into doctor lines and reports; a control character in it could forge a line there.
	if (Object.keys(hosts).some((name) => /[\p{Cc}\p{Cf}]/u.test(name))) {
		warnings.push({ field: "dispatchHosts", reason: "unsafe_name" });
	}
	return hosts as unknown as Record<string, DispatchHostConfig>;
}
