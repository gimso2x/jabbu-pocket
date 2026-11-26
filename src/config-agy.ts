// `config.json` keys of the agy agent and worker, parsed here to keep `config.ts` within its size ratchet.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { asRecord, invalid, optionalString } from "./config-validate";
import { RESERVED_ENV_PREFIXES } from "./omp/env";

export interface WorkerAgyConfig {
	model: string;
}

/** Account pool for `agent: "agy"` (`order` + `<name>.token` directory + per-account `--app-data-dir` prefix). */
export interface AgyAccountsConfig {
	dir: string;
	appDataPrefix?: string;
	statePath?: string;
}

/** Commands and optional multi-account dir for the dashboard's "모델 한도" strip. */
export interface DashboardUsageLimitsConfig {
	omp?: string[][];
	agy?: string[];
	agyAccount?: string[];
	agyAccountsDir?: string;
}

/** One stdio MCP server an agy conversation gets (ACP `mcpServers` entry, passed on `session/new|resume`). */
export interface AgyMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const argvOk = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part !== "");
const APP_DATA_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

function resolveUserDir(configPath: string, field: string, raw: unknown): string {
	if (!nonEmpty(raw) || /\p{Cc}/u.test(raw)) invalid(configPath, field);
	if (raw === "~") return resolve(homedir());
	if (raw.startsWith("~/")) return resolve(join(homedir(), raw.slice(1)));
	if (raw.startsWith("~") || !isAbsolute(raw)) invalid(configPath, field);
	return resolve(raw);
}

function resolveUserFile(configPath: string, field: string, raw: unknown): string {
	if (!nonEmpty(raw) || /\p{Cc}/u.test(raw) || raw === "~" || raw.endsWith("/")) invalid(configPath, field);
	if (raw.startsWith("~/")) return resolve(join(homedir(), raw.slice(2)));
	if (raw.startsWith("~") || !isAbsolute(raw)) invalid(configPath, field);
	return resolve(raw);
}

/** `agyExecutable`: optional absolute path to the agy CLI binary. */
export function agyExecutableOf(configPath: string, root: Record<string, unknown>): string | undefined {
	const executable = optionalString(configPath, root, "agyExecutable");
	if (executable !== undefined && !isAbsolute(executable)) invalid(configPath, "agyExecutable");
	return executable;
}

/** `agyAccounts`: `{ dir, appDataPrefix?, statePath? }`; expands `~/` in `dir`/`statePath` and refuses unsafe paths. */
export function agyAccountsOf(configPath: string, value: unknown): AgyAccountsConfig | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "agyAccounts");
	for (const key of Object.keys(record)) {
		if (key !== "dir" && key !== "appDataPrefix" && key !== "statePath") invalid(configPath, `agyAccounts.${key}`);
	}
	const dir = resolveUserDir(configPath, "agyAccounts.dir", record.dir);
	const appDataPrefix = record.appDataPrefix;
	if (
		appDataPrefix !== undefined &&
		(typeof appDataPrefix !== "string" || !APP_DATA_PREFIX.test(appDataPrefix) || appDataPrefix.includes(".."))
	) {
		invalid(configPath, "agyAccounts.appDataPrefix");
	}
	const statePath =
		record.statePath === undefined ? undefined : resolveUserFile(configPath, "agyAccounts.statePath", record.statePath);
	return {
		dir,
		...(appDataPrefix === undefined ? {} : { appDataPrefix }),
		...(statePath === undefined ? {} : { statePath }),
	};
}

/** `dashboard.usageLimits`: validates `omp`, `agy`, `agyAccount`, and optional `agyAccountsDir` (`~/` expanded). */
export function usageLimitsOf(configPath: string, value: unknown): DashboardUsageLimitsConfig | undefined {
	if (value === undefined) return undefined;
	const limits = asRecord(value);
	if (limits === undefined) invalid(configPath, "dashboard.usageLimits");
	if (limits.omp !== undefined && !(Array.isArray(limits.omp) && limits.omp.every(argvOk))) {
		invalid(configPath, "dashboard.usageLimits.omp");
	}
	if (limits.agy !== undefined && !argvOk(limits.agy)) invalid(configPath, "dashboard.usageLimits.agy");
	if (limits.agyAccount !== undefined && !argvOk(limits.agyAccount)) {
		invalid(configPath, "dashboard.usageLimits.agyAccount");
	}
	const agyAccountsDir =
		limits.agyAccountsDir === undefined
			? undefined
			: resolveUserDir(configPath, "dashboard.usageLimits.agyAccountsDir", limits.agyAccountsDir);
	for (const key of Object.keys(limits)) {
		if (key !== "omp" && key !== "agy" && key !== "agyAccount" && key !== "agyAccountsDir") {
			invalid(configPath, `dashboard.usageLimits.${key}`);
		}
	}
	return {
		...(limits.omp === undefined ? {} : { omp: limits.omp as string[][] }),
		...(limits.agy === undefined ? {} : { agy: limits.agy as string[] }),
		...(limits.agyAccount === undefined ? {} : { agyAccount: limits.agyAccount as string[] }),
		...(agyAccountsDir === undefined ? {} : { agyAccountsDir }),
	};
}

/** `workerAgy`: `{ model }` only; the model goes to agy as one argument (no blank, no leading `-`). */
export function workerAgyOf(configPath: string, value: unknown): WorkerAgyConfig | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "workerAgy");
	for (const key of Object.keys(record)) if (key !== "model") invalid(configPath, `workerAgy.${key}`);
	const model = record.model;
	if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model)) invalid(configPath, "workerAgy.model");
	return { model };
}

/**
 * `agyMcpServers`: `[{ name, command, args?, env?: [{ name, value }] }]`. An env name with a prefix the child env
 * strips (`SLACK_`, `JABBU_`, `LD_`, `DYLD_`) is refused, so the MCP server cannot get what the agent may not.
 */
export function agyMcpServersOf(configPath: string, value: unknown): AgyMcpServer[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) invalid(configPath, "agyMcpServers");
	return value.map((item, index) => {
		const field = `agyMcpServers[${index}]`;
		const record = asRecord(item);
		if (record === undefined) invalid(configPath, field);
		for (const key of Object.keys(record)) {
			if (!["name", "command", "args", "env"].includes(key)) invalid(configPath, `${field}.${key}`);
		}
		if (!nonEmpty(record.name)) invalid(configPath, `${field}.name`);
		if (!nonEmpty(record.command)) invalid(configPath, `${field}.command`);
		const args = record.args ?? [];
		if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) invalid(configPath, `${field}.args`);
		const env = record.env ?? [];
		if (!Array.isArray(env)) invalid(configPath, `${field}.env`);
		return {
			name: record.name,
			command: record.command,
			args: args as string[],
			env: env.map((entry, envIndex) => {
				const pair = asRecord(entry);
				const name = pair?.name;
				if (
					pair === undefined ||
					!nonEmpty(name) ||
					typeof pair.value !== "string" ||
					RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
				) {
					invalid(configPath, `${field}.env[${envIndex}]`);
				}
				return { name, value: pair.value };
			}),
		};
	});
}
