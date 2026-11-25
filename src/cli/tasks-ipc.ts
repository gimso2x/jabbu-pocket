import { join } from "node:path";
import { callDaemon, IpcNoResponse } from "../daemon/ipc";
import { taskChecksOf } from "../tasks/checker";
import type { TaskRow } from "../tasks/ledger";
import { CHECK_TIMEOUT_MS } from "../tasks/signals";

/** The IPC wait of every request but `check`. */
const IPC_TIMEOUT_MS = 60_000;

/**
 * How long `tasks check` waits for the daemon: its check runs every `[check: …]` signal of the task one after another,
 * each bounded by `CHECK_TIMEOUT_MS`, plus the plain wait for the reads and posts around them.
 */
export function checkIpcTimeoutMs(row: TaskRow): number {
	return taskChecksOf(row.acceptance).length * CHECK_TIMEOUT_MS + IPC_TIMEOUT_MS;
}

/**
 * Asks the running daemon to act on a task (post, react). `unreachable`: nothing listens, so nothing was done;
 * `no_response`: the request went out but no answer came in `timeoutMs`, so the daemon may still be acting on it.
 */
export async function askDaemon(
	homeDir: string,
	request: Record<string, unknown>,
	timeoutMs = IPC_TIMEOUT_MS,
): Promise<Record<string, unknown> | "unreachable" | "no_response"> {
	try {
		const response = await callDaemon(join(homeDir, "jabbu.sock"), request, timeoutMs);
		return typeof response === "object" && response !== null ? (response as Record<string, unknown>) : "no_response";
	} catch (error) {
		return error instanceof IpcNoResponse ? "no_response" : "unreachable";
	}
}
