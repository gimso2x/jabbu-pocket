import type { TaskRow } from "../tasks/ledger";
import { askDaemon, checkIpcTimeoutMs } from "./tasks-ipc";

/** What the daemon's landing takes on top of the check wait (rebase, the rejudge of the checks, push, PR). */
const LAND_EXTRA_TIMEOUT_MS = 600_000;

/**
 * `jabbu-pocket tasks land <id>`: asks the running daemon to land a task that stopped at its Outcome, the same landing as the
 * `머지` button (integrity warnings block it the same way). Exit 2: refused (not in review, already landing, draining, …),
 * 1: no daemon, no answer in time or the landing stopped, 0: landed, PR opened or handed to the model turn.
 */
export async function tasksLand(
	row: TaskRow,
	homeDir: string,
	timeoutMs = checkIpcTimeoutMs(row) + LAND_EXTRA_TIMEOUT_MS,
): Promise<number> {
	if (row.status !== "review") {
		process.stderr.write(`tasks land: ${row.taskId} is ${row.status}, only a task in review can be landed\n`);
		return 2;
	}
	const answered = await askDaemon(homeDir, { op: "tasks_land", id: row.taskId }, timeoutMs);
	if (answered === "unreachable") {
		process.stderr.write("tasks land: 데몬이 떠 있지 않음 (daemon not reachable) — 아무것도 착지하지 않았습니다\n");
		return 1;
	}
	if (answered === "no_response") {
		process.stderr.write(
			`tasks land: no daemon answer in ${Math.round(timeoutMs / 1000)}s — 응답 지연 — 착지가 아직 진행 중일 수 있음, \`tasks show ${row.taskId}\`로 확인\n`,
		);
		return 1;
	}
	process.stdout.write(`${JSON.stringify(answered)}\n`);
	if (answered.ok !== true) {
		process.stderr.write(`tasks land: refused: ${String(answered.error)}\n`);
		return 2;
	}
	const state = (answered.result as { state?: string } | undefined)?.state;
	return state === "blocked" || state === "rework" ? 1 : 0;
}
