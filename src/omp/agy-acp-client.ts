import { OmpDriverError, type OmpUsage } from "./driver";
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

// agy retries quota failures itself and reports each attempt only as a line of agent text. Regexes copied from omp
// (oh-my-pi eca7acfa45, MIT, `packages/ai/src/providers/antigravity-cli/host.ts` RETRY_NOTICE…NOTICE_ATTEMPT).
const RETRY_NOTICE = /(?:^|\n)[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?API error \(attempt \d+\):[^\S\n]*([^\n]+)/;
const QUOTA_EXHAUSTED = /\bRESOURCE_EXHAUSTED\b|\bcode 429\b/;
const NOTICE_MARK = /^[^\S\n]*(?:⚠\uFE0F?[^\S\n]*)?/;
const NOTICE_HEAD = "API error (attempt ";
const NOTICE_ATTEMPT = /^\d*$|^\d+\)(?::.*)?$/;

/** The quota detail of an agy retry notice in `text` ("RESOURCE_EXHAUSTED (code 429): …"), else undefined. */
export function quotaRetryNotice(text: string): string | undefined {
	const detail = RETRY_NOTICE.exec(text)?.[1]?.trim();
	return detail && QUOTA_EXHAUSTED.test(detail) ? detail : undefined;
}

/** True when an agy error/text directly indicates a 429 / RESOURCE_EXHAUSTED quota failure. */
export function isQuotaErrorText(text: string): boolean {
	return QUOTA_EXHAUSTED.test(text);
}

/** `text` minus an unfinished last line that may still turn into a retry notice (omp withholds it the same way). */
export function shownText(text: string): string {
	const lineStart = text.lastIndexOf("\n") + 1;
	const rest = text.slice(lineStart).replace(NOTICE_MARK, "");
	const pending =
		rest.length < NOTICE_HEAD.length
			? NOTICE_HEAD.startsWith(rest)
			: rest.startsWith(NOTICE_HEAD) && NOTICE_ATTEMPT.test(rest.slice(NOTICE_HEAD.length));
	return pending ? text.slice(0, lineStart) : text;
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
				this.#write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
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
