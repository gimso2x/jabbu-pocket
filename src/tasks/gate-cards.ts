import type { ChannelRegistry } from "../channel/registry";
import type { TaskJudgement } from "./checker";
import type { TaskGateEnd, TaskGateHooks } from "./gate";
import type { TaskRow } from "./ledger";
import {
	buildAutoLandCard,
	editThreadCard,
	GATE_RUNNING_LINE,
	postCardToThread,
	type ReachedAutoLandNote,
	type TaskCard,
	type TaskChatLog,
	taskLandNote,
} from "./notify";

/** What the gate's card hooks need of the sweeper that runs them. */
export interface GateCardEnv {
	channels: ChannelRegistry;
	log: TaskChatLog & { info(event: string, fields?: Record<string, unknown>): void };
	/** The task's reached card with `note` (the sweeper's own: diff link and PR mode included). */
	reached(note?: ReachedAutoLandNote): TaskCard;
	post(card: TaskCard): Promise<boolean>;
}

/**
 * The gate's card hooks: the running card (only on the reach; a restarted gate posts none), and its end — a landing or
 * an opened PR redraws the running card as the auto-merge card (or posts it), a worker sent back (`rework`) swaps the
 * running line for the reason and drops the button without a new card, a hold redraws it with the receipts and posts
 * one reached card naming the reasons with the owner mention.
 */
export function gateCardHooks(
	env: GateCardEnv,
	row: TaskRow,
	judgement: TaskJudgement,
	link: string | undefined,
	onReach: boolean,
): TaskGateHooks {
	const { channels, log } = env;
	return {
		judgement,
		gating: () =>
			onReach
				? postCardToThread(channels, log, row.threadRef, env.reached({ kind: "gating" }))
				: Promise.resolve(undefined),
		ended: async (end: TaskGateEnd, card) => {
			const landed = end.landed;
			const open = end.blockers.length === 0 ? landed : undefined;
			if (
				open?.state === "landed" ||
				open?.state === "merged-not-pushed" ||
				open?.state === "handoff" ||
				open?.state === "in_flight" ||
				open?.state === "pr-open"
			) {
				const done = buildAutoLandCard(row, judgement, open, link, end.gate);
				if (card === undefined || !(await editThreadCard(channels, log, card, { ...done, buttons: [] }))) {
					await env.post(done);
				}
				return;
			}
			if (open?.state === "rework") {
				if (card === undefined) return;
				const running = env.reached({ kind: "gating" });
				const swap = (text: string) => text.replace(GATE_RUNNING_LINE, taskLandNote(open));
				await editThreadCard(channels, log, card, {
					...running,
					text: swap(running.text),
					body: swap(running.body),
					buttons: [],
				});
				return;
			}
			const reasons = end.blockers.length > 0 ? end.blockers : landed === undefined ? [] : [taskLandNote(landed)];
			log.info("task_autoland_skipped", { task: row.taskId, reasons: reasons.join(" · ") });
			if (card !== undefined) await editThreadCard(channels, log, card, env.reached({ kind: "gated", gate: end.gate }));
			await env.post(env.reached({ kind: "skipped", reasons, gate: end.gate }));
		},
	};
}
