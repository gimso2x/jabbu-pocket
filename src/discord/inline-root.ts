// Inline-reply channels (`channels.discord.inlineReplyChannels`): the owner's root message there is answered in the
// channel body, as a reply to it, by the channel's one session — no thread — unless the owner asks to split it out.
import { originKeyForChannel } from "../core/normalize";
import type { DiscordChannel } from "./channel";
import type { DiscordChannelInfo } from "./transport";

/** Type of a plain text channel: what a message id is cached as, so the port reads it as "not a thread". */
const GUILD_TEXT = 0;
/** Message ids remembered as plain messages at most; the oldest is forgotten past it (a lookup then asks Discord once). */
const MARK_LIMIT = 1000;

/**
 * Whether one owner line asks for its own thread: "이건 따로 빼줘[: 작업]", "<작업>을 새 스레드에서 해줘", "split this into a
 * new thread", "do <task> in a new thread". Only a single line that states the request counts: a negation, a question,
 * a quoted or backticked example and a multi-line message do not.
 */
export function wantsThreadSplit(line: string): boolean {
	const text = line.trim();
	if (text === "" || text.includes("\n")) return false;
	if (/[?？"'“”‘’「」『』`]/.test(text)) return false;
	if (/말고|말아|하지\s*마|없이|않|싫|\b(?:don't|do not|not|never|without|no need)\b/i.test(text)) return false;
	return SPLIT_REQUESTS.some((pattern) => pattern.test(text));
}

const THREAD_WORD = "(?:스레드|쓰레드)";
const ASK = "(?:줘|주세요|줘요)";
const END = "\\s*[.!]?$";
const SPLIT_REQUESTS: readonly RegExp[] = [
	new RegExp(
		`^(?:이건|이거|이거는)?\\s*(?:따로|별도로)\\s*(?:빼|빼서\\s*해|분리해)\\s*${ASK}(?:\\s*[:：]\\s*\\S.*|${END})`,
	),
	new RegExp(
		`^(?:이건|이거|이거는)?\\s*(?:(?:새|별도)\\s*)?${THREAD_WORD}\\s*(?:로|에)\\s*(?:따로\\s*)?(?:빼|분리해)\\s*${ASK}${END}`,
	),
	new RegExp(
		`^(?:.+?(?:은|는|을|를)\\s*)?(?:새|별도)\\s*${THREAD_WORD}\\s*(?:에서|로)\\s*(?:처리|진행|작업|답변)?\\s*해\\s*${ASK}${END}`,
	),
	/^(?:please\s+)?split\s+(?:this|that|it)\s+(?:out\s+)?(?:in)?to\s+a\s+new\s+thread[.!]?$/i,
	/^(?:please\s+)?do\s+.+?\s+in\s+a\s+new\s+thread[.!]?$/i,
];

/** The inline-reply channels: which root takes the channel session, and the plain-message marks that save lookups. */
export class InlineRoots {
	readonly #channels: ReadonlySet<string>;
	readonly #originOf: (platformMessageId: string) => string | undefined;
	readonly #port: Pick<DiscordChannel, "remember" | "forget">;
	readonly #marked = new Set<string>();

	constructor(
		options:
			| { channels?: readonly string[] | undefined; originOf?: (platformMessageId: string) => string | undefined }
			| undefined,
		port: Pick<DiscordChannel, "remember" | "forget">,
	) {
		this.#channels = new Set(options?.channels ?? []);
		this.#originOf = options?.originOf ?? (() => undefined);
		this.#port = port;
	}

	/**
	 * The channel origin a root owner message `text` is taken on, and the message is marked "not a thread" (its typing,
	 * status and answer need no lookup to know that); `undefined`: not an inline channel, or the owner asked for a thread.
	 */
	take(channelId: string, messageId: string, text: string): string | undefined {
		if (!this.#channels.has(channelId) || wantsThreadSplit(text)) return undefined;
		this.#mark(messageId);
		return originKeyForChannel(channelId, "channel", "discord");
	}

	/** The origin recorded for the message in `channelId`: a root's edit goes where the root went. */
	originOf(channelId: string, messageId: string): string | undefined {
		return this.#originOf(`${channelId}:${messageId}`);
	}

	/** A channel or thread the gateway reports: a thread opened from a marked message ends its mark. */
	remember(info: DiscordChannelInfo): void {
		this.#marked.delete(info.id);
		this.#port.remember(info);
	}

	#mark(messageId: string): void {
		this.#marked.delete(messageId);
		this.#marked.add(messageId);
		this.#port.remember({ id: messageId, type: GUILD_TEXT });
		const oldest = this.#marked.values().next().value;
		if (this.#marked.size > MARK_LIMIT && oldest !== undefined) {
			this.#marked.delete(oldest);
			this.#port.forget(oldest);
		}
	}
}
