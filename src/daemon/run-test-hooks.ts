// Test-only hooks of `runDaemon`, each read only under `OMPBOT_TEST_HOOKS=1`.

/**
 * Test-only fatal error once the daemon runs: `OMPBOT_TEST_FATAL=rejection|exception`, read only when
 * `OMPBOT_TEST_HOOKS=1` (like `OMPBOT_TEST_CRASH_AT`), so the `daemon_fatal` record can be proven on a real process.
 */
export function testFatal(env: Record<string, string | undefined>): void {
	const kind = env.OMPBOT_TEST_HOOKS === "1" ? env.OMPBOT_TEST_FATAL : undefined;
	if (kind === "rejection") setTimeout(() => void Promise.reject(new Error("test_fatal")), 0);
	if (kind === "exception") {
		setTimeout(() => {
			throw new Error("test_fatal");
		}, 0);
	}
}

/** `OMPBOT_TEST_START_STALL=1`: blocks the main thread as a stuck boot would, to prove the watchdog is already armed. */
export function testStartStall(env: Record<string, string | undefined>): void {
	if (env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_TEST_START_STALL === "1") for (;;);
}
