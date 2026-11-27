// Test-only hooks of `runDaemon`, each read only under `JABBU_TEST_HOOKS=1`.

/**
 * Test-only fatal error once the daemon runs: `JABBU_TEST_FATAL=rejection|exception`, read only when
 * `JABBU_TEST_HOOKS=1` (like `JABBU_TEST_CRASH_AT`), so the `daemon_fatal` record can be proven on a real process.
 */
export function testFatal(env: Record<string, string | undefined>): void {
	const kind = env.JABBU_TEST_HOOKS === "1" ? env.JABBU_TEST_FATAL : undefined;
	if (kind === "rejection") setTimeout(() => void Promise.reject(new Error("test_fatal")), 0);
	if (kind === "exception") {
		setTimeout(() => {
			throw new Error("test_fatal");
		}, 0);
	}
}

/** `JABBU_TEST_START_STALL=1`: blocks the main thread as a stuck boot would, to prove the watchdog is already armed. */
export function testStartStall(env: Record<string, string | undefined>): void {
	if (env.JABBU_TEST_HOOKS === "1" && env.JABBU_TEST_START_STALL === "1") for (;;);
}

/**
 * Overall bound on a graceful stop, in ms: `JABBU_TEST_SHUTDOWN_TIMEOUT_MS` under `JABBU_TEST_HOOKS=1`, else
 * `fallback` (production: 60 s, inside the packaged unit's TimeoutStopSec=90). A missing or non-positive value
 * keeps the fallback, so a stray variable in production never shortens a real stop.
 */
export function shutdownTimeoutMs(env: Record<string, string | undefined>, fallback: number): number {
	if (env.JABBU_TEST_HOOKS !== "1") return fallback;
	const ms = Number(env.JABBU_TEST_SHUTDOWN_TIMEOUT_MS);
	return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/**
 * `JABBU_TEST_STOP_STALL_MS=<ms>`: holds the shutdown for <ms> before `stop()` runs, so a second signal (or the
 * shutdown bound) lands while the stop is still in flight. Read only when `JABBU_TEST_HOOKS=1`.
 */
export function testStopStallMs(env: Record<string, string | undefined>): number | undefined {
	if (env.JABBU_TEST_HOOKS !== "1") return undefined;
	const ms = Number(env.JABBU_TEST_STOP_STALL_MS);
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
