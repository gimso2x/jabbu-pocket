import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
	type AllowedMentions,
	type CreateMessageArgs,
	DiscordCallError,
	type DiscordChannelInfo,
	type DiscordMessageEvent,
	DiscordRateLimitedError,
	type EditMessageArgs,
	type FollowupInteractionArgs,
	type ListMessagesArgs,
	MESSAGE_CONTENT_LIMIT,
	type MessageReference,
	type MessageTarget,
	parseChannelInfo,
	type ReactionArgs,
	type RespondInteractionArgs,
	type StartThreadArgs,
	UPLOAD_LIMIT_BYTES,
	type UploadFileArgs,
} from "./transport";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord requires `DiscordBot (<url>, <version>)`; the version names this client, not the bot release. */
const DEFAULT_USER_AGENT = "DiscordBot (https://jabbu.invalid, 1)";

export interface DiscordRestOptions {
	token: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
}

/**
 * Path segments that name the resource a rate-limit bucket belongs to (Discord's "major parameters"). An
 * interaction's id and token, and a webhook's id and token, stay whole: each interaction is its own bucket.
 */
const MAJOR_PARENTS: Record<string, true> = { channels: true, guilds: true, webhooks: true, interactions: true };

/** Routes outside the bot's global rate limit (Discord: interaction endpoints are not bound to it). */
const GLOBAL_EXEMPT = /^\/(interactions|webhooks)\//;

/** Rate-limit key: method plus the path with minor ids and emoji collapsed (messages 2 and 3 share one). Keys can hold a token: never logged. */
function routeKey(method: string, path: string): string {
	const parts = (path.split("?")[0] ?? "").split("/");
	const normalized = parts.map((segment, i) => {
		if (MAJOR_PARENTS[parts[i - 1] ?? ""] === true) return segment;
		if (parts[i - 2] === "webhooks" || parts[i - 2] === "interactions") return segment;
		if (parts[i - 1] === "reactions") return ":emoji";
		return /^[0-9]+$/.test(segment) ? ":id" : segment;
	});
	return `${method} ${normalized.join("/")}`;
}

function checkContent(content: string | undefined): void {
	if (content !== undefined && content.length > MESSAGE_CONTENT_LIMIT)
		throw new DiscordCallError(
			"definitive",
			`discord content too long: ${content.length} > ${MESSAGE_CONTENT_LIMIT} characters`,
		);
}

/** A delivery nonce goes out together with `enforce_nonce`, so Discord drops a repost of the same part. */
function nonce(nonceValue: string | undefined): Record<string, unknown> {
	return nonceValue === undefined ? {} : { nonce: nonceValue, enforce_nonce: true };
}

function reference(ref: MessageReference | undefined): Record<string, unknown> {
	return ref === undefined ? {} : { message_reference: { message_id: ref.messageId, fail_if_not_exists: false } };
}

function mentions(allowed: AllowedMentions | undefined): Record<string, unknown> {
	return allowed === undefined ? {} : { allowed_mentions: allowed };
}

/** Seconds (possibly fractional) to whole milliseconds; `undefined` when absent or not a number. */
function secondsToMs(value: unknown): number | undefined {
	const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

type RequestBody = { json: unknown } | { form: FormData };

/** Discord REST v10 over fetch with per-route/global 429 tracking; callers decide retries (4xx definitive, 5xx ambiguous). */
export class DiscordRest {
	readonly #token: string;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	/** Route key → epoch ms when its spent bucket resets. */
	readonly #blocked = new Map<string, number>();
	#globalUntil = 0;

	constructor(options: DiscordRestOptions) {
		this.#token = options.token;
		this.#baseUrl = (options.baseUrl ?? DISCORD_API_BASE).replace(/\/$/, "");
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? 15_000;
	}

	/** Latest reset among the currently blocked routes (and a global block); 0 when nothing is blocked. */
	blockedUntil(): number {
		const now = this.#now();
		let until = this.#globalUntil > now ? this.#globalUntil : 0;
		for (const [key, reset] of this.#blocked) {
			if (reset <= now) this.#blocked.delete(key);
			else if (reset > until) until = reset;
		}
		return until;
	}

	blockedCount(): number {
		return this.#blocked.size;
	}

	async #request(method: string, path: string, body?: RequestBody): Promise<unknown> {
		const key = routeKey(method, path);
		const now = this.#now();
		// Per-interaction keys never repeat: drop entries whose reset has passed, or they pile up.
		for (const [blockedKey, reset] of this.#blocked) if (reset <= now) this.#blocked.delete(blockedKey);
		const globalUntil = GLOBAL_EXEMPT.test(path) ? 0 : this.#globalUntil;
		const until = Math.max(globalUntil, this.#blocked.get(key) ?? 0);
		if (until > now) throw new DiscordRateLimitedError(until - now, globalUntil > now);

		const headers: Record<string, string> = { authorization: `Bot ${this.#token}`, "user-agent": DEFAULT_USER_AGENT };
		let payload: string | FormData | undefined;
		if (body !== undefined && "json" in body) {
			headers["content-type"] = "application/json";
			payload = JSON.stringify(body.json);
		} else if (body !== undefined) payload = body.form;
		let res: Response;
		try {
			res = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers,
				body: payload,
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (err) {
			const error = err as Error;
			throw new DiscordCallError(
				"ambiguous",
				`discord request failed: ${method} /${path.split("/")[1] ?? ""}: ${error.name}: ${error.message}`,
			);
		}

		const text = await res.text().catch(() => "");
		let parsed: unknown;
		try {
			parsed = text === "" ? undefined : JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const fields = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

		if (res.status === 429) {
			const retryAfterMs = secondsToMs(fields.retry_after) ?? secondsToMs(res.headers.get("retry-after")) ?? 1_000;
			const global =
				fields.global === true ||
				res.headers.get("x-ratelimit-global") === "true" ||
				res.headers.get("x-ratelimit-scope") === "global";
			const reset = this.#now() + retryAfterMs;
			if (global) this.#globalUntil = reset;
			else this.#blocked.set(key, reset);
			throw new DiscordRateLimitedError(retryAfterMs, global);
		}

		const resetAfter = secondsToMs(res.headers.get("x-ratelimit-reset-after"));
		if (res.headers.get("x-ratelimit-remaining") === "0" && resetAfter !== undefined) {
			this.#blocked.set(key, this.#now() + resetAfter);
		} else if ((this.#blocked.get(key) ?? 0) <= now) {
			// Only an expired block goes: a response that was in flight when a 429 set one must not lift it.
			this.#blocked.delete(key);
		}

		if (res.ok) {
			if (res.status !== 204 && text !== "" && parsed === undefined)
				throw new DiscordCallError("ambiguous", `discord ${method} returned HTTP ${res.status} without JSON`);
			return parsed;
		}
		const code = typeof fields.code === "number" ? fields.code : undefined;
		const message = typeof fields.message === "string" ? ` ${fields.message}` : "";
		throw new DiscordCallError(
			res.status >= 500 ? "ambiguous" : "definitive",
			`discord_http_${res.status}${code === undefined ? "" : `:${code}`}${message}`,
			res.status,
			code,
		);
	}

	/** `GET /gateway/bot`: the WebSocket URL to connect to. */
	async getGatewayBot(): Promise<{ url: string }> {
		const body = (await this.#request("GET", "/gateway/bot")) as { url?: unknown } | undefined;
		if (typeof body?.url !== "string") throw new DiscordCallError("ambiguous", "GET /gateway/bot returned no url");
		return { url: body.url };
	}

	/** `GET /users/@me`: the bot's own user (doctor's token check). */
	async getCurrentUser(): Promise<{ id: string; username: string | undefined }> {
		const body = (await this.#request("GET", "/users/@me")) as { id?: unknown; username?: unknown } | undefined;
		if (typeof body?.id !== "string") throw new DiscordCallError("ambiguous", "GET /users/@me returned no id");
		return { id: body.id, username: typeof body.username === "string" ? body.username : undefined };
	}

	/** `PATCH /users/@me`: the global display name (DMs and nickname-less servers show it; a username is ASCII only). */
	async patchCurrentUser(args: { displayName: string }): Promise<void> {
		await this.#request("PATCH", "/users/@me", { json: { display_name: args.displayName } });
	}

	async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		checkContent(args.content);
		const body = await this.#request("POST", `/channels/${args.channelId}/messages`, {
			json: {
				...(args.content === undefined ? {} : { content: args.content }),
				...(args.embeds === undefined ? {} : { embeds: args.embeds }),
				...(args.components === undefined ? {} : { components: args.components }),
				...reference(args.messageReference),
				...mentions(args.allowedMentions),
				...nonce(args.nonce),
			},
		});
		return { id: messageId(body, "create message") };
	}

	async editMessage(args: EditMessageArgs): Promise<void> {
		checkContent(args.content);
		await this.#request("PATCH", `/channels/${args.channelId}/messages/${args.messageId}`, {
			json: {
				...(args.content === undefined ? {} : { content: args.content }),
				...(args.embeds === undefined ? {} : { embeds: args.embeds }),
				...(args.components === undefined ? {} : { components: args.components }),
				...mentions(args.allowedMentions),
			},
		});
	}

	async deleteMessage(args: MessageTarget): Promise<void> {
		await this.#request("DELETE", `/channels/${args.channelId}/messages/${args.messageId}`);
	}

	async addReaction(args: ReactionArgs): Promise<void> {
		await this.#request(
			"PUT",
			`/channels/${args.channelId}/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}/@me`,
		);
	}

	async removeReaction(args: ReactionArgs): Promise<void> {
		await this.#request(
			"DELETE",
			`/channels/${args.channelId}/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}/@me`,
		);
	}

	async startThread(args: StartThreadArgs): Promise<{ id: string }> {
		const body = await this.#request("POST", `/channels/${args.channelId}/messages/${args.messageId}/threads`, {
			json: { name: args.name, auto_archive_duration: 1440 }, // hide after 24h idle, not the channel default (days)
		});
		return { id: messageId(body, "start thread") };
	}

	async archiveThread(args: { threadId: string }): Promise<void> {
		await this.#request("PATCH", `/channels/${args.threadId}`, { json: { archived: true } });
	}

	async pinMessage(args: MessageTarget): Promise<void> {
		await this.#request("PUT", `/channels/${args.channelId}/pins/${args.messageId}`);
	}

	async getChannel(channelId: string): Promise<DiscordChannelInfo> {
		return channelInfo(await this.#request("GET", `/channels/${channelId}`), "GET /channels");
	}

	async listMessages(args: ListMessagesArgs): Promise<DiscordMessageEvent[]> {
		const limit = args.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new DiscordCallError("definitive", `discord message list limit must be 1-100, got ${limit}`);
		const query = new URLSearchParams();
		if (args.after !== undefined) query.set("after", args.after);
		query.set("limit", String(limit));
		const body = await this.#request("GET", `/channels/${args.channelId}/messages?${query}`);
		if (!Array.isArray(body)) throw new DiscordCallError("ambiguous", "GET /messages returned no list");
		// Discord answers newest-first; callers scan oldest-first.
		return (body as DiscordMessageEvent[]).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
	}

	async uploadFile(args: UploadFileArgs): Promise<{ id: string }> {
		checkContent(args.content);
		let size: number;
		try {
			size = (await stat(args.filePath)).size;
		} catch (err) {
			throw new DiscordCallError(
				"definitive",
				`discord upload: cannot read file (${(err as NodeJS.ErrnoException).code})`,
			);
		}
		if (size > UPLOAD_LIMIT_BYTES)
			throw new DiscordCallError("definitive", `discord upload too large: ${size} bytes > 25 MiB`);
		const filename = args.filename ?? basename(args.filePath);
		const form = new FormData();
		form.append(
			"payload_json",
			JSON.stringify({
				...(args.content === undefined ? {} : { content: args.content }),
				attachments: [{ id: 0, filename }],
				...reference(args.messageReference),
				...mentions(args.allowedMentions),
				...nonce(args.nonce),
			}),
		);
		form.append("files[0]", Bun.file(args.filePath), filename);
		const body = await this.#request("POST", `/channels/${args.channelId}/messages`, { form });
		return { id: messageId(body, "upload") };
	}

	async respondInteraction(args: RespondInteractionArgs): Promise<void> {
		await this.#request("POST", `/interactions/${args.interactionId}/${args.token}/callback`, { json: args.response });
	}

	/** `POST /webhooks/{app}/{token}`: a message after the acknowledgement (the token outlives the 3 s callback). */
	async followupInteraction(args: FollowupInteractionArgs): Promise<void> {
		checkContent(args.content);
		await this.#request("POST", `/webhooks/${args.applicationId}/${args.token}`, {
			json: {
				...(args.content === undefined ? {} : { content: args.content }),
				...(args.flags === undefined ? {} : { flags: args.flags }),
			},
		});
	}

	/** `POST /channels/{id}/typing` (no body): the typing indicator for about 10 s. */
	async triggerTyping(channelId: string): Promise<void> {
		await this.#request("POST", `/channels/${channelId}/typing`);
	}
}

/** A channel object as the adapter caches it. */
function channelInfo(value: unknown, what: string): DiscordChannelInfo {
	const info = parseChannelInfo(value);
	if (info === undefined) throw new DiscordCallError("ambiguous", `${what} returned no channel`);
	return info;
}

/** The `id` of a created message or thread; a 2xx without one leaves the outcome unknown. */
function messageId(body: unknown, what: string): string {
	const id = typeof body === "object" && body !== null && "id" in body ? body.id : undefined;
	if (typeof id !== "string") throw new DiscordCallError("ambiguous", `discord ${what} returned no id`);
	return id;
}
