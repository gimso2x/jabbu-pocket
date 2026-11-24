import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgyMcpServer } from "../config-agy";
import type { Logger } from "../log";
import { AgyAcpClient } from "./agy-acp-client";
import { AgyToolKeepalive, type AgyToolKeepaliveOptions } from "./agy-tool-keepalive";
import {
	type OmpCommand,
	type OmpCompactResult,
	OmpDriverError,
	type OmpEntries,
	type OmpEntry,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
	type OmpTurnUsage,
	type OmpUsage,
	type TodoPhase,
} from "./driver";
import { buildChildEnv } from "./env";
import { isRecord } from "./type-guards";

/*
 * Boundary between ompbot and one Antigravity CLI ACP child (`agy acp`, see `agy-acp-client.ts`), one per origin.
 *
 * Start: `initialize`, then `session/resume` of the pointer's session (`<sessionDir>/agy-conversation.json`; resume
 * replays nothing, unlike `session/load`) or `session/new` when there is none or agy refuses it. Both carry the system
 * prompt (`_meta.antigravity.systemPrompt.append`) and the configured MCP servers. Then `session/set_config_option`
 * sets `model` and `thought_level`; a value agy does not take fails the start. A model without a `thought_level`
 * option (the orchestrators) runs without one, as the `-p` driver ran them without an effort suffix.
 *
 * Turn: `session/prompt`; its `session/update` notifications become omp events (accumulated `message_update`, tool
 * start/end), its reply (`stopReason`, `usage`) the final. Text steered meanwhile is held and sent as the next
 * `session/prompt` of the same turn. Abort: `session/cancel`; agy answers the prompt `cancelled` and lives on. With no
 * answer in `cancelTimeoutMs` the child's process group is killed (no `onExit`), and the next prompt resumes.
 *
 * Rotation: agy cannot compact here. `usage_update {used, size}` tells the context use; a turn that ends at or over
 * `AGY_ROTATE_RATIO` of `size` drops the pointer and the child, and its final says `usage.rotated`.
 */

export const AGY_PROVIDER = "agy";
/** `thought_level` values of agy 1.5.16; a model may offer fewer, or none. */
export const AGY_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
/** Share of the context window at which a conversation is rotated after its turn ends. */
export const AGY_ROTATE_RATIO = 0.7;

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const STOP_GRACE_MS = 5_000;
/** Updates that only refresh state; any other kind is debug-logged once. */
const QUIET_UPDATES: Record<string, true> = {
	available_commands_update: true,
	session_info_update: true,
	current_mode_update: true,
	user_message_chunk: true,
	plan: true,
};

export interface AgyOmpDriverOptions {
	/** Path or name of the agy CLI; names resolve on the child PATH. */
	agyExecutable: string;
	cwd: string;
	/** ompbot-owned per-origin-epoch directory; holds the `agy-conversation.json` resume pointer. */
	sessionDir: string;
	/** agy model id without provider prefix; an effort suffix agy's options lack is cut and read as the thinking level. */
	model?: string;
	/** `thought_level` to set (`low|medium|high|xhigh`); other values are ignored. */
	thinking?: string;
	/** Extra child env; `SLACK_`/`OMPBOT_` keys are rejected like every driver. */
	env?: Record<string, string>;
	/** Floors + persona text, appended to agy's system prompt of every session. */
	systemPrompt?: string;
	/** MCP servers each `session/new|resume` passes; read at every start (a reload applies from the next one). */
	mcpServers?: () => readonly AgyMcpServer[] | undefined;
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/** How long each start request (`initialize`, session, config) may take. */
	startupTimeoutMs?: number;
	/** How long an abort waits for agy's `cancelled` reply before killing the child. */
	cancelTimeoutMs?: number;
	/** Where an unsupported `setTodos`, a rotation and the ACP lifecycle are reported; absent → not reported. */
	log?: Logger;
	/** Origin the driver serves; named in its log events. */
	originKey?: string;
	/** Tool-execution keepalive timer overrides (tests); defaults to 60 s interval up to 8 min. */
	toolKeepalive?: AgyToolKeepaliveOptions;
}

interface PendingTurn {
	opRef: string;
	abortRequested: boolean;
	/** Token sums over the turn's prompts (one model call each), steered follow-ups included. */
	usage: OmpTurnUsage;
	/** Answer text of the running `session/prompt`. */
	text: string;
	/** Resolves when the turn ended (its final went out, or its child died). */
	settled: PromiseWithResolvers<void>;
	finished: boolean;
}

interface ConfigOption {
	id: string;
	currentValue?: string;
	values: string[];
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const isThinkingLevel = (level: string): boolean => (AGY_THINKING_LEVELS as readonly string[]).includes(level);

/** ACP prompt `usage` → omp `Usage`; agy reports no cost, so `cost` stays unset. */
function usageOf(value: unknown): OmpUsage | undefined {
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

/** The final's `usage`: absent when the turn made no model call. */
const usageField = (turn: PendingTurn): { usage?: OmpTurnUsage } =>
	turn.usage.calls === 0 ? {} : { usage: { ...turn.usage } };

function configOptionsOf(value: unknown): ConfigOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(isRecord).map((option) => ({
		id: str(option.id) ?? "",
		...(str(option.currentValue) === undefined ? {} : { currentValue: str(option.currentValue) }),
		values: (Array.isArray(option.options) ? option.options.filter(isRecord) : []).flatMap((o) => str(o.value) ?? []),
	}));
}

/** Tool output: agy's `rawOutput.output`, else the text of its `content` blocks; undefined when it sent none. */
function toolOutputOf(update: Record<string, unknown>): string | undefined {
	const raw = recordOf(update.rawOutput);
	if (raw !== undefined && typeof raw.output === "string") return raw.output;
	if (!Array.isArray(update.content)) return undefined;
	const texts = update.content.flatMap((block) => {
		const inner = recordOf(recordOf(block)?.content);
		return inner?.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
	});
	return texts.length === 0 ? undefined : texts.join("\n");
}

export class AgyOmpDriver implements OmpSessionDriver {
	readonly #options: AgyOmpDriverOptions;
	readonly #pointerPath: string;
	readonly #toolKeepalive: AgyToolKeepalive;
	#started = false;
	#stopping = false;
	#client: AgyAcpClient | undefined;
	/** The child being started: its death fails the start instead of reaching `onExit`. */
	#launching: AgyAcpClient | undefined;
	/** Children this driver ended on purpose: their exit is no crash. */
	readonly #ended = new WeakSet<AgyAcpClient>();
	/** Entries of the CURRENT child only: cleared on every (re)spawn, cursors before it become `unknown_since`. */
	#entries: OmpEntry[] = [];
	#entrySeq = 0;
	#turn: PendingTurn | undefined;
	/** Steered texts held until the running prompt's reply; sent together as the turn's next prompt. */
	#queued: string[] = [];
	#sessionId: string | undefined;
	/** True while the live child resumed the session it was asked to (what `openSession().resumed` reports). */
	#resumedCurrent = false;
	/** Model chosen by config or `/model`, as given; unset = agy's own default. */
	#model: string | undefined;
	/** Thinking level chosen by config or `/thinking` (or read off the model's effort suffix). */
	#thinking: string | undefined;
	#configOptions: ConfigOption[] = [];
	/** Latest `usage_update` of the live session. */
	#context: { used: number; size: number } | undefined;
	/** Tool calls of the live child: open until their `completed|failed` update. */
	readonly #tools = new Map<string, "open" | "done">();
	readonly #unknownUpdates = new Set<string>();
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	/** Set while `#spawn` replaces the child: a prompt meanwhile waits for the new child instead of spawning its own. */
	#respawning: Promise<void> | undefined;

	constructor(options: AgyOmpDriverOptions) {
		this.#options = options;
		this.#pointerPath = join(resolve(options.sessionDir), "agy-conversation.json");
		this.#toolKeepalive = new AgyToolKeepalive((event) => {
			if (this.#client !== undefined && this.#turn !== undefined) this.#emit(event);
		}, options.toolKeepalive);
		this.#model = options.model === "" ? undefined : options.model;
		const thinking = options.thinking;
		this.#thinking = thinking !== undefined && isThinkingLevel(thinking) ? thinking : undefined;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#client?.pid;
	}

	async start(): Promise<void> {
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		this.#resolveExecutable(buildChildEnv(this.#options.env, this.#options.baseEnv));
		mkdirSync(resolve(this.#options.cwd), { recursive: true });
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		this.#started = true;
		await this.#bindPinnedConversation();
	}

	async prompt(text: string): Promise<string> {
		this.#requireStarted();
		await this.#ensureChild();
		const client = this.#client;
		if (client === undefined) throw new OmpDriverError("rpc_error", "agy child is not running");
		if (this.#turn) throw new OmpDriverError("rpc_error", "a turn is already running");
		const opRef = `agy-${Date.now().toString(36)}-${++this.#entrySeq}`;
		const turn: PendingTurn = {
			opRef,
			abortRequested: false,
			usage: { calls: 0, input: 0, cacheRead: 0, output: 0, rotated: false },
			text: "",
			settled: Promise.withResolvers<void>(),
			finished: false,
		};
		this.#turn = turn;
		this.#sendPrompt(client, turn, text);
		return opRef;
	}

	/** Text written mid-turn is held and sent as the next `session/prompt` once the running one replies (same opRef). */
	async steer(text: string): Promise<void> {
		this.#requireStarted();
		if (this.#turn === undefined) throw new OmpDriverError("rpc_error", "no turn is running to steer");
		this.#queued.push(text);
	}

	/**
	 * `session/cancel`; agy replies `cancelled` to the prompt and keeps running. No reply within `cancelTimeoutMs`:
	 * the child's process group is killed without an `onExit`. Either way no turn runs once this returns.
	 */
	async abort(): Promise<void> {
		this.#requireStarted();
		const turn = this.#turn;
		const client = this.#client;
		if (!turn || !client) return;
		this.#toolKeepalive.clear();
		turn.abortRequested = true;
		this.#queued = [];
		try {
			client.notify("session/cancel", { sessionId: this.#sessionId });
		} catch {
			// a closed stdin: the kill below ends the turn
		}
		const unanswered = Promise.withResolvers<false>();
		const timer = setTimeout(
			() => unanswered.resolve(false),
			this.#options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
		);
		const answered = await Promise.race([turn.settled.promise.then(() => true), unanswered.promise]);
		clearTimeout(timer);
		if (answered) return;
		this.#options.log?.warn("agy.acp.abort_killed", { origin: this.#options.originKey, pid: client.pid });
		if (this.#client === client) this.#client = undefined;
		await this.#endClient(client, KILL_GRACE_MS);
		this.#finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error: "cancel unanswered; agy killed" });
	}

	/** `/new`: drop the resume pointer and restart on a new session. */
	async newSession(): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		this.#clearPointer();
		this.#sessionId = undefined;
		if (this.#client) await this.#spawn(undefined, "new session");
		return { cancelled: false };
	}

	async openSession(): Promise<OmpOpenResult> {
		this.#requireStarted();
		await this.#bindPinnedConversation();
		return { resumed: this.#resumedCurrent, sessionId: this.#sessionId ?? "" };
	}

	/** Binds the session the pointer names: restarts on it when the live child holds another one. */
	async #bindPinnedConversation(): Promise<void> {
		const pointer = this.#readPointer();
		if (pointer !== undefined && (pointer !== this.#sessionId || !this.#client)) {
			await this.#spawn(pointer, "conversation rebind");
			return;
		}
		await this.#ensureChild();
	}

	/** Resumes the agy session named by `sessionFile` (a session id, or a path ending in one). */
	async switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		const stem =
			sessionFile
				.replace(/\.(jsonl?|pb)$/, "")
				.split(/[/\\]/)
				.at(-1) ?? "";
		if (!/^[\w-]{8,}$/.test(stem)) {
			throw new OmpDriverError("rpc_error", `not an agy conversation id: ${sessionFile}`);
		}
		this.#writePointer(stem);
		await this.#spawn(stem, "session switch");
		return { cancelled: false };
	}

	/** The live session's `model` option values, as `agy/<id>`. */
	async availableModels(): Promise<string[]> {
		if (this.#started) await this.#ensureChild();
		return (this.#option("model")?.values ?? []).map((id) => `${AGY_PROVIDER}/${id}`);
	}

	/** `session/set_config_option model` on the live session (no restart); the thinking level is set again after it. */
	async setModel(model: string): Promise<string> {
		this.#requireStarted();
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) {
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		}
		if (model.slice(0, slash) !== AGY_PROVIDER || !(await this.availableModels()).includes(model)) {
			throw new OmpDriverError("rpc_error", `Model not found: ${model}`);
		}
		const id = model.slice(slash + 1);
		this.#model = id;
		const client = this.#client;
		if (client !== undefined) await this.#applyConfig(client);
		return `${AGY_PROVIDER}/${id}`;
	}

	/** The levels the live model offers (`thought_level`); none for a model without it. */
	async thinkingLevels(): Promise<string[]> {
		if (this.#started) await this.#ensureChild();
		return [...(this.#option("thought_level")?.values ?? [])];
	}

	/** An agy conversation has no omp extension commands. */
	availableCommands(): Promise<OmpCommand[]> {
		return Promise.resolve([]);
	}

	/** agy has no omp task list: nothing is planted (a lane's prompt still carries its acceptance criteria). */
	async setTodos(phases: TodoPhase[]): Promise<void> {
		this.#options.log?.info("set_todos_unsupported", { driver: "agy", phases: phases.length });
	}

	/** `session/set_config_option thought_level` on the live session (no restart). */
	async setThinking(level: string): Promise<void> {
		this.#requireStarted();
		if (!isThinkingLevel(level)) throw new OmpDriverError("rpc_error", `Model not found: thinking ${level}`);
		await this.#ensureChild();
		const client = this.#client;
		if (client === undefined) throw new OmpDriverError("rpc_error", "agy child is not running");
		if (!this.#option("thought_level")?.values.includes(level)) {
			const model = this.#option("model")?.currentValue ?? "?";
			throw new OmpDriverError(
				"rpc_error",
				`Model not found: thinking ${level} (agy model ${model} does not offer it)`,
			);
		}
		await this.#setOption(client, "thought_level", level);
		this.#thinking = level;
	}

	compact(): Promise<OmpCompactResult> {
		return Promise.reject(new OmpDriverError("rpc_error", "agy 세션은 compact를 지원하지 않습니다"));
	}

	async state(): Promise<OmpState> {
		const model = this.#option("model")?.currentValue ?? this.#model;
		const thinking = this.#option("thought_level")?.currentValue;
		return {
			sessionId: this.#sessionId ?? "",
			idle: this.#turn === undefined,
			settled: this.#turn === undefined,
			queuedMessageCount: this.#queued.length,
			messageCount: this.#entries.length,
			...(model === undefined ? {} : { model: `${AGY_PROVIDER}/${model}` }),
			...(thinking === undefined ? {} : { thinking }),
		};
	}

	async leafId(): Promise<string | null> {
		return this.#entries.at(-1)?.id ?? null;
	}

	async entriesSince(since?: string): Promise<OmpEntries> {
		const leafId = this.#entries.at(-1)?.id ?? null;
		if (since === undefined) return { entries: [...this.#entries], leafId };
		const index = this.#entries.findIndex((entry) => entry.id === since);
		if (index === -1) throw new OmpDriverError("unknown_since", `no such entry: ${since}`);
		return { entries: this.#entries.slice(index + 1), leafId };
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		this.#finalListeners.add(listener);
		return () => this.#finalListeners.delete(listener);
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	async stop(): Promise<void> {
		this.#started = false;
		this.#toolKeepalive.clear();
		this.#turn = undefined;
		this.#queued = [];
		await this.#respawning;
		const client = this.#client;
		this.#stopping = true;
		this.#client = undefined;
		if (client) await this.#endClient(client, STOP_GRACE_MS);
	}

	/** Ends a child on purpose (its exit is no crash): SIGTERM to its group, SIGKILL after `graceMs`. */
	#endClient(client: AgyAcpClient, graceMs: number): Promise<void> {
		this.#ended.add(client);
		return client.end(graceMs);
	}

	// ---- child lifecycle ----

	#requireStarted(): void {
		if (!this.#started) throw new OmpDriverError("not_started", "driver not started");
	}

	/** Starts a child when none is live, resuming the current session (after an abort kill, a rotation or a crash). */
	async #ensureChild(): Promise<void> {
		while (this.#respawning) await this.#respawning;
		if (!this.#client) await this.#spawn(this.#sessionId, "child restart");
	}

	#resolveExecutable(env: Record<string, string>): string {
		const given = this.#options.agyExecutable;
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

	/**
	 * Ends the current child (if any) and waits for its exit, so two agy processes never hold one session, then starts
	 * a new one on `resume` (or a new session). A turn still running ends `aborted` (`reason` in the error) once the new
	 * child is up or failed to start, so a prompt sent on that final reaches the new child.
	 */
	async #spawn(resume: string | undefined, reason: string): Promise<void> {
		// One replacement at a time: a second one started meanwhile would launch beside the first one's new child.
		while (this.#respawning) await this.#respawning;
		const env = buildChildEnv(this.#options.env, this.#options.baseEnv);
		const executable = this.#resolveExecutable(env);
		const previous = this.#client;
		const cut = this.#turn;
		const dropped = this.#queued.length;
		this.#turn = undefined;
		this.#queued = [];
		const done = Promise.withResolvers<void>();
		this.#respawning = done.promise;
		try {
			if (previous) {
				this.#client = undefined;
				await this.#endClient(previous, KILL_GRACE_MS);
			}
			// `stop()` while waiting (a retire or the old child's exit) must not be undone by a child launched after it.
			if (!this.#started) throw new OmpDriverError("not_started", "driver stopped while agy restarted");
			await this.#launch(executable, env, resume);
		} finally {
			if (this.#respawning === done.promise) this.#respawning = undefined;
			done.resolve();
			if (cut !== undefined) {
				const steer = dropped > 0 ? ` (steer ${dropped}건 미전달)` : "";
				this.#finish(cut, {
					opRef: cut.opRef,
					status: "aborted",
					text: "",
					error: `agy restarted (${reason})${steer}`,
				});
			}
		}
	}

	async #launch(executable: string, env: Record<string, string>, resume: string | undefined): Promise<void> {
		const options = this.#options;
		this.#entries = [];
		this.#tools.clear();
		this.#configOptions = [];
		this.#context = undefined;
		this.#resumedCurrent = false;
		this.#stopping = false;
		const client: AgyAcpClient = new AgyAcpClient(
			{ executable, cwd: resolve(options.cwd), env },
			{
				onNotification: (method, params) => {
					if (client === this.#client && method === "session/update") this.#onUpdate(params);
				},
				onRequest: (method) => options.log?.info("agy.acp.agent_request", { origin: options.originKey, method }),
				onExit: (code, stderr) => this.#onChildExit(client, code, stderr),
			},
		);
		this.#client = client;
		this.#launching = client;
		const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		try {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, timeoutMs);
			let opened: Record<string, unknown> | undefined;
			if (resume !== undefined) {
				try {
					opened = await client.request("session/resume", { sessionId: resume, ...this.#sessionParams() }, timeoutMs);
					this.#sessionId = resume;
					this.#resumedCurrent = true;
				} catch (error) {
					options.log?.warn("agy.acp.resume_failed", {
						origin: options.originKey,
						sessionId: resume,
						error: String(error),
					});
				}
			}
			if (opened === undefined) {
				opened = await client.request("session/new", this.#sessionParams(), timeoutMs);
				const sessionId = str(opened.sessionId);
				if (sessionId === undefined) throw new OmpDriverError("rpc_error", "agy session/new without a sessionId");
				this.#sessionId = sessionId;
			}
			this.#writePointer(this.#sessionId ?? "");
			this.#configOptions = configOptionsOf(opened.configOptions) ?? [];
			await this.#applyConfig(client);
			options.log?.info("agy.acp.started", {
				origin: options.originKey,
				pid: client.pid,
				sessionId: this.#sessionId,
				resumed: this.#resumedCurrent,
			});
		} catch (error) {
			if (this.#client === client) this.#client = undefined;
			await this.#endClient(client, KILL_GRACE_MS);
			const stderr = client.stderrTail.trim().slice(-400);
			throw new OmpDriverError("rpc_error", `agy acp start failed: ${String(error)}${stderr ? ` | ${stderr}` : ""}`, {
				cause: error,
			});
		} finally {
			if (this.#launching === client) this.#launching = undefined;
		}
	}

	#sessionParams(): Record<string, unknown> {
		const system = this.#options.systemPrompt;
		return {
			cwd: resolve(this.#options.cwd),
			mcpServers: (this.#options.mcpServers?.() ?? []).map(({ name, command, args, env }) => ({
				name,
				command,
				args,
				env,
			})),
			...(system === undefined || system === ""
				? {}
				: { _meta: { antigravity: { systemPrompt: { append: system } } } }),
		};
	}

	#option(id: string): ConfigOption | undefined {
		return this.#configOptions.find((option) => option.id === id);
	}

	/**
	 * Sets the chosen model, then the thinking level when the model offers `thought_level`. A configured id that is not
	 * an option but is one without its effort suffix (`gemini-3.8-flash-high`) runs as that model at that level.
	 */
	async #applyConfig(client: AgyAcpClient): Promise<void> {
		let level = this.#thinking;
		if (this.#model !== undefined) {
			let id = this.#model;
			const values = this.#option("model")?.values ?? [];
			const bare = id.replace(EFFORT_SUFFIX, "");
			if (!values.includes(id) && bare !== id && values.includes(bare)) {
				level ??= EFFORT_SUFFIX.exec(id)?.[1];
				id = bare;
			}
			await this.#setOption(client, "model", id);
		}
		if (level === undefined) return;
		if (this.#option("thought_level") === undefined) {
			const model = this.#option("model")?.currentValue;
			this.#options.log?.info("agy.acp.thinking_unsupported", { origin: this.#options.originKey, model, level });
			return;
		}
		await this.#setOption(client, "thought_level", level);
	}

	/** `session/set_config_option`; a reply whose `currentValue` is not `value` counts as refused. */
	async #setOption(client: AgyAcpClient, configId: string, value: string): Promise<void> {
		const result = await client.request(
			"session/set_config_option",
			{ sessionId: this.#sessionId, configId, value },
			this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
		);
		const options = configOptionsOf(result.configOptions);
		if (options !== undefined) this.#configOptions = options;
		const current = this.#option(configId)?.currentValue;
		if (current !== value) {
			throw new OmpDriverError("rpc_error", `agy did not apply ${configId}=${value} (now ${current ?? "unset"})`);
		}
	}

	#onChildExit(client: AgyAcpClient, code: number, stderr: string): void {
		if (this.#ended.has(client) || this.#launching === client || this.#client !== client) return;
		this.#client = undefined;
		this.#toolKeepalive.clear();
		// The dead turn gets no final (the mailbox fails it on `onExit`); an abort waiting on it returns.
		const turn = this.#turn;
		if (turn !== undefined) {
			turn.finished = true;
			turn.settled.resolve();
		}
		this.#turn = undefined;
		this.#queued = [];
		if (!this.#stopping) {
			const info: OmpExitInfo = { code, expected: false, stderr };
			for (const listener of this.#exitListeners) listener(info);
		}
	}

	// ---- session updates ----

	#onUpdate(params: Record<string, unknown>): void {
		if (params.sessionId !== this.#sessionId) return;
		const update = recordOf(params.update) ?? {};
		const kind = str(update.sessionUpdate) ?? "";
		switch (kind) {
			case "agent_message_chunk": {
				const content = recordOf(update.content);
				const turn = this.#turn;
				if (turn === undefined || content?.type !== "text" || typeof content.text !== "string") return;
				turn.text += content.text;
				this.#emit({
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text: turn.text }] },
				});
				return;
			}
			case "tool_call":
			case "tool_call_update":
				this.#onTool(update);
				return;
			case "usage_update": {
				const used = num(update.used);
				const size = num(update.size);
				if (used !== undefined && size !== undefined) this.#context = { used, size };
				return;
			}
			case "config_option_update": {
				const options = configOptionsOf(update.configOptions);
				if (options !== undefined) this.#configOptions = options;
				return;
			}
			// The `-p` driver emitted no thinking either.
			case "agent_thought_chunk":
				return;
			default:
				if (QUIET_UPDATES[kind] || this.#unknownUpdates.has(kind)) return;
				this.#unknownUpdates.add(kind);
				this.#options.log?.debug("agy.acp.unknown_update", { origin: this.#options.originKey, kind });
		}
	}

	/** Tool calls become omp-style toolCall/toolResult entries and tool events (the mailbox's status lines). */
	#onTool(update: Record<string, unknown>): void {
		if (this.#turn === undefined) return;
		const callId = str(update.toolCallId) ?? `agy-tool-${this.#entrySeq}`;
		const name = str(update.name) ?? str(update.title) ?? "tool";
		const args = update.rawInput ?? update.args ?? {};
		const model = this.#option("model")?.currentValue;
		if (!this.#tools.has(callId)) {
			this.#tools.set(callId, "open");
			this.#entries.push({
				id: `ag-${++this.#entrySeq}`,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name, arguments: args }],
					stopReason: "toolUse",
					provider: AGY_PROVIDER,
					...(model === undefined ? {} : { model }),
				},
			});
			this.#toolKeepalive.start(callId, name);
			this.#emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
		}
		const status = update.status;
		if (this.#tools.get(callId) !== "open" || (status !== "completed" && status !== "failed")) return;
		this.#tools.set(callId, "done");
		// A tool without output (edit_file names only its path) ends with no `result`, so the loop detector does not
		// take different edits of one file for a repeat.
		const output = toolOutputOf(update);
		this.#entries.push({
			id: `ag-${++this.#entrySeq}`,
			type: "message",
			toolCallId: callId,
			toolName: name,
			message: { role: "toolResult", content: [{ type: "text", text: output ?? "" }] },
		});
		this.#toolKeepalive.end(callId);
		this.#emit({
			type: "tool_execution_end",
			toolCallId: callId,
			toolName: name,
			result: output,
			...(status === "failed" ? { isError: true } : {}),
		});
	}

	// ---- prompts ----

	/** Records the user entry and sends one `session/prompt`; its reply continues or ends the turn. */
	#sendPrompt(client: AgyAcpClient, turn: PendingTurn, text: string): void {
		turn.text = "";
		this.#entries.push({ id: `ag-${++this.#entrySeq}`, type: "message", message: { role: "user", content: text } });
		client.request("session/prompt", { sessionId: this.#sessionId, prompt: [{ type: "text", text }] }).then(
			(result) => this.#onPromptReply(client, turn, result, undefined),
			(error: unknown) => this.#onPromptReply(client, turn, undefined, error),
		);
	}

	#onPromptReply(
		client: AgyAcpClient,
		turn: PendingTurn,
		result: Record<string, unknown> | undefined,
		failure: unknown,
	): void {
		// A child ended on purpose (abort kill, restart) leaves the turn's end to whoever ended it.
		if (this.#turn !== turn || this.#ended.has(client)) return;
		this.#toolKeepalive.clear();
		const usage = usageOf(result?.usage);
		if (usage !== undefined) {
			turn.usage.calls += 1;
			turn.usage.input += usage.input ?? 0;
			turn.usage.cacheRead += usage.cacheRead ?? 0;
			turn.usage.output += usage.output ?? 0;
		}
		const stopReason = str(result?.stopReason);
		const succeeded = stopReason === "end_turn";
		const model = this.#option("model")?.currentValue;
		if (turn.text.trim() !== "" || usage !== undefined) {
			this.#entries.push({
				id: `ag-${++this.#entrySeq}`,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: turn.text }],
					stopReason: succeeded ? "stop" : "error",
					provider: AGY_PROVIDER,
					...(model === undefined ? {} : { model }),
					...(usage === undefined ? {} : { usage }),
				},
			});
		}
		// Steered text is answered as part of the same turn: the opRef stays open until that answer arrives.
		if (succeeded && !turn.abortRequested && this.#queued.length > 0 && this.#client === client) {
			const queued = this.#queued.join("\n\n");
			this.#queued = [];
			this.#sendPrompt(client, turn, queued);
			return;
		}
		const dropped = this.#queued.length;
		const status: OmpFinal["status"] =
			turn.abortRequested || stopReason === "cancelled" ? "aborted" : succeeded ? "completed" : "error";
		let error =
			status === "completed"
				? undefined
				: failure !== undefined
					? failure instanceof Error
						? failure.message
						: String(failure)
					: status === "aborted"
						? "cancelled"
						: `agy turn ended with stopReason ${stopReason ?? "none"}`;
		if (error !== undefined && dropped > 0) error = `${error} (steer ${dropped}건 미전달)`;
		if (this.#context !== undefined) turn.usage.contextTokens = this.#context.used;
		// Before the final: a prompt sent on it must already find the conversation dropped.
		turn.usage.rotated = this.#rotateIfFull();
		this.#finish(turn, { opRef: turn.opRef, status, text: turn.text, ...(error === undefined ? {} : { error }) });
	}

	/** Ends `turn` once (a turn a restart cut off too): clears it and the queue, sends its final, wakes an abort. */
	#finish(turn: PendingTurn, final: Omit<OmpFinal, "usage">): void {
		if (turn.finished) return;
		turn.finished = true;
		if (this.#turn === turn) {
			this.#turn = undefined;
			this.#queued = [];
		}
		for (const listener of this.#finalListeners) listener({ ...final, ...usageField(turn) });
		turn.settled.resolve();
	}

	/**
	 * Between turns only: a session at or over the rotation share of its window drops its pointer, its id and its
	 * child, so `#ensureChild` starts the next turn on a new session.
	 */
	#rotateIfFull(): boolean {
		const context = this.#context;
		if (context === undefined || context.size <= 0 || context.used < context.size * AGY_ROTATE_RATIO) return false;
		const sessionId = this.#sessionId;
		this.#clearPointer();
		this.#sessionId = undefined;
		this.#retireChild();
		this.#options.log?.info("agy_conversation_rotated", {
			origin: this.#options.originKey,
			conversationId: sessionId,
			contextTokens: context.used,
			window: context.size,
		});
		return true;
	}

	/** Ends the live child without a replacement; a prompt meanwhile waits for its exit, then starts a new one. */
	#retireChild(): void {
		this.#toolKeepalive.clear();
		const client = this.#client;
		if (!client) return;
		this.#client = undefined;
		const retired: Promise<void> = this.#endClient(client, KILL_GRACE_MS).finally(() => {
			if (this.#respawning === retired) this.#respawning = undefined;
		});
		this.#respawning = retired;
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	// ---- session pointer ----

	/** The pinned session id; a pointer the `-p` driver left (a conversation id) is tried the same way. */
	#readPointer(): string | undefined {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#pointerPath, "utf8"));
			return isRecord(parsed) ? str(parsed.conversationId) : undefined;
		} catch {
			return undefined;
		}
	}

	#writePointer(sessionId: string): void {
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		writeFileSync(this.#pointerPath, `${JSON.stringify({ conversationId: sessionId })}\n`);
	}

	#clearPointer(): void {
		rmSync(this.#pointerPath, { force: true });
	}
}
