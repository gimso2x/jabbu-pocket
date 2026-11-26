import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
	CreateMessageArgs,
	DiscordChannelInfo,
	DiscordHandlers,
	DiscordMessageEvent,
	DiscordTransport,
	EditMessageArgs,
	FollowupInteractionArgs,
	MessageTarget,
	ReactionArgs,
	RespondInteractionArgs,
	StartThreadArgs,
	UploadFileArgs,
} from "./transport";

/** First id the fakes hand out; snowflake-sized so id handling sees realistic values. */
export const FAKE_ID_BASE = 900_000_000_000_000_000n;

/** Calls that mint a message id; their log lines also count the ids already handed out. */
const ID_METHODS = /"method":"(createMessage|uploadFile)"/;

/** Test-only transport (`JABBU_TEST_DISCORD_TRANSPORT=<file>`): calls go to a JSONL file that survives restarts; ids resume from it. */
export class FileFakeDiscordTransport implements DiscordTransport {
	#seq: bigint;

	constructor(
		private readonly path: string,
		private readonly ids: { botUserId: string; applicationId: string } = {
			botUserId: "500000000000000009",
			applicationId: "600000000000000009",
		},
	) {
		const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
		this.#seq = BigInt(lines.filter((line) => ID_METHODS.test(line)).length);
	}

	async start(_handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		return { ...this.ids };
	}

	async stop(): Promise<void> {}

	#log(entry: Record<string, unknown>): void {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}

	#nextId(): string {
		this.#seq += 1n;
		return String(FAKE_ID_BASE + this.#seq);
	}

	async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.#log({ method: "createMessage", ...args, id });
		return { id };
	}

	async editMessage(args: EditMessageArgs): Promise<void> {
		this.#log({ method: "editMessage", ...args });
	}

	async deleteMessage(args: MessageTarget): Promise<void> {
		this.#log({ method: "deleteMessage", ...args });
	}

	async addReaction(args: ReactionArgs): Promise<void> {
		this.#log({ method: "addReaction", ...args });
	}

	async removeReaction(args: ReactionArgs): Promise<void> {
		this.#log({ method: "removeReaction", ...args });
	}

	async startThread(args: StartThreadArgs): Promise<{ id: string }> {
		this.#log({ method: "startThread", ...args });
		return { id: args.messageId };
	}

	async archiveThread(args: { threadId: string }): Promise<void> {
		this.#log({ method: "archiveThread", ...args });
	}

	async pinMessage(args: MessageTarget): Promise<void> {
		this.#log({ method: "pinMessage", ...args });
	}

	async getChannel(channelId: string): Promise<DiscordChannelInfo> {
		// No guild state in file runs: every channel reads as a DM channel.
		return { id: channelId, type: 1 };
	}

	async listMessages(): Promise<DiscordMessageEvent[]> {
		return [];
	}

	async uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		const id = this.#nextId();
		this.#log({ method: "uploadFile", ...args, id });
		return { id };
	}

	async downloadAttachment(): Promise<void> {
		throw new Error("no attachments in file transport tests");
	}

	async respondInteraction(args: RespondInteractionArgs): Promise<void> {
		this.#log({ method: "respondInteraction", ...args });
	}

	async followupInteraction(args: FollowupInteractionArgs): Promise<void> {
		this.#log({ method: "followupInteraction", ...args });
	}

	async triggerTyping(channelId: string): Promise<void> {
		this.#log({ method: "triggerTyping", channelId });
	}
}
