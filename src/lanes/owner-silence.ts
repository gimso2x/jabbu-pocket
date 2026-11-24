import { ownerSilenceFallbackMinutes, silenceFailedNotice, silenceNotice, silencePrompt } from "../owner-silence";
import { redact } from "../redact";
import { MAX_MILESTONE_CHARS } from "./manager-constants";
import type { LaneManagerDeps } from "./manager-types";
import type { LaneMeta, LaneRow } from "./status";

/** What a lane's `ompbot_lane_progress` may carry. `reversible` + `recommend` on a `needsOwner` question allow the silence fallback. */
export interface LaneProgressOptions {
	needsOwner?: boolean;
	evidence?: unknown;
	recommend?: string;
	reversible?: boolean;
}

/** The open question a lane may go on with when the owner stays silent; `undefined` for anything else (a milestone, an irreversible or recommendation-less question). */
export function ownerQuestionOf(options: LaneProgressOptions, now: number): LaneMeta["ownerQuestion"] {
	if (options.needsOwner !== true || options.reversible !== true) return undefined;
	const recommend = redact((options.recommend ?? "").replace(/\s+/g, " ").trim()).slice(0, MAX_MILESTONE_CHARS);
	return recommend === "" ? undefined : { recommend, askedAt: now };
}

/**
 * A reversible owner question the owner left unanswered for `ownerSilenceFallbackMinutes` goes ahead on the lane's own
 * recommendation: one prompt into the lane and one line in its thread. The time and the once-only mark are the lane
 * row's, so a restart neither forgets a question nor repeats the prompt (a deadline that passed while the daemon was
 * down is met by the first tick after). A lane that is not working (paused, closed) or a frozen bot waits.
 */
export async function tickOwnerSilence(
	deps: Pick<LaneManagerDeps, "store" | "log" | "frozen" | "ownerSilenceConfig">,
	listed: LaneRow,
	now: number,
	notify: { send(text: string): Promise<boolean>; post(text: string): Promise<unknown> },
): Promise<void> {
	// Read again: the tick's list is as old as the lanes before this one (a Discord sync wait), and the owner may have
	// answered this lane's question meanwhile. Nothing awaits between this read and the mark below.
	const lane = deps.store.getLane(listed.name);
	if (lane === undefined) return;
	const question = lane.meta.ownerQuestion;
	const config = deps.ownerSilenceConfig?.();
	const minutes = config === undefined ? 0 : ownerSilenceFallbackMinutes(config);
	if (question === undefined || question.fallbackAt !== undefined || minutes <= 0 || lane.status !== "working") return;
	if (now - question.askedAt < minutes * 60_000 || deps.frozen?.() !== undefined) return;
	// Marked before the prompt goes out: a failed send is not repeated.
	deps.store.patchLane(
		lane.name,
		{ event: "owner_silence_fallback", detail: question.recommend },
		{ ownerQuestion: { ...question, fallbackAt: now } },
	);
	deps.log.info("lane_owner_silence_fallback", { lane: lane.name, minutes });
	const sent = await notify.send(silencePrompt(minutes, question.recommend));
	await notify.post(
		sent ? silenceNotice(minutes, question.recommend) : silenceFailedNotice(minutes, question.recommend),
	);
}
