// Single definition of chat origin keys (`chatOriginKey` / `parseChatOrigin`).

export type ChatPlatform = "discord" | "web";

/**
 * Key namespaces of the removed Slack and Teams channels. Old ledger rows keep them (gc and the dashboard still read
 * them as plain text, `parseChatOrigin` as an unknown platform); no adapter takes them, so the daemon closes their
 * open rows at start (`inbound_discarded reason=platform_removed`).
 */
export const REMOVED_PLATFORM_PREFIXES: readonly string[] = ["slack/", "teams/"];

export interface ChatOriginRef {
	platform: ChatPlatform;
	/** `dm`: a direct conversation with the owner; `ch`: a channel or group. */
	kind: "dm" | "ch";
	conversationId: string;
	/** Thread inside the conversation (a Discord thread). */
	threadId?: string;
}

/** Exact id grammar per platform: Discord snowflakes (digits), web `w_` + 8-32 alnum. */
export const GRAMMAR: Readonly<Record<ChatPlatform, { readonly conversation: RegExp; readonly thread: RegExp }>> = {
	discord: { conversation: /^[0-9]{1,20}$/, thread: /^[0-9]+$/ },
	web: { conversation: /^w_[a-z0-9]{8,32}$/, thread: /^w_[a-z0-9]{8,32}$/ },
};

const isChatPlatform = (value: string | undefined): value is ChatPlatform =>
	value !== undefined && Object.hasOwn(GRAMMAR, value);

/**
 * Platform of a conversation id met without an origin key (a delivery's thread ref, an approval card's channel), read
 * with GRAMMAR's own conversation pattern so it never disagrees with `parseChatOrigin`; `undefined` when no platform's
 * grammar accepts it.
 */
export function platformOfConversationId(id: string): ChatPlatform | undefined {
	return (Object.keys(GRAMMAR) as ChatPlatform[]).find((platform) => GRAMMAR[platform].conversation.test(id));
}

/**
 * Platform whose namespace `key` lives in (`discord/…`), whether or not the rest is
 * well-formed; `undefined` for every other namespace. For "is this a chat surface" checks that must not depend on
 * the exact id grammar.
 */
export function chatPlatformOf(key: string): ChatPlatform | undefined {
	const slash = key.indexOf("/");
	const head = slash < 0 ? undefined : key.slice(0, slash);
	return isChatPlatform(head) ? head : undefined;
}

/**
 * `<platform>/<dm|ch>/<conversationId>[/t/<threadId>]` → its parts; `undefined` for every other key (monitors, work
 * lanes, malformed keys). Only the exact grammar is accepted: nothing is guessed or repaired.
 */
export function parseChatOrigin(key: string): ChatOriginRef | undefined {
	const parts = key.split("/");
	if (parts.length !== 3 && parts.length !== 5) return undefined;
	const [platform, kind, conversationId, marker, threadId] = parts;
	if (!isChatPlatform(platform) || (kind !== "dm" && kind !== "ch") || conversationId === undefined) return undefined;
	const grammar = GRAMMAR[platform];
	if (!grammar.conversation.test(conversationId)) return undefined;
	if (parts.length === 3) return { platform, kind, conversationId };
	if (marker !== "t" || threadId === undefined || !grammar.thread.test(threadId)) return undefined;
	return { platform, kind, conversationId, threadId };
}

/** The key of `ref`; the inverse of `parseChatOrigin`. */
export function chatOriginKey(ref: ChatOriginRef): string {
	const base = `${ref.platform}/${ref.kind}/${ref.conversationId}`;
	return ref.threadId === undefined ? base : `${base}/t/${ref.threadId}`;
}
