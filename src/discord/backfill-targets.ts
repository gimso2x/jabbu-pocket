// Which Discord channels the missed-message recovery reads.
import { parseThreadRef } from "../core/normalize";
import { parseChatOrigin, platformOfConversationId } from "../core/origin-key";
import type { Store } from "../store/db";
import { type BackfillTarget, discordCursorKey } from "./backfill";

/**
 * Every Discord channel to read for missed messages: a stored watermark keeps its channel a target after `jabbu-pocket gc`
 * removed the quiet origin (`ch:`/`thr:` watermarks of the removed Slack backfill are never read here); each origin is
 * a DM, a server channel (its roots open threads) or a server thread, which is a channel of its own; and a work lane's
 * thread has the `jabbu/work/<name>` origin, which `listOrigins` never names, so an open lane's `thread_ref`
 * (`<channel>:<thread id>`) is read from the lane itself.
 */
export function discordBackfillTargets(
	store: Pick<Store, "listCursorKeys" | "listOrigins" | "listLanes">,
): BackfillTarget[] {
	const cursorPrefix = discordCursorKey("");
	return [
		...store.listCursorKeys(cursorPrefix).map((key): BackfillTarget => ({ channelId: key.slice(cursorPrefix.length) })),
		...store.listOrigins("discord").flatMap((originKey): BackfillTarget[] => {
			const ref = parseChatOrigin(originKey);
			if (ref?.platform !== "discord") return [];
			const conversation = { channelId: ref.conversationId, dm: ref.kind === "dm" };
			return ref.threadId === undefined ? [conversation] : [conversation, { channelId: ref.threadId, dm: false }];
		}),
		...store
			.listLanes()
			.filter((lane) => lane.status !== "closed")
			.flatMap((lane): BackfillTarget[] => {
				const thread = parseThreadRef(lane.threadRef);
				return thread !== undefined && platformOfConversationId(thread.channel) === "discord"
					? [{ channelId: thread.threadTs, dm: false }]
					: [];
			}),
	];
}
