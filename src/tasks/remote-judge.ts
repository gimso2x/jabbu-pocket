import type { HerdrAgentStatusResult } from "../dispatch/omp";
import type { TaskRow } from "./ledger";

/** A remote task is judged at most this often (its reads take seconds over ssh), unless it is due or just stopped. */
const REMOTE_JUDGE_MS = 5 * 60_000;

/**
 * When each remote task is judged (in memory: a restart judges once at once); a local task is judged every sweep.
 * Between slots a remote task is still judged at once when its checks just ended (`due`) or its herdr agent has just
 * stopped (idle/done) since the last judgement, so a worker that finished is not left waiting for the next five-minute
 * slot. A stop is judged once: an agent that stays stopped waits for the slots again until it works and stops anew.
 */
export class RemoteJudgeClock {
	readonly #judgedAt = new Map<string, number>();
	/** Tasks whose agent was stopped when last seen. */
	readonly #stopped = new Set<string>();

	/** Whether the task waits for its next slot; `agent` is read only for a remote task inside a slot gap. */
	async waits(
		row: Pick<TaskRow, "taskId" | "host">,
		now: number,
		due: boolean,
		agent: () => Promise<HerdrAgentStatusResult>,
	): Promise<boolean> {
		const last = this.#judgedAt.get(row.taskId);
		if (row.host === null || due || last === undefined || now - last >= REMOTE_JUDGE_MS) return false;
		const seen = await agent();
		if (!seen.ok) return true;
		if (seen.status !== "idle" && seen.status !== "done") {
			this.#stopped.delete(row.taskId);
			return true;
		}
		return this.#stopped.has(row.taskId);
	}

	/** After a judgement at `now`, with the agent status that judgement read (undefined: unknown, the stop state stays). */
	judged(row: Pick<TaskRow, "taskId" | "host">, now: number, agent: HerdrAgentStatusResult | undefined): void {
		if (row.host === null) return;
		this.#judgedAt.set(row.taskId, now);
		if (agent === undefined || !agent.ok) return;
		if (agent.status === "idle" || agent.status === "done") this.#stopped.add(row.taskId);
		else this.#stopped.delete(row.taskId);
	}
}
