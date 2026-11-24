export type CrashPoint =
	| "after_dispatch"
	| "after_final_before_answered"
	| "after_answered"
	| "after_post_before_confirm"
	// `apply`: a step of `runApply` finished and the process dies before the next one (a mid-apply OOM or reboot).
	| "apply_after_backup"
	| "apply_after_drain"
	| "apply_after_deps"
	| "apply_after_restart"
	// `land`: the base branch moved / the push went out and the process dies before the landing finished.
	| "land_after_merge_before_push"
	| "land_after_push_before_cleanup";

const CRASH_POINTS: Record<CrashPoint, true> = {
	after_dispatch: true,
	after_final_before_answered: true,
	after_answered: true,
	after_post_before_confirm: true,
	apply_after_backup: true,
	apply_after_drain: true,
	apply_after_deps: true,
	apply_after_restart: true,
	land_after_merge_before_push: true,
	land_after_push_before_cleanup: true,
};

/**
 * Test-only crash points. `OMPBOT_TEST_CRASH_AT` is read only when `OMPBOT_TEST_HOOKS=1`, so a stray variable
 * in production can never kill the daemon. Returns a function the daemon calls at each point.
 */
export function crashHook(
	env: Record<string, string | undefined> = process.env,
	exit: (code: number) => never = (code) => process.exit(code),
): (point: CrashPoint) => void {
	const target = env.OMPBOT_TEST_HOOKS === "1" ? env.OMPBOT_TEST_CRASH_AT : undefined;
	if (target !== undefined && !Object.hasOwn(CRASH_POINTS, target)) {
		throw new Error(`OMPBOT_TEST_CRASH_AT: unknown crash point ${target}`);
	}
	return (point) => {
		if (point === target) exit(137);
	};
}
