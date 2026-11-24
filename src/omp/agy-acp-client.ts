import { OmpDriverError } from "./driver";
import { isRecord } from "./type-guards";

/*
 * One `agy acp` child and its JSON-RPC 2.0 wire (agy 1.5.16, both directions one message per line).
 * - out requests `initialize`, `session/new|resume`, `session/set_config_option`, `session/prompt`; out notification
 *   `session/cancel`.
 * - in  responses (paired by `id`), `session/update` notifications, and agent→client requests: `session/request_permission`
 *   is answered `allow_once` (the child runs with `--dangerously-skip-permissions`, so it should never ask), any other
 *   request gets JSON-RPC "method not found".
 * The child leads its own process group: `kill` signals the whole group, so the shells and MCP servers agy started
 * go with it.
 */

/** The child's arguments after the executable: ACP over stdio, no telemetry, tools without prompts. */
export const AGY_ACP_ARGS = ["acp", "--disable-telemetry", "--dangerously-skip-permissions"] as const;

const STDERR_TAIL_BYTES = 4_000;

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
	readonly #pending = new Map<number, Pending>();
	#nextId = 0;
	#stderrTail = "";
	#exited = false;

	constructor(options: AgyAcpSpawnOptions, handlers: AgyAcpHandlers) {
		this.#handlers = handlers;
		this.#proc = Bun.spawn([options.executable, ...AGY_ACP_ARGS], {
			cwd: options.cwd,
			env: options.env,
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
				const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
				const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
				const optionId = typeof allow?.optionId === "string" ? allow.optionId : "allow_once";
				this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
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
