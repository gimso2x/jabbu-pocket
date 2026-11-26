import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import type { AgyMcpServer } from "../config-agy";
import type { Logger } from "../log";
import { OmpDriverError, type OmpUsage } from "./driver";
import { MAX_RPC_FRAME_BYTES } from "./rpc-client";
import { isRecord } from "./type-guards";

/*
 * One `agy acp` child and its JSON-RPC 2.0 wire (agy 1.5.16, both directions one message per line). Modelled on omp's
 * antigravity-cli provider (oh-my-pi eca7acfa45, MIT: `packages/ai/src/providers/antigravity-cli/host.ts`,
 * `packages/utils/src/acp/`); written here, nothing imported.
 * - out requests `initialize`, `session/new|load`, `session/set_config_option`, `session/prompt`; out notification
 *   `session/cancel`.
 * - in  responses (paired by `id`), `session/update` notifications, and agent→client requests: `session/request_permission`
 *   is answered `cancelled` like omp (the child runs with `--dangerously-skip-permissions`, so it should never ask),
 *   any other request gets JSON-RPC "method not found".
 * The child leads its own process group: `kill` signals the whole group, so the shells and MCP servers agy started
 * go with it.
 */

/** The child's arguments after the executable: ACP over stdio, no telemetry, tools without prompts. */
export const AGY_ACP_ARGS = ["acp", "--disable-telemetry", "--dangerously-skip-permissions"] as const;
/**
 * Env omp gives agy (`host.ts` startTransport, `credentials.ts` agyCredentialEnv): no self-update mid-session, and a
 * non-empty SSH_TTY so agy keeps its login in files instead of probing a desktop keychain.
 */
const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "1", SSH_TTY: "jabbu-agy-file-auth" };

const STDERR_TAIL_BYTES = 4_000;
/** SIGTERM to SIGKILL grace when a protocol error ends the child (the driver's retire grace). */
const ACP_KILL_GRACE_MS = 2_000;

/** The agy CLI to spawn: a path must be executable, a name is looked up on the child's PATH. */
export function resolveAgyExecutable(given: string, env: Record<string, string>): string {
	if (given.includes("/")) {
		try {
			accessSync(given, constants.X_OK);
			return given;
		} catch (cause) {
			throw new OmpDriverError("agy_executable_missing", `agy executable not found or not executable: ${given}`, {
				cause,
			});
		}
	}
	const found = Bun.which(given, { PATH: env.PATH ?? "" });
	if (!found) throw new OmpDriverError("agy_executable_missing", `agy executable not found on PATH: ${given}`);
	return found;
}

/** `session/new|load` params: the cwd, the MCP servers (read now) and the system prompt agy appends to its own. */
export function acpSessionParams(options: {
	cwd: string;
	systemPrompt?: string | undefined;
	mcpServers?: (() => readonly AgyMcpServer[] | undefined) | undefined;
}): Record<string, unknown> {
	const system = options.systemPrompt;
	return {
		cwd: resolve(options.cwd),
		mcpServers: (options.mcpServers?.() ?? []).map(({ name, command, args, env }) => ({ name, command, args, env })),
		...(system === undefined || system === "" ? {} : { _meta: { antigravity: { systemPrompt: { append: system } } } }),
	};
}

export interface AgyAcpHandlers {
	/** A `session/update` (or other) notification from the child. */
	onNotification(method: string, params: Record<string, unknown>): void;
	/** An agent→client request the client answered by itself (logged by the driver). */
	onRequest?(method: string, params: Record<string, unknown>): void;
	/** The child exited and stdout is drained; every pending request was already rejected. */
	onExit(code: number, stderrTail: string): void;
}

export interface AgyAcpSpawnOptions {
	executable: string;
	cwd: string;
	env: Record<string, string>;
	/** Subdir under `~/.gemini/` passed as `--app-data-dir` to isolate OAuth tokens/logs per account. */
	appDataDir?: string;
	/** Where the answers to permission requests are logged (`agy.acp.permission`); absent → not logged. */
	log?: Logger | undefined;
	/** Origin the child serves; named in those log events. */
	originKey?: string | undefined;
}

interface Pending {
	method: string;
	resolve(result: Record<string, unknown>): void;
	reject(error: unknown): void;
}

export class AgyAcpClient {
	readonly pid: number;
	/** Resolves once the exit was handled (stdout drained, pending requests rejected, `onExit` called). */
	readonly gone: Promise<void>;
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #handlers: AgyAcpHandlers;
	readonly #options: AgyAcpSpawnOptions;
	readonly #pending = new Map<number, Pending>();
	#nextId = 0;
	#stderrTail = "";
	#exited = false;

	constructor(options: AgyAcpSpawnOptions, handlers: AgyAcpHandlers) {
		this.#handlers = handlers;
		this.#options = options;
		const args = [...AGY_ACP_ARGS, ...(options.appDataDir === undefined ? [] : ["--app-data-dir", options.appDataDir])];
		this.#proc = Bun.spawn([options.executable, ...args], {
			cwd: options.cwd,
			env: { ...options.env, ...AGY_ENV },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		this.pid = this.#proc.pid;
		const stdoutClosed = this.#pumpStdout();
		void this.#pumpStderr();
		this.gone = Promise.all([this.#proc.exited, stdoutClosed]).then(([code]) => {
			this.#exited = true;
			const error = new OmpDriverError("rpc_error", `agy acp exited (code=${code})`);
			for (const pending of this.#pending.values()) pending.reject(error);
			this.#pending.clear();
			this.#handlers.onExit(code, this.#stderrTail);
		});
	}

	get stderrTail(): string {
		return this.#stderrTail;
	}

	/** Sends a request; resolves with its `result`, rejects with `rpc_error` on an error reply, exit or `timeoutMs`. */
	request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
		if (this.#exited) return Promise.reject(new OmpDriverError("rpc_error", `agy acp is gone (${method})`));
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		let timer: Timer | undefined;
		const settle =
			<T>(fn: (value: T) => void) =>
			(value: T) => {
				clearTimeout(timer);
				this.#pending.delete(id);
				fn(value);
			};
		this.#pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				this.#pending.get(id)?.reject(new OmpDriverError("rpc_error", `agy acp ${method}: no reply in ${timeoutMs}ms`));
			}, timeoutMs);
		}
		try {
			this.#write({ jsonrpc: "2.0", id, method, params });
		} catch (error) {
			this.#pending.get(id)?.reject(error);
		}
		return promise;
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.#write({ jsonrpc: "2.0", method, params });
	}

	/** Signals the child's whole process group; a group already gone is fine. */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			process.kill(-this.pid, signal);
		} catch {
			try {
				this.#proc.kill(signal);
			} catch {
				// already gone
			}
		}
	}

	/** SIGTERM to the group, SIGKILL after `graceMs`; resolves once the exit was handled. */
	async end(graceMs: number): Promise<void> {
		this.kill("SIGTERM");
		const killer = setTimeout(() => this.kill("SIGKILL"), graceMs);
		await this.gone;
		clearTimeout(killer);
	}

	#write(message: Record<string, unknown>): void {
		try {
			this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
			this.#proc.stdin.flush();
		} catch (cause) {
			throw new OmpDriverError("rpc_error", "agy acp stdin is closed", { cause });
		}
	}

	#handleLine(line: string): void {
		if (line.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return; // plain warnings between frames
		}
		if (!isRecord(message)) return;
		const method = typeof message.method === "string" ? message.method : undefined;
		const params = isRecord(message.params) ? message.params : {};
		if (method !== undefined && message.id !== undefined) {
			this.#answerAgentRequest(message.id, method, params);
			return;
		}
		if (method !== undefined) {
			this.#handlers.onNotification(method, params);
			return;
		}
		const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
		if (pending === undefined) return;
		if (isRecord(message.error)) {
			const code = typeof message.error.code === "number" ? message.error.code : "?";
			const text = typeof message.error.message === "string" ? message.error.message : "error";
			pending.reject(new OmpDriverError("rpc_error", `agy acp ${pending.method} failed (${code}): ${text}`));
			return;
		}
		pending.resolve(isRecord(message.result) ? message.result : {});
	}

	#answerAgentRequest(id: unknown, method: string, params: Record<string, unknown>): void {
		this.#handlers.onRequest?.(method, params);
		try {
			if (method === "session/request_permission") {
				const outcome = permissionOutcome(params);
				const toolCall = recordOf(params.toolCall);
				const title = str(toolCall?.title)?.replace(/\s+/g, " ").trim().slice(0, 200);
				this.#options.log?.info("agy.acp.permission", {
					origin: this.#options.originKey,
					toolCallId: str(toolCall?.toolCallId),
					title,
					outcome: outcome.outcome === "selected" ? `selected:${outcome.optionId}` : "cancelled",
				});
				this.#write({ jsonrpc: "2.0", id, result: { outcome } });
				return;
			}
			this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
		} catch {
			// the child is going away; its exit is reported on its own
		}
	}

	async #pumpStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of this.#proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					this.#handleLine(line);
				}
				// A line still without its newline past the RPC frame cap is never a valid frame: end the child
				// (its exit rejects every pending request and reports `onExit`, like any unexpected death).
				const bytes = Buffer.byteLength(buffer);
				if (bytes > MAX_RPC_FRAME_BYTES) {
					this.#options.log?.warn("agy.acp.line_too_long", { origin: this.#options.originKey, pid: this.pid, bytes });
					void this.end(ACP_KILL_GRACE_MS);
					return;
				}
			}
		} catch {
			// stream closed with the child
		}
		this.#handleLine(buffer);
	}

	async #pumpStderr(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of this.#proc.stderr) {
				this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
			}
		} catch {
			// stream closed with the child
		}
	}
}

// ---- ACP payloads ----

/** One `configOptions` entry (`model`, `thought_level`, `mode`) with its offered values. */
export interface AcpConfigOption {
	id: string;
	currentValue?: string;
	values: string[];
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

/**
 * The answer to `session/request_permission`: its first `allow_once` option, else `cancelled`. The child runs with
 * `--dangerously-skip-permissions`, so a request that still comes (a subagent's) is meant to pass; `allow_always` is
 * never chosen, as agy would keep it as a lasting rule.
 */
function permissionOutcome(params: Record<string, unknown>):
	| { outcome: "selected"; optionId: string }
	| {
			outcome: "cancelled";
	  } {
	const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
	const optionId = str(options.find((option) => option.kind === "allow_once")?.optionId);
	return optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId };
}

/** ACP prompt `usage` → omp `Usage`; agy reports no cost, so `cost` stays unset. */
export function acpUsageOf(value: unknown): OmpUsage | undefined {
	const usage = recordOf(value);
	if (usage === undefined) return undefined;
	const fields = {
		input: num(usage.inputTokens),
		output: num(usage.outputTokens),
		cacheRead: num(usage.cachedReadTokens),
		cacheWrite: num(usage.cachedWriteTokens),
	};
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as OmpUsage;
}

export function configOptionsOf(value: unknown): AcpConfigOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(isRecord).map((option) => ({
		id: str(option.id) ?? "",
		...(str(option.currentValue) === undefined ? {} : { currentValue: str(option.currentValue) }),
		values: (Array.isArray(option.options) ? option.options.filter(isRecord) : []).flatMap((o) => str(o.value) ?? []),
	}));
}

/** Tool output: agy's `rawOutput.output`, else the text of its `content` blocks; undefined when it sent none. */
export function toolOutputOf(update: Record<string, unknown>): string | undefined {
	const raw = recordOf(update.rawOutput);
	if (raw !== undefined && typeof raw.output === "string") return raw.output;
	if (!Array.isArray(update.content)) return undefined;
	const texts = update.content.flatMap((block) => {
		const inner = recordOf(recordOf(block)?.content);
		return inner?.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
	});
	return texts.length === 0 ? undefined : texts.join("\n");
}
