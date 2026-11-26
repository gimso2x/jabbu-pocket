import type {
	OmpCommand,
	OmpCompactResult,
	OmpEntries,
	OmpEvent,
	OmpExitInfo,
	OmpFinal,
	OmpOpenResult,
	OmpSessionDriver,
	OmpState,
	TodoPhase,
} from "../omp/driver";

/**
 * omp numbers its RPC requests `req_<n>` per child process, so after a restart a new turn can reuse an `op_ref` an earlier process used, and the ledger (keyed by origin, op_ref, part) would drop the new answer. Every opRef (prompt results, finals, event payloads) is prefixed with an id unique per driver instance.
 */
export class NamespacedDriver implements OmpSessionDriver {
	/** Side question, defined only when the wrapped driver supports it (absent = unsupported, like the inner driver). */
	readonly btw?: (question: string) => Promise<string>;
	/** Queue-clearing abort, defined only when the wrapped driver has one (`!stop` falls back otherwise). */
	readonly abortAndClearQueue?: () => Promise<void>;
	/** Fast mode toggle, defined only when the wrapped driver supports it (absent = unsupported, e.g. agy). */
	readonly setFastMode?: (enabled: boolean) => Promise<{ enabled: boolean; active: boolean }>;

	constructor(
		private readonly inner: OmpSessionDriver,
		private readonly prefix: string,
	) {
		if (inner.btw !== undefined) this.btw = inner.btw.bind(inner);
		if (inner.abortAndClearQueue !== undefined) this.abortAndClearQueue = inner.abortAndClearQueue.bind(inner);
		if (inner.setFastMode !== undefined) this.setFastMode = inner.setFastMode.bind(inner);
	}

	/** Pid of the omp child when the wrapped driver exposes one (`RpcOmpDriver`). */
	get pid(): number | undefined {
		return "pid" in this.inner && typeof this.inner.pid === "number" ? this.inner.pid : undefined;
	}

	start = (): Promise<void> => this.inner.start();

	async prompt(text: string): Promise<string> {
		return `${this.prefix}:${await this.inner.prompt(text)}`;
	}

	steer = (text: string): Promise<void> => this.inner.steer(text);

	abort = (): Promise<void> => this.inner.abort();

	newSession(): Promise<{ cancelled: boolean }> {
		return this.inner.newSession();
	}

	openSession(): Promise<OmpOpenResult> {
		return this.inner.openSession();
	}

	switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		return this.inner.switchSession(sessionFile);
	}

	availableModels(): Promise<string[]> {
		return this.inner.availableModels();
	}

	setModel(model: string): Promise<string> {
		return this.inner.setModel(model);
	}

	thinkingLevels(): Promise<string[]> {
		return this.inner.thinkingLevels();
	}

	availableCommands(): Promise<OmpCommand[]> {
		return this.inner.availableCommands();
	}

	setThinking(level: string): Promise<void> {
		return this.inner.setThinking(level);
	}

	setTodos(phases: TodoPhase[]): Promise<void> {
		return this.inner.setTodos(phases);
	}

	compact(instructions?: string): Promise<OmpCompactResult> {
		return this.inner.compact(instructions);
	}

	state(): Promise<OmpState> {
		return this.inner.state();
	}

	leafId(): Promise<string | null> {
		return this.inner.leafId();
	}

	entriesSince(since?: string): Promise<OmpEntries> {
		return this.inner.entriesSince(since);
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		return this.inner.onFinal((final) => listener({ ...final, opRef: `${this.prefix}:${final.opRef}` }));
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		return this.inner.onEvent((event) =>
			listener(typeof event.opRef === "string" ? { ...event, opRef: `${this.prefix}:${event.opRef}` } : event),
		);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		return this.inner.onExit(listener);
	}

	stop = (): Promise<void> => this.inner.stop();
}
