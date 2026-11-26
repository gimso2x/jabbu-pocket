import type { ChatPlatform } from "../core/origin-key";
import type { CardTone } from "./card";

export interface MessageRef {
	platform: ChatPlatform;
	conversationId: string;
	messageId: string;
	threadId?: string;
}

export interface PostTarget {
	conversationId: string;
	/** Absent: the conversation's main view. */
	threadId?: string;
}

export interface ActionButton {
	actionId: string;
	label: string;
	/** Payload the platform hands back with the click. */
	value?: string;
	style?: "primary" | "danger";
}

export interface OutboundMessage {
	/** The text as the core writes it today (mrkdwn); P1 does no format conversion. */
	text: string;
	/** Buttons under the text. `[]` on an edit removes the buttons an earlier version had. */
	buttons?: readonly ActionButton[];
	/** One small line under the buttons (a deadline); a plain message shows it only with buttons, a card on its own too. */
	buttonsNote?: string;
	/** Card title (a port without cards ignores it and `text` carries everything. */
	title?: string;
	/** Card body in place of `text`, which then only serves notifications and clients that cannot show the card. */
	body?: string;
	/** Labelled values under the body (a card's fields). */
	fields?: ReadonlyArray<{ label: string; value: string }>;
	/** Embed colour tone (`ok` | `warn` | `danger` | `info`) for platforms that support rich cards. */
	tone?: CardTone;
}

export interface ChannelPort {
	readonly platform: ChatPlatform;
	post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef>;
	edit(ref: MessageRef, msg: OutboundMessage): Promise<void>;
	/** Pins `ref` in its channel when the platform supports pinning. */
	pin?(ref: MessageRef): Promise<void>;
	/** Adds (`on`) or removes one reaction emoji by name. */
	react(ref: MessageRef, name: string, on: boolean): Promise<void>;
	uploadFile(target: PostTarget, file: { path: string; title?: string; comment?: string }): Promise<{ fileId: string }>;
	/** Link to one message (a thread root links to its thread); `undefined` when the platform has none. */
	permalink(ref: MessageRef): Promise<string | undefined>;
	mentionUser(userId: string): string;
	/** Starts a thread from `ref` (its id becomes the thread id); absent where replies already thread. */
	openThread?(ref: MessageRef, name: string): Promise<void>;
	/** Archives the thread of `ref` (Discord: the thread id is `ref.threadId ?? ref.messageId`); absent where there is no such state. */
	archiveThread?(ref: MessageRef): Promise<void>;
	/** Cached channel name, topic, and thread name (no network call); absent where the platform has none. */
	conversationContext?(conversationId: string, threadId?: string): ConversationContext | undefined;
}

/** Name of the channel and thread a conversation sits in, and the channel topic; each only when known. */
export interface ConversationContext {
	channelName?: string;
	topic?: string;
	threadName?: string;
}

/**
 * Platform-neutral mention inside core text. Formatters that have no port at hand write it; `renderMentions` swaps it
 * for the port's own mention syntax right before the post.
 */
export const mentionToken = (userId: string): string => `{{mention:${userId}}}`;

const MENTION_TOKEN = /\{\{mention:([^{}\s]+)\}\}/g;

export function renderMentions(text: string, port: Pick<ChannelPort, "mentionUser">): string {
	return text.replace(MENTION_TOKEN, (_, userId: string) => port.mentionUser(userId));
}
