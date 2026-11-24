import type { ActionButton } from "../channel/port";
import { escapeMrkdwn, formatElapsed } from "../channel/text";
import { parseThreadRef } from "../core/normalize";
import { closedMarkOf, PROGRESS_INTERVAL_MS } from "./manager-constants";
import { failedChecksOf, pauseButton, resumeButton } from "./manager-text";
import type { LaneManagerDeps } from "./manager-types";
import type { LaneMeta, LaneRow } from "./status";

/** The texts a closed lane's root and status message show once drawn (`syncLane` draws exactly these). */
export function closedTexts(lane: LaneRow): { root: string; status: string } {
	const [mark, waiting] = closedMarkOf(lane);
	const title = escapeMrkdwn(lane.title);
	return { root: `${mark} ${title}`, status: `${mark} ${title}${waiting === "" ? "" : ` · ${waiting}`}` };
}

/** Whether the chat shows `lane` (closed) as it is now: root and status both drawn (a borrowed thread: the status). */
export function closedDrawn(lane: LaneRow): boolean {
	const { root, status } = closedTexts(lane);
	return (lane.meta.borrowedThread === true || lane.meta.renderedRoot === root) && lane.meta.renderedStatus === status;
}

/**
 * Brings the root and status messages to what the registry says. `meta.rendered*` remembers what the chat shows, so a
 * failed edit is simply retried by the next tick. Working status edits follow the 15-minute cadence unless the
 * reason is a milestone or a transition. Callers pass the row they already hold (the tick reuses its `listLanes`
 * read; a transition passes the row its write returned) so no lane row is parsed a second time; the row as the chat
 * now shows it is returned for the caller to keep using.
 */
export async function syncLane(
	deps: Pick<LaneManagerDeps, "store" | "channels" | "clock" | "log">,
	unroutableWarned: Set<string>,
	lane: LaneRow,
	reason: "transition" | "milestone" | "tick",
): Promise<LaneRow> {
	const { store, channels, clock, log } = deps;
	const name = lane.name;
	const parsed = parseThreadRef(lane.threadRef);
	if (parsed === undefined) return lane;
	const { channel, threadTs: rootTs } = parsed;
	// Its platform is off (e.g. Discord disabled): nothing to draw on. The row keeps what was last shown, so the first
	// draw after the channel registers again brings it up to date.
	if (channels.forConversation(channel) === undefined) {
		if (!unroutableWarned.has(name)) {
			unroutableWarned.add(name);
			log.info("lane_render_skipped", { lane: name, reason: "channel_unregistered", channel });
		}
		return lane;
	}
	const closed = lane.status === "closed";
	const paused = lane.status === "paused";
	const now = clock.now();
	// A closed lane is ✅ only once its work is in the base branch (or it never had a branch of its own).
	const [mark, waiting] = !closed ? ["🔄", ""] : closedMarkOf(lane);
	// The title and milestone are the model's words: mention syntax in them stays text.
	const title = escapeMrkdwn(lane.title);
	const rootText = `${mark} ${title}`;
	const milestone = lane.meta.milestone === undefined ? "" : `\n↳ ${escapeMrkdwn(lane.meta.milestone)}`;
	// Paused pins its status (no elapsed clock) and is drawn at the transition, never on the 15-minute tick.
	const attached = lane.meta.attach !== undefined;
	const acceptHint =
		!closed && !attached && !paused && lane.status === "not-done" && failedChecksOf(lane).length > 0
			? ' · 계획대로 보류한 검사면 "닫아"'
			: "";
	const statusText = closed
		? `${mark} ${title}${waiting === "" ? "" : ` · ${waiting}`}`
		: attached
			? `🖥 ${title} · 터미널에서 작업 중`
			: paused
				? `⏸ ${title} · 멈춤`
				: `⏳ ${title} · ${formatElapsed(now - lane.meta.startedAt)}${milestone}${acceptHint}`;
	const statusDue = closed
		? lane.meta.renderedStatus !== statusText
		: paused
			? lane.meta.renderedStatus !== statusText // drawn once; a tick only retries a draw that failed
			: reason !== "tick" ||
				(acceptHint !== "" && !(lane.meta.renderedStatus ?? "").endsWith(acceptHint)) ||
				now - lane.meta.lastProgressAt >= PROGRESS_INTERVAL_MS;
	// The owner holds or resumes the lane from the status message itself (closed lanes have their Outcome card).
	// Attached: the terminal hands the lane back, so no button would do anything.
	const statusButtons: readonly ActionButton[] =
		closed || attached ? [] : [paused ? resumeButton(name) : pauseButton(name)];
	const patch: Partial<LaneMeta> = {};
	try {
		const port = channels.portFor(channel);
		// A borrowed thread's first message is the owner's: there is no root to draw, only the status.
		if (lane.meta.borrowedThread !== true && lane.meta.renderedRoot !== rootText) {
			await port.edit({ platform: port.platform, conversationId: channel, messageId: rootTs }, { text: rootText });
			patch.renderedRoot = rootText;
		}
		if (lane.meta.statusTs !== undefined && statusDue) {
			// The status is inside the lane thread: on Discord the thread id tells the port where, even after a
			// restart emptied its message cache.
			await port.edit(
				{ platform: port.platform, conversationId: channel, messageId: lane.meta.statusTs, threadId: rootTs },
				{ text: statusText, buttons: statusButtons },
			);
			patch.renderedStatus = statusText;
			patch.lastProgressAt = now;
		}
	} catch (error) {
		log.warn("lane_render_failed", { lane: name, error: String(error) });
	}
	if (patch.renderedRoot !== undefined) log.info("lane_rendered", { lane: name, root: patch.renderedRoot });
	if (Object.keys(patch).length === 0) return lane;
	return store.patchLane(name, undefined, patch);
}
