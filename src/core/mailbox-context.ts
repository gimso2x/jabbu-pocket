import type { OmpSessionDriver, OmpState } from "../omp/driver";
import type { LiveView } from "./live-turn";

/** `OmpState.context`: what omp last said about the conversation's context use. */
export type LiveContext = NonNullable<OmpState["context"]>;

/** The dashboard `live` op's answer: the running turn's {@link LiveView} plus the last context use omp reported. */
export type LiveViewWithContext = LiveView & { context?: LiveContext };

/**
 * The last `OmpState.context` a mailbox's child reported, for the dashboard's context bar. Nothing asks omp for it: it
 * is whatever `state()` answered to the callers that already ask (`!status`, the idle check, the cost bookkeeping).
 */
export class ContextMemory {
	#last: LiveContext | undefined;
	/** Driver generation `watch()` set: a note from a replaced driver must not write. */
	#generation = 0;
	/** Sequence of the latest `note()` of the current generation. */
	#seq = 0;
	/** Sequence of the newest note whose answer was accepted; an older note resolving late loses. */
	#accepted = 0;

	/**
	 * Makes `driver.state()` remember its answer (in place, so the driver's identity does not change) and forgets the
	 * previous child's value. Returns `driver`.
	 */
	watch<T extends OmpSessionDriver>(driver: T): T {
		this.#last = undefined;
		this.#generation += 1;
		this.#seq = 0;
		this.#accepted = 0;
		const state = driver.state.bind(driver);
		driver.state = () => this.note(state()) as Promise<OmpState>;
		return driver;
	}

	/**
	 * Remembers the context of `state`'s answer when it has one; returns `state` itself. An answer writes only when
	 * its call is newer than every answer accepted so far: overlapping `state()` calls (`!status` asks off the serial
	 * chain) resolve in any order, and an in-flight answer of a stopped driver must not resurrect its context after
	 * `watch()` moved on.
	 */
	note(state: Promise<OmpState> | undefined): Promise<OmpState> | undefined {
		if (state === undefined) return undefined;
		const generation = this.#generation;
		const seq = ++this.#seq;
		void state.then(
			(answer) => {
				if (generation !== this.#generation || seq <= this.#accepted) return;
				this.#accepted = seq;
				this.#last = answer.context ?? this.#last;
			},
			() => undefined,
		);
		return state;
	}

	/** `view` with the remembered context; null stays null. */
	attach(view: LiveView | null): LiveViewWithContext | null {
		return view === null || this.#last === undefined ? view : { ...view, context: { ...this.#last } };
	}
}
