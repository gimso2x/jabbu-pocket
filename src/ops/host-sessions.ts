// Host-wide omp RPC session counting: what `/proc` says is
// running, the configured ceiling, and the status numbers built from both.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Running omp RPC sessions on the whole host refuse a new start at or past this many while `hostSessionCeiling` is unset (0 disables). */
export const DEFAULT_HOST_SESSION_CEILING = 8;

/** The argv of every readable `/proc` process; `undefined` when the process table itself cannot be listed. */
export type ProcCmdlineReader = () => readonly (readonly string[])[] | undefined;

/** `/proc/<pid>/cmdline` of every listed pid; a pid that exits between listing and reading is skipped. */
const realProcCmdlines: ProcCmdlineReader = () => {
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return undefined;
	}
	const argvs: (readonly string[])[] = [];
	for (const pid of pids) {
		try {
			const argv = readFileSync(join("/proc", pid, "cmdline"), "latin1")
				.split("\0")
				.filter((arg) => arg !== "");
			argvs.push(argv);
		} catch {
			// The process is gone: its exit is the normal race, not a failed host read.
		}
	}
	return argvs;
};

/** One running omp RPC session: an argv whose arg's basename is `omp` (`bun …/bin/omp` included) carrying `--mode rpc` or `--mode rpc-ui`. */
const isOmpRpcArgv = (argv: readonly string[]): boolean =>
	argv.some((arg) => basename(arg) === "omp") &&
	argv.some((arg, i) => arg === "--mode" && (argv[i + 1] === "rpc" || argv[i + 1] === "rpc-ui"));

/**
 * Running omp RPC sessions on this host (every user), or `undefined` when `/proc` cannot be listed — a child ompbot
 * itself spawned (`omp --mode rpc[-ui]`, an exe-named `bun` child included) counts, an `omp -p` run does not.
 */
export function ompRpcSessions(list: ProcCmdlineReader = realProcCmdlines): number | undefined {
	const argvs = list();
	return argvs === undefined ? undefined : argvs.filter(isOmpRpcArgv).length;
}

/** The host-wide session ceiling a lane or [TASK] start is judged against (`config.hostSessionCeiling`). */
export interface SessionCeilingGate {
	/** At or above this many running omp RPC sessions a start refuses; 0 disables the gate. */
	ceiling: number;
	/** Test seam for the process list (default this machine's `/proc`). */
	list?: ProcCmdlineReader;
	/** Called by `startCapacity` when the ceiling is reached or memory is low, so resting conversation children can be swept at once. */
	onPressure?: () => void;
}

/** The host-wide session numbers `ompbot status --json` and the dashboard host chip show. */
export interface HostSessionsInfo {
	/** Every user's `omp --mode rpc`·`rpc-ui` process count; `null` when `/proc` cannot be read. */
	count: number | null;
	/** `hostSessionCeiling` (default 8); 0 disables the start gate. */
	ceiling: number;
}

/** The status numbers for a config-decided ceiling; `undefined` while no ceiling is decided (test configs without the key). */
export function hostSessionsInfo(ceiling: number | undefined): HostSessionsInfo | undefined {
	return ceiling === undefined ? undefined : { count: ompRpcSessions() ?? null, ceiling };
}
