import { downloadDiscordAttachment } from "./attachments";
import { DiscordGateway } from "./gateway";
import { DiscordRest } from "./rest";
import {
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordChannelInfo,
	type DiscordGatewayFatalError,
	type DiscordHandlers,
	type DiscordMessageEvent,
	type DiscordTransport,
	type DownloadAttachmentArgs,
	type EditMessageArgs,
	type FollowupInteractionArgs,
	type ListMessagesArgs,
	type MessageTarget,
	type ReactionArgs,
	type RespondInteractionArgs,
	type StartThreadArgs,
	type UploadFileArgs,
} from "./transport";

/** Gateway lifecycle event surfaced to the daemon's structured log; `detail` is body-less (never the token). */
export interface GatewayLifecycleEvent {
	type: "connected" | "reconnecting" | "error" | "display_name_failed";
	detail?: string;
}

export interface DiscordSocketTransportOptions {
	/** REST base (tests point it at a local server); the gateway URL comes from its `GET /gateway/bot`. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** Applied once at start as the bot's global display name (`PATCH /users/@me`); a failure is logged, not fatal. */
	displayName?: string;
	/** Every Ready/Resumed; a new session (`resumed: false`) is where missed-message backfill starts. */
	onReady?: (info: { resumed: boolean }) => void;
	/** A non-retryable gateway close: Discord stops, the rest of the daemon keeps running. */
	onFatal?: (error: DiscordGatewayFatalError) => void;
	onLifecycle?: (event: GatewayLifecycleEvent) => void;
}

/** Gateway + REST. The token is passed in by the caller (read from its secret file by config); never logged here. */
export class DiscordSocketTransport implements DiscordTransport {
	readonly #token: string;
	readonly #rest: DiscordRest;
	readonly #options: DiscordSocketTransportOptions;
	readonly #createdAt = Date.now();
	#gateway: DiscordGateway | undefined;
	readonly archiveThread = (args: { threadId: string }): Promise<void> => this.#rest.archiveThread(args);
	readonly pinMessage = (args: MessageTarget): Promise<void> => this.#rest.pinMessage(args);
	readonly triggerTyping = (channelId: string): Promise<void> => this.#rest.triggerTyping(channelId);

	constructor(tokens: { botToken: string }, options: DiscordSocketTransportOptions = {}) {
		this.#token = tokens.botToken;
		this.#options = options;
		this.#rest = new DiscordRest({
			token: tokens.botToken,
			...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
			...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
		});
	}

	async start(handlers: DiscordHandlers): Promise<{ botUserId: string; applicationId: string }> {
		if (this.#gateway !== undefined) throw new Error("discord transport already started");
		const lifecycle = this.#options.onLifecycle ?? (() => {});
		const gateway = new DiscordGateway({
			token: this.#token,
			url: async () => (await this.#rest.getGatewayBot()).url,
			handlers,
			onReady: (info) => {
				lifecycle({ type: "connected", ...(info.resumed ? { detail: "resumed" } : {}) });
				this.#options.onReady?.(info);
				handlers.ready?.(info);
			},
			onFatal: (error) => {
				this.#options.onFatal?.(error);
				handlers.fatal?.(error);
			},
			// Structured only: the daemon logs this as `discord_gateway_error`, so a console line here would log
			// every gateway error twice (stderr/journal and jabbu.log).
			onError: (error) => lifecycle({ type: "error", detail: error.message }),
			onReconnect: (reason) => lifecycle({ type: "reconnecting", detail: reason }),
		});
		this.#gateway = gateway;
		let ids: { botUserId: string; applicationId: string };
		try {
			ids = await gateway.start();
		} catch (err) {
			// Failed start leaves no stale gateway so a later start() creates a fresh one.
			if (this.#gateway === gateway) this.#gateway = undefined;
			throw err;
		}
		const displayName = this.#options.displayName;
		if (displayName !== undefined) {
			await this.#rest
				.patchCurrentUser({ displayName })
				// Logged, not fatal: the failure reaches the structured log as `discord_display_name_failed`
				// (the daemon's `onLifecycle` handler) instead of an unstructured console line jabbu.log greps miss.
				.catch((err: Error) => lifecycle({ type: "display_name_failed", detail: err.message }));
		}
		return ids;
	}

	connectionState(): { state: "up" | "down"; since: number } {
		return this.#gateway?.connectionState() ?? { state: "down", since: this.#createdAt };
	}

	async stop(): Promise<void> {
		this.#gateway?.stop();
		this.#gateway = undefined;
	}

	/** When the latest spent REST bucket reopens (0 = none); the delivery pump defers instead of posting into it. */
	blockedUntil(): number {
		return this.#rest.blockedUntil();
	}

	createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		return this.#rest.createMessage(args);
	}

	editMessage(args: EditMessageArgs): Promise<void> {
		return this.#rest.editMessage(args);
	}

	deleteMessage(args: MessageTarget): Promise<void> {
		return this.#rest.deleteMessage(args);
	}

	addReaction(args: ReactionArgs): Promise<void> {
		return this.#rest.addReaction(args);
	}

	removeReaction(args: ReactionArgs): Promise<void> {
		return this.#rest.removeReaction(args);
	}

	startThread(args: StartThreadArgs): Promise<{ id: string }> {
		return this.#rest.startThread(args);
	}

	getChannel(channelId: string): Promise<DiscordChannelInfo> {
		return this.#rest.getChannel(channelId);
	}

	listMessages(args: ListMessagesArgs): Promise<DiscordMessageEvent[]> {
		return this.#rest.listMessages(args);
	}

	uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		return this.#rest.uploadFile(args);
	}

	async downloadAttachment(args: DownloadAttachmentArgs): Promise<void> {
		const result = await downloadDiscordAttachment({
			...args,
			...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
		});
		if (!result.ok) throw new DiscordCallError("definitive", `attachment_download_failed:${result.error}`);
	}

	respondInteraction(args: RespondInteractionArgs): Promise<void> {
		return this.#rest.respondInteraction(args);
	}

	followupInteraction(args: FollowupInteractionArgs): Promise<void> {
		return this.#rest.followupInteraction(args);
	}
}
