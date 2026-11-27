import { join } from "node:path";

/** Prefix of every unit `apply --detach` (and `!restart`) starts; `jabbu-apply-<stamp>-<4 hex>`. */
export const APPLY_UNIT_PREFIX = "jabbu-apply-";

/**
 * The `systemd-run` command that runs `apply <childArgs>` as a transient user unit, for `apply --detach` and
 * `!restart` alike. The unit name carries a random suffix so two launches in the same second never collide; the
 * receipt keeps the bare stamp. `homeEnv`: pass `JABBU_HOME` (the caller runs under a non-default home).
 */
export function detachedApplyCommand(input: {
	bun: string;
	repoDir: string;
	pathEnv: string;
	stamp: string;
	childArgs: readonly string[];
	homeEnv?: string;
}): { unit: string; argv: string[] } {
	const unit = `${APPLY_UNIT_PREFIX}${input.stamp}-${crypto.randomUUID().slice(0, 4)}`;
	const setenv = [`--setenv=PATH=${input.pathEnv}`];
	if (input.homeEnv !== undefined) setenv.push(`--setenv=JABBU_HOME=${input.homeEnv}`);
	return {
		unit,
		argv: [
			"systemd-run",
			"--user",
			"--collect",
			`--unit=${unit}`,
			`--working-directory=${input.repoDir}`,
			...setenv,
			input.bun,
			// As the rendered units: no `.env` of the working directory swept up by Bun and handed on to the omp child.
			"--no-env-file",
			join(input.repoDir, "src", "main.ts"),
			...input.childArgs,
		],
	};
}
