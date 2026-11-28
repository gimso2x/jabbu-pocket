import { errorFields } from "../channel/text";
import type { Logger } from "../log";
import { shutdownTimeoutMs, testStopStallMs } from "./run-test-hooks";

/** What `runDaemon` hands the signal handler: the daemon stop, the log, and the exit-code promise. */
export interface ShutdownDeps {
	/** Stops the daemon; called lazily — the handler is built before the daemon exists. */
	stop: () => Promise<void>;
	log: Logger;
	env: Record<string, string | undefined>;
	/** Resolved with the process exit code once the stop settles. */
	exited: PromiseWithResolvers<number>;
	/** Test seam for the process exit; default `process.exit`. */
	exit?: (code: number) => void;
}

/** The installed handler plus the stop request it records for `runDaemon` (a signal during `start()`). */
export interface ShutdownHandle {
	/** The SIGTERM/SIGINT handler. */
	handle: (signal: string) => void;
	/** True once the first stop signal arrived. */
	readonly stopping: boolean;
	/** The first stop signal, if any. */
	readonly signal: string | undefined;
}

/**
 * The SIGTERM/SIGINT handler of `runDaemon`. The first signal starts a graceful stop under one overall bound
 * (60 s, inside the packaged unit's TimeoutStopSec=90); a second signal, or the bound expiring while the stop is
 * still in flight, force-exits 1 at once instead of waiting out a hung pump or idle-wait. The bound timer is
 * cleared when the stop settles, so a clean stop never logs `stop_timeout` late.
 */
export function createShutdown(deps: ShutdownDeps): ShutdownHandle {
	const { stop, log, env, exited } = deps;
	const exit = deps.exit ?? ((code) => process.exit(code));
	const boundMs = shutdownTimeoutMs(env, 60_000);
	let signals = 0;
	let firstSignal: string | undefined;
	const handle = (signal: string) => {
		log.info("signal", { signal });
		if (++signals > 1) {
			log.warn("stop_forced", { signal });
			exit(1);
			return;
		}
		firstSignal = signal;
		const timer = setTimeout(() => {
			log.warn("stop_timeout", { boundMs });
			exit(1);
		}, boundMs);
		const stallMs = testStopStallMs(env);
		const stopped = stallMs === undefined ? stop() : Bun.sleep(stallMs).then(() => stop());
		stopped
			.then(
				() => exited.resolve(0),
				(error: unknown) => {
					log.error("stop_failed", { ...errorFields(error) });
					exited.resolve(1);
				},
			)
			.finally(() => clearTimeout(timer));
	};
	return {
		handle,
		get stopping() {
			return signals > 0;
		},
		get signal() {
			return firstSignal;
		},
	};
}
