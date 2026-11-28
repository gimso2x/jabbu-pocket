import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { JabbuConfig } from "../config";
import type { Logger } from "../log";
import { checkOmpRuntime } from "../omp/runtime-check";
import { readRegularText, writeAtomic0600 } from "../ops/stamp";
import { readVersion } from "./tools";

/** Logs the omp version on every start and warns when it differs from the one recorded by the previous start. */
export async function checkOmpVersion(config: JabbuConfig, log: Logger): Promise<string> {
	const version = await readVersion([config.ompExecutable, "--version"]);
	const recorded = join(config.homeDir, "omp-version");
	let previous: string | undefined;
	try {
		if (lstatSync(recorded, { throwIfNoEntry: false })?.isFile() === true) previous = readRegularText(recorded).trim();
	} catch {
		/* unreadable or non-regular */
	}
	if (previous !== undefined && previous !== version) log.warn("omp_version_changed", { from: previous, to: version });
	try {
		writeAtomic0600(recorded, `${version}\n`);
	} catch (error) {
		log.warn("omp_version_write_failed", { path: recorded, error: String(error) });
	}
	return version;
}

/** A version line `checkOmpVersion` may have read from a working omp; anything else needs the runtime check. */
const OMP_VERSION_LINE = /^omp\/\d+\.\d+\.\d+/;

/**
 * Boot gate: a version that does not look like `omp/<x.y.z>` — missing binary, non-zero exit, timeout, or garbage
 * output — is confirmed with the runtime check, and boot is refused when omp cannot run. Throws
 * `omp_executable_missing: <cause + fix>`; a readable version needs no second check, so working omps boot as before.
 */
export async function assertOmpRunnable(config: JabbuConfig, ompVersion: string): Promise<void> {
	if (OMP_VERSION_LINE.test(ompVersion)) return;
	const problem = await checkOmpRuntime(config.ompExecutable);
	if (problem !== undefined) throw new Error(`${problem.code}: ${problem.message}`);
}
