// Peer bot posts the adapter does not take as they come: the later parts of a split answer, and the unmentioned posts
// that only tell the core the peer is awake.
import { errorText } from "../channel/text";
import type { CoreSink } from "../channel/types";
import { threadRefOf } from "../core/normalize";
import type { Logger } from "../log";
import { snowflakeTime } from "./backfill";
import type { DiscordMessageEvent } from "./transport";

/**
 * A peer answer over 2000 characters reaches Discord as several posts and only the first carries the mention; the
 * mentioned post waits this long for the rest (the same peer, the same channel, no mention) and takes them in as one
 * request. Two real splits arrived 0.4 s and 4.1 s apart (2026-11-25); a peer turn runs for minutes, so the wait is cheap.
 */
export const PEER_PART_WAIT_MS = 8_000;

interface WaitingPeerPost {
	parts: DiscordMessageEvent[];
	close: () => void;
}

/** The waits of mentioned peer posts for their later parts, keyed `<channel>:<peer>`. */
export class PeerParts {
	readonly #waitMs: number;
	readonly #waiting = new Map<string, WaitingPeerPost>();

	constructor(waitMs: number) {
		this.#waitMs = waitMs;
	}

	/** Takes an unmentioned peer post as a later part when its mentioned post is waiting; false: no wait is open. */
	join(key: string, event: DiscordMessageEvent, log: Logger): boolean {
		const entry = this.#waiting.get(key);
		if (entry === undefined) return false;
		entry.parts.push(event);
		log.info("peer_part_merged", { channel: event.channel_id, id: event.id, key });
		return true;
	}

	/**
	 * The mentioned post's content with every later part that came during the wait, in post order. When a newer
	 * mentioned post of the same key arrives while one is waiting, the earlier wait closes at once so following
	 * unmentioned parts attach to the latest mention.
	 */
	async gather(key: string, content: string): Promise<string> {
		if (this.#waitMs <= 0) return content;
		this.#waiting.get(key)?.close();
		const parts: DiscordMessageEvent[] = [];
		const waited = Promise.withResolvers<void>();
		const entry: WaitingPeerPost = {
			parts,
			close: () => {
				clearTimeout(timer);
				if (this.#waiting.get(key) === entry) this.#waiting.delete(key);
				waited.resolve();
			},
		};
		const timer = setTimeout(entry.close, this.#waitMs);
		this.#waiting.set(key, entry);
		await waited.promise;
		parts.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
		return [content, ...parts.map((part) => part.content)].join("\n");
	}
}

/** What `notePeerSeen` reads of the adapter. */
export interface PeerSeenDeps {
	core: CoreSink;
	log: Logger;
	logChannel: string | undefined;
	place(event: DiscordMessageEvent): Promise<{ conversationId: string; threadId: string | undefined }>;
}

/**
 * A peer post that does not mention this bot is never taken, but it still answers this bot's calls to that peer in its
 * thread (`onPeerSeen`), outside the #log channel. A failed channel lookup is logged and the post dropped as before.
 */
export async function notePeerSeen(deps: PeerSeenDeps, event: DiscordMessageEvent, peerUserId: string): Promise<void> {
	const onPeerSeen = deps.core.onPeerSeen;
	if (onPeerSeen === undefined) return;
	let place: { conversationId: string; threadId: string | undefined };
	try {
		place = await deps.place(event);
	} catch (err) {
		deps.log.warn("peer_seen_lookup_failed", { channel: event.channel_id, id: event.id, error: errorText(err) });
		return;
	}
	if (place.conversationId === deps.logChannel) return;
	const threadRef = threadRefOf(place.conversationId, place.threadId ?? event.id);
	onPeerSeen({ threadRef, peerUserId, at: snowflakeTime(event.id) });
}
