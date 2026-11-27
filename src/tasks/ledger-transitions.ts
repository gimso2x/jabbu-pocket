import type { TaskStatus } from "./ledger";

/** Statuses only a human `close` (or, `review → done` alone, the core landing) can reach; a closed task never moves again. */
export const HUMAN_ONLY: readonly TaskStatus[] = ["done", "cancelled"];
/** What the bot paths (tool, sweep) may do: working ⇄ blocked, working → review, review → working (resume). */
export const BOT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	working: ["blocked", "review"],
	blocked: ["working"],
	review: ["working"],
	done: [],
	cancelled: [],
};
