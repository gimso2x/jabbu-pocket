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

	/**
	 * Makes `driver.state()` remember its answer (in place, so the driver's identity does not change) and forgets the
	 * previous child's value. Returns `driver`.
	 */
	watch<T extends OmpSessionDriver>(driver: T): T {
		this.#last = undefined;
		const state = driver.state.bind(driver);
		driver.state = () => this.note(state()) as Promise<OmpState>;
		return driver;
	}

	/** Remembers the context of `state`'s answer when it has one; returns `state` itself. */
	note(state: Promise<OmpState> | undefined): Promise<OmpState> | undefined {
		void state?.then(
			(answer) => {
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
