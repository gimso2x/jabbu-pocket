import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAgyExecutable } from "./agy-acp-client";
import { appendTurnChunk, resetTurnText } from "./agy-notice";
import * as Quota from "./agy-quota";
import * as Switch from "./agy-switch";
import { AgyToolKeepalive } from "./agy-tool-keepalive";
import type * as Omp from "./driver";
import { OmpDriverError } from "./driver";
import { buildChildEnv } from "./env";
import { isRecord } from "./type-guards";

// A [TASK] worker's agy print child (agy 1.5.17, T-20261126-08 S0): stdin one `{"event":"user",…}` line per turn; stdout `init` → `step_update`s → `result`. Applies `--settings` deny rules; abort kills child, next prompt resumes.

/** sessionDir file with the latest turn's final assistant text: the task `read` of a driver that is gone. */
export const AGY_LAST_ANSWER_FILE = "agy-last-answer.txt";
const POINTER_FILE = "agy-conversation.json";
/** As the ACP client: no self-update mid-task, and the login kept in files, not a desktop keychain. */
const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "1", SSH_TTY: "jabbu-agy-file-auth" };
const STREAM_ARGS = "--input-format stream-json --output-format stream-json --dangerously-skip-permissions".split(" ");
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const QUIET_STEPS: Record<string, true> = { user_input: true, system_message: true };

/** `model`, `settings`, `addDirs`, `workerFloors` (new-conversation prefix), `logName`, `logDir` for child logs. */
export interface AgyPrintDriverOptions extends Pick<Switch.AgyOmpDriverOptions, SharedOption | "startupTimeoutMs"> {
	model: string;
	settings: string;
	addDirs?: readonly string[];
	workerFloors: string;
	logName: string;
	logDir?: string;
}
type SharedOption = "agyExecutable" | "cwd" | "sessionDir" | "env" | "baseEnv" | "log" | "originKey" | "toolKeepalive";
/** `init` resolves with the conversation id (rejects when the child dies first); `ended`: stopped on purpose. */
type ChildIo = { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; init: PromiseWithResolvers<string> };
type Child = ChildIo & { gone: Promise<void>; stderr: string; ended: boolean; ready: boolean };
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
const subscribe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void) => {
	set.add(listener);
	return () => set.delete(listener);
};

export class AgyPrintDriver implements Omp.OmpSessionDriver {
	readonly #options: AgyPrintDriverOptions;
	readonly #pointerPath: string;
	readonly #toolKeepalive: AgyToolKeepalive;
	#started = false;
	#child: Child | undefined;
	#retiring: Promise<void> | undefined; // a child being ended: the next spawn waits for its exit
	#conversationId: string | undefined;
	#fresh = false; // the live conversation was opened new: its next prompt carries the worker floors
	#resumed = false;
	#turn: Switch.PendingTurn | undefined;
	#queued: string[] = [];
	#entries: Omp.OmpEntry[] = [];
	#seq = 0;
	#spawns = 0;
	readonly #tools = new Map<string, "open" | "done">();
	readonly #unknownKinds = new Set<string>();
	readonly #finals = new Set<(final: Omp.OmpFinal) => void>();
	readonly #events = new Set<(event: Omp.OmpEvent) => void>();
	readonly #exits = new Set<(info: Omp.OmpExitInfo) => void>();

	constructor(options: AgyPrintDriverOptions) {
		this.#options = options;
		this.#pointerPath = join(resolve(options.sessionDir), POINTER_FILE);
		this.#toolKeepalive = new AgyToolKeepalive((event) => {
			if (this.#turn !== undefined) this.#emit(event);
		}, options.toolKeepalive);
	}
	async start(): Promise<void> {
		if (this.#started) throw new OmpDriverError("already_started", "driver already started");
		resolveAgyExecutable(this.#options.agyExecutable, this.#env());
		mkdirSync(resolve(this.#options.sessionDir), { recursive: true });
		this.#started = true;
	}
	async openSession(): Promise<Omp.OmpOpenResult> {
		this.#requireStarted();
		await this.#ensureChild();
		return { resumed: this.#resumed, sessionId: this.#conversationId ?? "" };
	}
	async prompt(text: string): Promise<string> {
		this.#requireStarted();
		if (this.#turn === undefined) await this.#ensureChild();
		const child = this.#child;
		if (this.#turn !== undefined) throw new OmpDriverError("rpc_error", "a turn is already running");
		if (child === undefined) throw new OmpDriverError("rpc_error", "agy child is not running");
		const turn = Switch.createPendingTurn(`agyp-${Date.now().toString(36)}-${++this.#seq}`, text);
		this.#turn = turn;
		this.#send(child, turn, text);
		return turn.opRef;
	}
	/** stream-json runs one turn per line: a steer waits for the running turn's result and goes as the next line. */
	async steer(text: string): Promise<void> {
		this.#requireStarted();
		if (this.#turn === undefined) throw new OmpDriverError("rpc_error", "no turn is running to steer");
		this.#queued.push(text);
	}
	/** Ends the child and the turn `aborted`, once (no crash); the next prompt resumes the conversation. */
	async abort(): Promise<void> {
		this.#requireStarted();
		const turn = this.#turn;
		if (turn === undefined) return;
		turn.abortRequested = true;
		this.#retire();
		this.#finish(turn, { opRef: turn.opRef, status: "aborted", text: "", error: "cancelled" });
		await this.#retiring;
	}
	newSession = () => this.#rebind(undefined);
	switchSession = (sessionFile: string) => this.#rebind(Quota.parseAgySessionStem(sessionFile));
	/** Only the model fixed at registration: the stale-model heal finds it listed and leaves it. */
	availableModels = async (): Promise<string[]> => [this.#model()];
	thinkingLevels = async (): Promise<string[]> => [];
	availableCommands = async (): Promise<Omp.OmpCommand[]> => [];
	leafId = async (): Promise<string | null> => this.#entries.at(-1)?.id ?? null;
	onFinal = (listener: (final: Omp.OmpFinal) => void) => subscribe(this.#finals, listener);
	onEvent = (listener: (event: Omp.OmpEvent) => void) => subscribe(this.#events, listener);
	onExit = (listener: (info: Omp.OmpExitInfo) => void) => subscribe(this.#exits, listener);
	compact = () => Promise.reject<Omp.OmpCompactResult>(this.#refuse("agy 세션은 compact를 지원하지 않습니다"));
	setThinking = (level: string) => Promise.reject<void>(this.#refuse(`Model not found: thinking ${level}`));
	async setModel(model: string): Promise<string> {
		if (model !== this.#model()) throw this.#refuse(`Model not found: ${model} (task model fixed)`);
		return model;
	}
	async setTodos(phases: Omp.TodoPhase[]): Promise<void> {
		this.#options.log?.info("set_todos_unsupported", { driver: "agy-print", phases: phases.length });
	}
	async state(): Promise<Omp.OmpState> {
		const idle = this.#turn === undefined;
		const counts = { queuedMessageCount: this.#queued.length, messageCount: this.#entries.length };
		return { sessionId: this.#conversationId ?? "", idle, settled: idle, ...counts, model: this.#model() };
	}
	async entriesSince(since?: string): Promise<Omp.OmpEntries> {
		const leafId = this.#entries.at(-1)?.id ?? null;
		if (since === undefined) return { entries: [...this.#entries], leafId };
		const index = this.#entries.findIndex((entry) => entry.id === since);
		if (index === -1) throw new OmpDriverError("unknown_since", `no such entry: ${since}`);
		return { entries: this.#entries.slice(index + 1), leafId };
	}
	async stop(): Promise<void> {
		this.#started = false;
		this.#dropTurn();
		this.#retire();
		await this.#retiring;
	}
	#requireStarted(): void {
		if (!this.#started) throw new OmpDriverError("not_started", "driver not started");
	}
	#refuse = (message: string) => new OmpDriverError("rpc_error", message);
	#model = () => `agy/${this.#options.model}`;
	#env = (): Record<string, string> => ({ ...buildChildEnv(this.#options.env, this.#options.baseEnv), ...AGY_ENV });
	async #rebind(conversationId: string | undefined): Promise<{ cancelled: boolean }> {
		this.#requireStarted();
		if (conversationId === undefined) Quota.clearAgyPointer(this.#pointerPath);
		else Quota.writeAgyPointer(this.#options.sessionDir, this.#pointerPath, conversationId);
		const turn = this.#turn; // a running turn cannot outlive its child: abort() ends it `aborted`
		if (turn !== undefined) await this.abort();
		else this.#retire();
		return { cancelled: turn !== undefined };
	}
	#dropTurn(): void {
		if (this.#turn !== undefined) Object.assign(this.#turn, { finished: true }).settled.resolve();
		this.#turn = undefined;
		this.#queued = [];
	}
	/** agy answers an unknown `--conversation` id with a new conversation: then one new child, floors first (S0 d). */
	async #ensureChild(): Promise<void> {
		while (this.#retiring !== undefined) await this.#retiring;
		if (this.#child !== undefined) return;
		const wanted = Quota.readAgyPointer(this.#pointerPath)?.conversationId;
		let opened = await this.#spawn(wanted);
		if (wanted !== undefined && opened !== wanted) {
			this.#options.log?.warn("agy.print.conversation_lost", { origin: this.#options.originKey, wanted, opened });
			Quota.clearAgyPointer(this.#pointerPath);
			this.#retire();
			while (this.#retiring !== undefined) await this.#retiring;
			opened = await this.#spawn(undefined);
		}
		this.#resumed = wanted !== undefined && opened === wanted;
		this.#fresh = !this.#resumed;
		this.#conversationId = opened;
		Quota.writeAgyPointer(this.#options.sessionDir, this.#pointerPath, opened);
	}
	async #spawn(resume: string | undefined): Promise<string> {
		this.#requireStarted(); // a prompt parked on a retire must not spawn a child under a stopped driver
		this.#tools.clear(); // tool-call ids restart at step 0 in a new child; stale states would suppress its first calls
		const { log, originKey, ...options } = this.#options;
		const env = this.#env();
		const logDir = options.logDir ?? join(env.HOME ?? homedir(), ".gemini", "antigravity-cli", "log");
		mkdirSync(logDir, { recursive: true });
		const logFile = join(logDir, `cli-task-${options.logName}-${Date.now()}-${process.pid}-${++this.#spawns}.log`);
		const args = [...STREAM_ARGS, "--settings", options.settings, "--disable-slash-commands", "--log-file", logFile];
		for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
		args.push("--model", options.model, ...(resume === undefined ? [] : ["--conversation", resume]));
		// `-p` takes a value: empty and last, else it eats the next flag (S0).
		const command = [resolveAgyExecutable(options.agyExecutable, env), ...args, "-p="];
		const io = { stdin: "pipe", stdout: "pipe", stderr: "pipe" } as const;
		const proc = Bun.spawn(command, { cwd: resolve(options.cwd), env, ...io, detached: true });
		const init = Promise.withResolvers<string>();
		const child: Child = { proc, init, gone: Promise.resolve(), stderr: "", ended: false, ready: false };
		const stdoutDone = this.#pumpStdout(child);
		void this.#pumpStderr(child);
		child.gone = Promise.all([proc.exited, stdoutDone]).then(([code]) => this.#onExit(child, code));
		this.#child = child;
		const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		const timer = setTimeout(() => init.reject(new Error(`no init in ${timeoutMs}ms`)), timeoutMs);
		try {
			const conversationId = await init.promise;
			log?.info("agy.print.started", { origin: originKey, pid: proc.pid, conversationId, logFile });
			return conversationId;
		} catch (error) {
			this.#retire();
			await this.#retiring;
			const tail = child.stderr.trim().slice(-400);
			const message = `agy print start failed: ${String(error)}${tail ? ` | ${tail}` : ""}`;
			throw new OmpDriverError("rpc_error", message, { cause: error });
		} finally {
			clearTimeout(timer);
		}
	}
	/** Ends the live child on purpose: SIGTERM to its process group, SIGKILL after a grace. */
	#retire(): void {
		this.#toolKeepalive.clear();
		const child = this.#child;
		if (child === undefined) return;
		this.#child = undefined;
		this.#conversationId = undefined;
		child.ended = true;
		const signal = (name: NodeJS.Signals) =>
			Promise.try(() => process.kill(-child.proc.pid, name)).catch(() => child.proc.kill(name));
		signal("SIGTERM");
		const killer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
		const retired: Promise<void> = child.gone.finally(() => {
			clearTimeout(killer);
			if (this.#retiring === retired) this.#retiring = undefined;
		});
		this.#retiring = retired;
	}
	/** A child that died on its own: like the ACP driver its turn gets no final (the mailbox fails it on `onExit`). */
	#onExit(child: Child, code: number): void {
		child.init.reject(new Error(`agy exited (code=${code})`));
		if (child.ended || this.#child !== child) return;
		this.#child = undefined;
		this.#toolKeepalive.clear();
		this.#dropTurn();
		if (!this.#started || !child.ready) return;
		for (const listener of this.#exits) listener({ code, expected: false, stderr: child.stderr });
	}
	async #pumpStdout(child: Child): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.proc.stdout) {
			const lines = (buffer + decoder.decode(chunk, { stream: true })).split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) this.#onLine(child, line);
		}
		this.#onLine(child, buffer);
	}
	async #pumpStderr(child: Child): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of child.proc.stderr) child.stderr = (child.stderr + decoder.decode(chunk)).slice(-4_000);
	}
	#onLine(child: Child, line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		const event = str(message.event) ?? "?";
		const id = str(message.conversation_id);
		if (event === "init" && id !== undefined && id !== "") {
			child.ready = true;
			child.init.resolve(id);
		}
		if (event === "init" || child.ended || child !== this.#child) return;
		const body = message[event];
		const turn = this.#turn;
		if (!isRecord(body) || (event !== "step_update" && event !== "result")) this.#unknown(`event:${event}`);
		else if (turn === undefined) return;
		else if (event === "result") this.#onResult(child, turn, body);
		else if (body.step_type === "tool") this.#onTool(turn, body);
		else if (body.step_type === "agent_response") this.#onResponse(child, turn, body);
		else if (!QUIET_STEPS[str(body.step_type) ?? ""]) this.#unknown(`step:${str(body.step_type)}`);
	}
	#onResponse(child: Child, turn: Switch.PendingTurn, step: Record<string, unknown>): void {
		if (isRecord(step.usage)) {
			const [input, cacheRead] = [num(step.usage.input_tokens), num(step.usage.cache_read_tokens)];
			Switch.addAgyUsage(turn.usage, { input, cacheRead, output: num(step.usage.output_tokens) });
			turn.usage.contextTokens = input + cacheRead;
		}
		const delta = str(step.text_delta);
		if (delta === undefined || delta === "") return;
		const { quota, shown } = appendTurnChunk(turn, delta);
		const message = { role: "assistant", content: [{ type: "text", text: shown }] };
		if (quota === undefined) this.#emit({ type: "message_update", message });
		else this.#rateLimited(child, turn, quota);
	}
	/** A `tool` step as the ACP tool update the shared helper takes: entries, tool events and the keepalive. */
	#onTool(turn: Switch.PendingTurn, step: Record<string, unknown>): void {
		turn.hadToolCall = true;
		const info = isRecord(step.tool_info) ? step.tool_info : {};
		const error = isRecord(info.error) ? str(info.error.message) : undefined;
		const state = str(step.state);
		Switch.applyAgyToolUpdate({
			update: {
				toolCallId: `${str(step.conversation_id) ?? ""}#${num(step.step_index)}`,
				name: str(step.tool_name) ?? str(info.name) ?? "tool",
				rawInput: info.parameters ?? {},
				status: state === "DONE" ? "completed" : state === "ERROR" ? "failed" : "in_progress",
				rawOutput: { output: str(info.output) ?? error ?? "" },
			},
			entries: this.#entries,
			nextSeq: () => ++this.#seq,
			tools: this.#tools,
			toolKeepalive: this.#toolKeepalive,
			model: this.#options.model,
			provider: "agy",
			emit: (event) => this.#emit(event),
		});
	}
	/** Turn end: a steer waiting goes as the next line (same opRef), a quota error ends it as a 429. */
	#onResult(child: Child, turn: Switch.PendingTurn, result: Record<string, unknown>): void {
		this.#toolKeepalive.clear();
		const succeeded = str(result.status) === "SUCCESS";
		const error = str(result.error) ?? `agy turn failed (${str(result.status) ?? "?"})`;
		const text = str(result.response) || turn.text;
		const quota = Quota.resultQuotaDetail(succeeded, error, text);
		if (quota !== undefined) {
			this.#rateLimited(child, turn, quota);
			return;
		}
		const { model } = this.#options;
		const entry = { entries: this.#entries, nextSeq: () => ++this.#seq, provider: "agy", model, usage: undefined };
		Switch.pushAgyAssistantEntry({ ...entry, text, succeeded });
		const queued = this.#queued.join("\n\n");
		if (succeeded && queued !== "") {
			this.#queued = [];
			this.#send(child, turn, queued);
			return;
		}
		const final = { opRef: turn.opRef, text, ...(succeeded ? {} : { error }) };
		this.#finish(turn, { ...final, status: succeeded ? "completed" : "error" });
	}
	/** A quota failure: the turn ends `agy rate limited (429): …` and the child goes; the next prompt starts a new one. */
	#rateLimited(child: Child, turn: Switch.PendingTurn, detail: string): void {
		Quota.setQuotaNotice(turn, detail);
		this.#options.log?.warn("agy.print.rate_limited", { origin: this.#options.originKey, pid: child.proc.pid });
		this.#retire();
		this.#finish(turn, { opRef: turn.opRef, status: "error", text: turn.text, error: turn.rateLimit ?? detail });
	}
	/** One stream-json input line; a new conversation's first one carries the worker floors. */
	#send(child: Child, turn: Switch.PendingTurn, text: string): void {
		this.#entries.push({ id: `agp-${++this.#seq}`, type: "message", message: { role: "user", content: text } });
		resetTurnText(turn);
		const content = this.#fresh ? `${this.#options.workerFloors}\n\n${text}` : text;
		this.#fresh = false;
		try {
			child.proc.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`);
			child.proc.stdin.flush();
		} catch (cause) {
			this.#retire();
			this.#finish(turn, { opRef: turn.opRef, status: "error", text: "", error: `agy stdin closed: ${String(cause)}` });
		}
	}
	/** Ends `turn` once: notes queued steers it drops, clears it and the queue, keeps its answer, sends its final. */
	#finish(turn: Switch.PendingTurn, final: Omit<Omp.OmpFinal, "usage">): void {
		if (turn.finished) return;
		if (this.#queued.length > 0 && final.error !== undefined) final.droppedSteers = this.#queued.length;
		if (final.droppedSteers !== undefined) final.error += ` (steer ${final.droppedSteers}건 미전달)`;
		if (this.#turn === turn) this.#dropTurn();
		turn.finished = true;
		if (final.text !== "") this.#keepAnswer(final.text);
		const usage = turn.usage.calls === 0 ? {} : { usage: { ...turn.usage } };
		for (const listener of this.#finals) listener({ ...final, ...usage });
		turn.settled.resolve();
	}
	#keepAnswer(text: string): void {
		const path = join(resolve(this.#options.sessionDir), AGY_LAST_ANSWER_FILE);
		try {
			writeFileSync(`${path}.tmp`, text);
			renameSync(`${path}.tmp`, path);
		} catch (error) {
			this.#options.log?.warn("agy.print.answer_failed", { origin: this.#options.originKey, error: String(error) });
		}
	}
	/** stream-json is thinly documented: a kind not handled is logged once, never silently dropped. */
	#unknown(kind: string): void {
		if (this.#unknownKinds.has(kind)) return;
		this.#unknownKinds.add(kind);
		this.#options.log?.info("agy.print.unknown_event", { origin: this.#options.originKey, kind });
	}
	#emit(event: Omp.OmpEvent): void {
		for (const listener of this.#events) listener(event);
	}
}
