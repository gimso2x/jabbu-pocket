// `config.json` keys of the agy agent and worker, parsed here to keep `config.ts` within its size ratchet.

import type { WorkerAgyConfig } from "./config";
import { asRecord, invalid } from "./config-validate";
import { RESERVED_ENV_PREFIXES } from "./omp/env";

/** One stdio MCP server an agy conversation gets (ACP `mcpServers` entry, passed on `session/new|resume`). */
export interface AgyMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

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
