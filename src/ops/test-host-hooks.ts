import { type HostLoadReader, IDLE_HOST_LOAD, type StatfsReader } from "./host-resources";

/** 50 of 100 GiB free (4 KiB blocks): tests never meet `disk_low` or the 5 GiB start floor from this machine's disk. */
export const ROOMY_STATFS: StatfsReader = () => ({ bavail: 50 * 262_144, blocks: 100 * 262_144, bsize: 4096 });

/**
 * Test-only host readers for child processes, which cannot take {@link IDLE_HOST_LOAD} as an argument.
 * `JABBU_TEST_HOST_LOAD=idle` is read only when `JABBU_TEST_HOOKS=1` (like `JABBU_TEST_CRASH_AT`), so a stray
 * variable in production never hides real load. `undefined` = this machine's own readings.
 */
export function testHostLoad(env: Record<string, string | undefined> = process.env): HostLoadReader | undefined {
	const value = env.JABBU_TEST_HOOKS === "1" ? env.JABBU_TEST_HOST_LOAD : undefined;
	if (value === undefined) return undefined;
	if (value !== "idle") throw new Error(`JABBU_TEST_HOST_LOAD: unknown value ${value}`);
	return IDLE_HOST_LOAD;
}

/**
 * Test-only filesystem reader for child processes, which cannot take {@link ROOMY_STATFS} as an argument.
 * `JABBU_TEST_STATFS=roomy` is read only when `JABBU_TEST_HOOKS=1` (like `JABBU_TEST_HOST_LOAD`), so a stray
 * variable in production never hides real disk pressure. `undefined` = this machine's own `statfsSync`.
 */
export function testStatfs(env: Record<string, string | undefined> = process.env): StatfsReader | undefined {
	const value = env.JABBU_TEST_HOOKS === "1" ? env.JABBU_TEST_STATFS : undefined;
	if (value === undefined) return undefined;
	if (value !== "roomy") throw new Error(`JABBU_TEST_STATFS: unknown value ${value}`);
	return ROOMY_STATFS;
}
