import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../log";
import type { HostToolDef } from "../safety/host-tools";
import {
	type OmpCommand,
	type OmpCompactResult,
	type OmpDialogAnswerer,
	OmpDriverError,
	type OmpEntries,
	type OmpEvent,
	type OmpExitInfo,
	type OmpFinal,
	type OmpOpenResult,
	type OmpSessionDriver,
	type OmpState,
	type TodoPhase,
} from "./driver";
import { buildChildEnv } from "./env";
import {
	type BtwRecord,
	OmpRpcClient,
	type PromptResultFrame,
	type RpcChild,
	RpcCommandError,
	type RpcProtocolError,
	type RpcSpawnOptions,
} from "./rpc-client";
import { ExtensionUiTap } from "./rpc-ui-tap";
import { checkOmpRuntime } from "./runtime-check";
import { isRecord } from "./type-guards";

/** How long a side question may take, counted from the `btw` command. */
export const BTW_TIMEOUT_MS = 120_000;

/**
 * Longest silence (no omp event) a turn waits after a `prompt_result` with `sessionSettled:false` before it ends
 * anyway (`tail_wait_timeout`, a normal end). Shorter than the monitor abort line `MONITOR_STALL_ABORT_MS` (20 min)
 * and the owner stall notice `STALL_NOTIFY_MS` (30 min): the wait is not counted as a stall, so it must end first.
 */
export const TAIL_WAIT_MS = 15 * 60 * 1000;

/** How often the wait asks `get_state` whether the session settled, for an omp that sends no `session_settled`. */
export const TAIL_POLL_MS = 10_000;

/**
 * Driver events (not omp's) around that wait: the turn is waiting for runs the prompt left behind, so its silence is
 * no stall (`mailbox.ts` `checkStall`); the end event comes right before the turn's final, or with an abort.
 */
export const TAIL_WAIT_START_EVENT = "tail_wait_start";
export const TAIL_WAIT_END_EVENT = "tail_wait_end";

/**
 * Session-only omp events jabbu reads. `auto_retry_end` is here because a retry whose delay exceeds
 * `retry.maxDelayMs` with no fallback ends with `finalError` and no `auto_retry_start` before it.
 */
const FORWARDED_SESSION_EVENTS: ReadonlySet<string> = new Set([
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
]);

function listen<T>(s: Set<T>, f: T): () => void {
	s.add(f);
	return () => s.delete(f);
}

/** A finite number of at least `min`, else undefined. */
function countOf(value: unknown, min: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

/**
 * `OmpState.context` from omp's `contextUsage`: nothing without a positive window (an unknown model), `tokens`/`percent`
 * null when omp sends no number (right after a compaction it does not know them yet).
 */
function contextOf(usage: unknown): Pick<OmpState, "context"> {
	if (!isRecord(usage)) return {};
	const window = countOf(usage.contextWindow, 1);
	if (window === undefined) return {};
	const tokens = countOf(usage.tokens, 0) ?? null;
	return { context: { tokens, window, percent: tokens === null ? null : (countOf(usage.percent, 0) ?? null) } };
}

export interface RpcOmpDriverOptions {
	/** The omp executable (`JABBU_OMP_EXECUTABLE`): the package's `dist/cli.js` or the standalone binary. */
	ompExecutable: string;
	cwd: string;
	sessionDir: string;
	provider?: string;
	model?: string;
	thinking?: string;
	/** jabbu-owned `--config` overlay file, only when needed. */
	overlayConfig?: string;
	/** Extra child env, e.g. `{ OMP_WIKI_NOTE_DISABLE: "1" }`. `SLACK_`/`JABBU_` keys are rejected. */
	env?: Record<string, string>;
	extraArgs?: string[];
	/** Host tools registered with `set_host_tools` on start (executed by this process). */
	hostTools?: HostToolDef[];
	/** Parent environment source (tests); default `process.env`. */
	baseEnv?: Record<string, string | undefined>;
	/**
	 * Owner answers to omp's select/confirm/input/editor/ask dialogs (chat cards). With it the driver opts in to the
	 * `ask` dialog (`set_ask_dialog enabled:true`) and spawns `--mode rpc-ui` so omp offers the `ask` tool; without it
	 * the child stays headless `rpc` and every dialog is cancelled at once.
	 */
	answerDialog?: OmpDialogAnswerer;
	/** Side question deadline (tests); default `BTW_TIMEOUT_MS`. */
	btwTimeoutMs?: number;
	/** Silence cap of the wait for an unsettled session's runs; default `TAIL_WAIT_MS`. */
	tailWaitMs?: number;
	/** `get_state` interval during that wait; default `TAIL_POLL_MS`. */
	tailPollMs?: number;
	/** Where `omp_stream_unreadable` warnings go. */
	log?: Logger;
	/** Process launcher (tests: an in-memory RPC peer); default a new process group of the executable. */
	spawn?: (argv: string[], options: RpcSpawnOptions) => RpcChild;
}

function toDriverError(error: unknown): unknown {
	if (!(error instanceof RpcCommandError)) return error;
	const code = error.code === "unknown_since" ? "unknown_since" : "rpc_error";
	return new OmpDriverError(code, error.message, { rpcCode: error.code, cause: error });
}

/**
 * `leafId()` without moving the whole session through the pipe: reads `get_entries(since=cache.since)` so only the
 * entries after the last-seen cursor are serialized, and remembers the returned `leafId`. An `unknown_since` error
 * (cursor gone after a session switch or compaction) falls back to one full read and re-seeds the cache. A `null`
 * leafId (empty session) is never fed back as a cursor: omp only treats an absent `since` as "everything".
 */
export async function leafIdViaCursor(
	getEntries: (since?: string) => Promise<OmpEntries>,
	cache: { since?: string },
): Promise<string | null> {
	try {
		const slice = await getEntries(cache.since);
		cache.since = slice.leafId ?? undefined;
		return slice.leafId;
	} catch (error) {
		if (!(error instanceof OmpDriverError) || error.code !== "unknown_since") throw error;
		const full = await getEntries(undefined);
		cache.since = full.leafId ?? undefined;
		return full.leafId;
	}
}

/** A turn's end as `#finalize` reads it (a `prompt_result`, or the end of the wait for an unsettled session). */
type TurnEnd = Pick<PromptResultFrame, "status" | "error">;

/** The wait of one prompt for its unsettled session: the silence cap timer and the next `get_state` poll. */
interface TailWait {
	opRef: string;
	silence?: NodeJS.Timeout;
	poll?: NodeJS.Timeout;
}

/**
 * The failure of a run that ended with `agent_end`, read from its last assistant message like omp's own prompt
 * outcome (`stopReason` `error` or `aborted`); undefined when it completed.
 */
function runFailure(messages: unknown): TurnEnd | undefined {
	if (!Array.isArray(messages)) return undefined;
	const last = messages.findLast((message) => isRecord(message) && message.role === "assistant");
	if (!isRecord(last)) return undefined;
	if (last.stopReason === "aborted") return { status: "aborted" };
	if (last.stopReason !== "error") return undefined;
	const message = typeof last.errorMessage === "string" ? last.errorMessage : "omp run failed";
	return { status: "error", error: { message } };
}

export class RpcOmpDriver implements OmpSessionDriver {
	readonly #options: RpcOmpDriverOptions;
	/** The started client: commands go here. */
	#client: OmpRpcClient | undefined;
	/** The client whose child is (or was last) running: its exit and stream reports count until `stop()` ends. */
	#active: OmpRpcClient | undefined;
	#stopping = false;
	readonly #finalListeners = new Set<(final: OmpFinal) => void>();
	readonly #eventListeners = new Set<(event: OmpEvent) => void>();
	readonly #exitListeners = new Set<(info: OmpExitInfo) => void>();
	readonly #admitted = new Set<string>();
	/** Ends of prompts whose `prompt()` has not resolved yet, delivered on admission so onFinal never precedes it. */
	readonly #early = new Map<string, () => void>();
	/** Prompts in flight: only while one runs may an end be buffered in #early (a late frame after a rejection is dropped). */
	#prompting = 0;
	/** Last leafId this driver saw from a `leafId()` read; seed for the delta read in `leafIdViaCursor`. */
	readonly #leafCursor: { since?: string } = {};
	/**
	 * The prompt whose `prompt_result` said `sessionSettled:false`: its final waits for `session_settled` (or a settled
	 * `get_state` with nothing queued), a failed late run, or `tailWaitMs` without an omp event.
	 */
	#tail: TailWait | undefined;
	#tap: ExtensionUiTap | undefined;
	#unsubscribers: Array<() => void> = [];

	constructor(options: RpcOmpDriverOptions) {
		this.#options = options;
	}

	/** Pid of the live child (for leftover-process checks); undefined when not running. */
	get pid(): number | undefined {
		return this.#active?.pid;
	}

	async start(): Promise<void> {
		if (this.#client) throw new OmpDriverError("already_started", "driver already started");
		const options = this.#options;
		const env = buildChildEnv(options.env, options.baseEnv);
		const problem = await checkOmpRuntime(options.ompExecutable, env);
		if (problem) throw new OmpDriverError(problem.code, problem.message);

		mkdirSync(resolve(options.cwd), { recursive: true });
		mkdirSync(resolve(options.sessionDir), { recursive: true });

		// omp builds the `ask` tool only for a UI session; a child whose dialogs reach the owner runs `rpc-ui`.
		const args = ["--mode", options.answerDialog === undefined ? "rpc" : "rpc-ui", "--no-title"];
		if (options.provider) args.push("--provider", options.provider);
		if (options.model) args.push("--model", options.model);
		args.push("--session-dir", options.sessionDir);
		if (options.overlayConfig) args.push("--config", options.overlayConfig);
		if (options.thinking) args.push("--thinking", options.thinking);
		args.push(...(options.extraArgs ?? []));

		this.#stopping = false;
		const client: OmpRpcClient = new OmpRpcClient({
			executable: options.ompExecutable,
			args,
			cwd: options.cwd,
			env,
			...(options.hostTools === undefined ? {} : { hostTools: options.hostTools }),
			...(options.spawn === undefined ? {} : { spawn: options.spawn }),
			onUnreadable: (line) => {
				if (this.#active === client) this.#onUnreadable(line);
			},
		});
		const tap = new ExtensionUiTap(
			(event) => this.#emit(event),
			(frame) => this.#writeRaw(client, frame),
			options.answerDialog,
			(id, output) => {
				if (this.#active === client) this.#onLocalCommand(id, output);
			},
		);
		this.#tap = tap;
		this.#active = client;
		// Not in #unsubscribers: the exit of a child being stopped is still reported (expected: true).
		client.onExit((code, stderr) => {
			tap.close();
			if (this.#active !== client) return;
			this.#clearTail();
			this.#emitExit(code, stderr);
		});
		this.#unsubscribers = [
			client.onFrame((frame) => tap.frame(frame)),
			client.onEvent((event) => this.#emit(event)),
			// Session events also include the agent events `onEvent` delivers, so only the session-only types pass.
			client.onSessionEvent((event) => {
				if (FORWARDED_SESSION_EVENTS.has(event.type)) this.#emit(event);
				this.#onTailEvent(event);
			}),
			client.onPromptResult((frame) => this.#onPromptResult(frame)),
			client.onProtocolError((error) => {
				if (this.#active === client) this.#onProtocolError(error);
			}),
		];
		try {
			await client.start();
		} catch (error) {
			for (const off of this.#unsubscribers) off();
			this.#unsubscribers = [];
			if (this.#active === client) this.#active = undefined;
			throw toDriverError(error);
		}
		this.#client = client;
		// `ask` arrives as one dialog only when someone answers it; otherwise explicit false, so a default change cannot
		// enable a dialog nobody answers.
		const askDialog = options.answerDialog !== undefined;
		this.#writeRaw(client, {
			type: "set_ask_dialog",
			id: `jabbu-ask-dialog-${askDialog ? "on" : "off"}`,
			enabled: askDialog,
		});
	}

	#emit(event: OmpEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	/** One frame to the child outside request tracking (dialog answers, `set_ask_dialog`). */
	#writeRaw(client: OmpRpcClient, frame: Record<string, unknown>): void {
		try {
			client.write(frame);
		} catch {
			// the child is gone; its exit is reported through onExit
		}
	}

	#emitExit(code: number | null, stderr: string): void {
		const info: OmpExitInfo = { code, expected: this.#stopping, stderr };
		for (const listener of this.#exitListeners) listener(info);
	}

	/** A stdout line that is not one JSON object is skipped by the client; it is only logged. */
	#onUnreadable(line: string): void {
		this.#options.log?.warn("omp_stream_unreadable", { line: line.slice(0, 120), prompts: this.#admitted.size });
	}

	/**
	 * The stream broke the RPC protocol (a bad `rpc_chunk` sequence) and the client is stopping the child: the running
	 * prompts can no longer get a result, so they end now with an error final and the next message starts a fresh one.
	 */
	#onProtocolError(error: RpcProtocolError): void {
		this.#clearTail();
		const opRefs = [...this.#admitted];
		this.#options.log?.warn("omp_stream_protocol_error", { error: error.message, prompts: opRefs.length });
		this.#admitted.clear();
		this.#early.clear();
		for (const opRef of opRefs) {
			const final: OmpFinal = { opRef, status: "error", text: "", error: `omp stream broken: ${error.message}` };
			for (const listener of this.#finalListeners) listener(final);
		}
		void this.stop().catch((stopError: unknown) =>
			this.#options.log?.warn("omp_stop_failed", { error: String(stopError) }),
		);
	}

	#onPromptResult(frame: PromptResultFrame): void {
		const id = frame.id;
		if (id === undefined) return;
		if (frame.status === "completed" && frame.sessionSettled === false && this.#tail === undefined) {
			// Only a turn still open may wait on a tail: a late or repeated frame of a settled one would fill the single
			// slot and end the next turn at once. A frame ahead of `prompt()`'s admission waits for it like `#endTurn`.
			if (this.#admitted.has(id)) this.#beginTail(id);
			else if (this.#prompting > 0) {
				this.#options.log?.warn("prompt_result_unadmitted", { opRef: id });
				this.#early.set(id, () => this.#beginTail(id));
			}
			return;
		}
		this.#endTurn(id, frame);
	}

	/** The final of `opRef` now, or on admission when `prompt()` has not resolved yet. */
	#endTurn(opRef: string, end: TurnEnd): void {
		const deliver = () => void this.#finalize(opRef, end);
		if (this.#admitted.has(opRef)) deliver();
		else if (this.#prompting > 0) this.#early.set(opRef, deliver);
	}

	/**
	 * The prompt yielded but its session is not settled: a background job or queued message may still open runs of
	 * their own, whose answers belong to this turn. The turn stays open until the session settles.
	 */
	#beginTail(opRef: string): void {
		const tail: TailWait = { opRef };
		this.#tail = tail;
		this.#options.log?.info("tail_wait_start", { opRef });
		this.#emit({ type: TAIL_WAIT_START_EVENT, opRef });
		this.#armTailSilence(tail);
		this.#pollTail(tail);
	}

	/** (Re)starts the silence cap: every omp event of the wait, and an owner dialog still open at the cap, push it back. */
	#armTailSilence(tail: TailWait): void {
		clearTimeout(tail.silence);
		const waitMs = this.#options.tailWaitMs ?? TAIL_WAIT_MS;
		tail.silence = setTimeout(() => {
			if (this.#tail !== tail) return;
			if (this.#tap?.open === true) {
				this.#options.log?.info("tail_wait_dialog_open", { opRef: tail.opRef });
				return this.#armTailSilence(tail);
			}
			this.#options.log?.warn("tail_wait_timeout", { opRef: tail.opRef, silentMs: waitMs });
			this.#endTail({ status: "completed" });
		}, waitMs);
	}

	/** Asks `get_state` every `tailPollMs` (the next ask only after this one was judged) until the wait ends. */
	#pollTail(tail: TailWait): void {
		tail.poll = setTimeout(async () => {
			const client = this.#client;
			if (this.#tail !== tail || client === undefined) return;
			try {
				const state = await client.getState();
				if (this.#tail !== tail) return;
				if (state.isSettled && state.queuedMessageCount === 0) {
					this.#options.log?.info("tail_wait_settled", { opRef: tail.opRef, by: "get_state" });
					return this.#endTail({ status: "completed" });
				}
			} catch (error) {
				// Still waiting: `session_settled`, a later poll or the silence cap ends it.
				this.#options.log?.warn("tail_poll_failed", { opRef: tail.opRef, error: String(error) });
			}
			if (this.#tail === tail) this.#pollTail(tail);
		}, this.#options.tailPollMs ?? TAIL_POLL_MS);
	}

	/** An omp session event during the wait: `session_settled` or a failed late run ends it, any other pushes the cap. */
	#onTailEvent(event: OmpEvent): void {
		const tail = this.#tail;
		if (tail === undefined) return;
		if (event.type === "session_settled") {
			this.#options.log?.info("tail_wait_settled", { opRef: tail.opRef, by: "session_settled" });
			this.#endTail({ status: "completed" });
			return;
		}
		const failure = event.type === "agent_end" ? runFailure(event.messages) : undefined;
		if (failure !== undefined) {
			// The earlier answers already went out as they were written; the turn ends with this failure alone.
			this.#options.log?.warn("tail_run_failed", { opRef: tail.opRef, status: failure.status });
			this.#endTail(failure);
			return;
		}
		this.#armTailSilence(tail);
	}

	#endTail(end: TurnEnd): void {
		const tail = this.#clearTail();
		if (tail !== undefined) this.#endTurn(tail.opRef, end);
	}

	/** Ends the wait without a final (the caller settles the turn, or the child is gone); returns the ended wait. */
	#clearTail(): TailWait | undefined {
		const tail = this.#tail;
		if (tail === undefined) return undefined;
		this.#tail = undefined;
		clearTimeout(tail.silence);
		clearTimeout(tail.poll);
		this.#emit({ type: TAIL_WAIT_END_EVENT, opRef: tail.opRef });
		return tail;
	}

	/**
	 * An abort during the wait: every caller (`!stop`, stall, stuck loop, cost cap, pause) settles the turn itself, so
	 * the wait ends here with no final — a late run end or `session_settled` must not settle it a second time.
	 */
	#dropTail(): void {
		const tail = this.#clearTail();
		if (tail === undefined) return;
		this.#admitted.delete(tail.opRef);
		this.#early.delete(tail.opRef);
	}

	/**
	 * A prompt omp ran as a local slash command: no `prompt_result` will come, so it ends here, completed with the
	 * command's output. The last assistant text is not read — it is the previous turn's answer.
	 */
	#onLocalCommand(id: string, output: string): void {
		const deliver = () => {
			this.#admitted.delete(id);
			const final: OmpFinal = { opRef: id, status: "completed", text: output };
			for (const listener of this.#finalListeners) listener(final);
		};
		if (this.#admitted.has(id)) deliver();
		else if (this.#prompting > 0) this.#early.set(id, deliver);
	}

	async #finalize(opRef: string, frame: TurnEnd): Promise<void> {
		this.#admitted.delete(opRef);
		const final: OmpFinal = { opRef, status: frame.status, text: "" };
		if (frame.error) final.error = frame.error.message;
		if (frame.status === "completed" && this.#client) {
			try {
				final.text = (await this.#client.getLastAssistantText()) ?? "";
			} catch (error) {
				final.status = "error";
				final.error = `get_last_assistant_text failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		for (const listener of this.#finalListeners) listener(final);
	}

	#require(): OmpRpcClient {
		if (!this.#client) throw new OmpDriverError("not_started", "driver not started");
		return this.#client;
	}

	async #call<T>(run: (client: OmpRpcClient) => Promise<T>): Promise<T> {
		try {
			return await run(this.#require());
		} catch (error) {
			throw toDriverError(error);
		}
	}

	async prompt(text: string): Promise<string> {
		this.#prompting += 1;
		try {
			const opRef = await this.#call((client) => client.prompt(text));
			this.#admitted.add(opRef);
			const early = this.#early.get(opRef);
			this.#early.delete(opRef);
			early?.();
			return opRef;
		} finally {
			this.#prompting -= 1;
			this.#early.clear(); // Never admitted, or a stale entry for an ended turn: no admission will ever consume it.
		}
	}

	steer = (text: string): Promise<void> => this.#call((c) => c.steer(text));

	abort(): Promise<void> {
		this.#dropTail();
		return this.#call((client) => client.abort());
	}

	async abortAndClearQueue(): Promise<void> {
		this.#dropTail();
		// The withdrawn queue is dropped: those messages are ledger rows of the stopped turn, settled with it.
		await this.#call((client) => client.abortAndRestoreQueue());
	}

	newSession = (): Promise<{ cancelled: boolean }> => this.#call((c) => c.newSession());

	async openSession(): Promise<OmpOpenResult> {
		const result = await this.#call((client) => client.openSession(resolve(this.#options.sessionDir)));
		return { resumed: result.resumed, sessionId: result.sessionId };
	}

	async state(): Promise<OmpState> {
		const raw = await this.#call((client) => client.getState());
		const configured = raw.configuredThinkingLevel;
		return {
			sessionId: raw.sessionId,
			sessionFile: raw.sessionFile,
			idle: !raw.isStreaming && !raw.isCompacting,
			settled: raw.isSettled,
			queuedMessageCount: raw.queuedMessageCount,
			messageCount: raw.messageCount,
			model: raw.model?.id === undefined ? undefined : `${raw.model.provider ?? "?"}/${raw.model.id}`,
			...(raw.thinkingLevel === undefined ? {} : { thinking: raw.thinkingLevel }),
			...(typeof configured === "string" && configured !== raw.thinkingLevel ? { configuredThinking: configured } : {}),
			...contextOf(raw.contextUsage),
			...(typeof raw.fastModeEnabled === "boolean" ? { fastModeEnabled: raw.fastModeEnabled } : {}),
			...(typeof raw.fastModeActive === "boolean" ? { fastModeActive: raw.fastModeActive } : {}),
		};
	}

	switchSession = (f: string): Promise<{ cancelled: boolean }> => this.#call((c) => c.switchSession(resolve(f)));

	async availableModels(): Promise<string[]> {
		const models = await this.#call((client) => client.getAvailableModels());
		return models.map((model) => `${model.provider}/${model.id}`);
	}

	async setModel(model: string): Promise<string> {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1)
			throw new OmpDriverError("rpc_error", `model must be provider/id: ${model}`);
		const set = await this.#call((client) => client.setModel(model.slice(0, slash), model.slice(slash + 1)));
		return `${set.provider}/${set.id}`;
	}

	/** omp 19.1+ lists the selectors (with `auto`) in `get_state`; older omp only through its separate query. */
	async thinkingLevels(): Promise<string[]> {
		const { thinkingLevels } = await this.#call((client) => client.getState());
		if (Array.isArray(thinkingLevels) && thinkingLevels.every((level) => typeof level === "string"))
			return thinkingLevels;
		return this.#call((client) => client.getAvailableThinkingLevels());
	}

	availableCommands = (): Promise<OmpCommand[]> => this.#call((c) => c.getAvailableCommands());

	setThinking = (level: string): Promise<void> => this.#call((c) => c.setThinkingLevel(level));

	setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
		return this.#call((client) => client.setFastMode(enabled));
	}

	async setTodos(phases: TodoPhase[]): Promise<void> {
		await this.#call((c) => c.setTodos(phases));
	}

	async compact(instructions?: string): Promise<OmpCompactResult> {
		const result = await this.#call((client) => client.compact(instructions));
		return { tokensBefore: result.tokensBefore, summary: result.summary };
	}

	async leafId(): Promise<string | null> {
		// mailbox.ts reads the cursor per message/per steer; keep it a delta read instead of a whole-session one.
		return leafIdViaCursor((since) => this.entriesSince(since), this.#leafCursor);
	}

	entriesSince = (since?: string): Promise<OmpEntries> => this.#call((c) => c.getEntries(since));

	/**
	 * One side question (`btw`): subscribes to `btw_record` first, then asks. omp writes the `running` frame before the
	 * command's response, so frames seen before the id is known are kept and matched once it is; only a non-running
	 * record of that id settles. A deadline (from the command) cancels the question — by id when known, else whatever
	 * is running or starting.
	 */
	async btw(question: string): Promise<string> {
		const client = this.#require();
		const done = Promise.withResolvers<string>();
		let id: string | undefined;
		const early: BtwRecord[] = [];
		const settle = (record: BtwRecord): void => {
			if (record.id !== id || record.status === "running") return;
			if (record.status === "complete") {
				done.resolve(record.answer.trim() || "(빈 답)");
				return;
			}
			const reason = record.error === undefined ? record.status : `${record.status}: ${record.error}`;
			done.reject(new OmpDriverError("rpc_error", `btw ${reason}`));
		};
		const off = client.onBtwRecord((record) => (id === undefined ? early.push(record) : settle(record)));
		// Once the response is in, no pending request would reject this wait when the child dies: the exit does.
		const offExit = this.onExit(() => done.reject(new OmpDriverError("rpc_error", "btw: omp exited")));
		const timer = setTimeout(() => {
			done.reject(new OmpDriverError("rpc_error", "btw timeout"));
			// Best effort: the caller already gets the timeout, and a cancel that fails leaves nothing to undo here.
			void (id === undefined ? client.cancelBtw() : client.cancelBtw(id)).catch(() => undefined);
		}, this.#options.btwTimeoutMs ?? BTW_TIMEOUT_MS);
		client.btw(question).then(
			(record) => {
				// An exception here would reject nothing and reach the process as an unhandled rejection.
				try {
					if (typeof record?.id !== "string") throw new OmpDriverError("rpc_error", "btw answered without a record");
					id = record.id;
					for (const seen of early) settle(seen);
				} catch (error) {
					done.reject(toDriverError(error));
				}
			},
			(error: unknown) => done.reject(toDriverError(error)),
		);
		try {
			return await done.promise;
		} finally {
			clearTimeout(timer);
			off();
			offExit();
		}
	}

	onFinal = (fn: (final: OmpFinal) => void): (() => void) => listen(this.#finalListeners, fn);

	onEvent = (fn: (event: OmpEvent) => void): (() => void) => listen(this.#eventListeners, fn);

	onExit = (fn: (info: OmpExitInfo) => void): (() => void) => listen(this.#exitListeners, fn);

	async stop(): Promise<void> {
		const client = this.#client;
		if (!client) return;
		this.#stopping = true;
		this.#client = undefined;
		this.#clearTail();
		for (const off of this.#unsubscribers) off();
		this.#unsubscribers = [];
		await client.stop();
		this.#admitted.clear();
		this.#early.clear();
		if (this.#active === client) this.#active = undefined;
	}
}
