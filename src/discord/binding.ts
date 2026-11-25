// Discord's plug into the daemon: port, adapter (with `recover()`) and thread reader, built from `channels.discord`.
import { join } from "node:path";
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../channel/adapter";
import type { ThreadMessage } from "../core/mailbox-thread-context";
import { DiscordAdapter } from "./adapter";
import { snowflakeTime } from "./backfill";
import { discordBackfillTargets } from "./backfill-targets";
import type { DiscordChannel } from "./channel";
import type { DiscordMessageEvent } from "./transport";

/** Pages of a thread read for a whole-thread context (oldest first); a longer thread is cut. */
const THREAD_CONTEXT_MAX_PAGES = 5;
const THREAD_PAGE_LIMIT = 100;

/** A Discord message as the mailbox's thread context reads it (`ts` is the message id). */
function threadMessage(message: DiscordMessageEvent): ThreadMessage {
	return {
		ts: message.id,
		text: message.content,
		user: message.author.id,
		botId: message.author.bot === true ? message.author.id : undefined,
		at: snowflakeTime(message.id),
	};
}

type BindingOptions = { backfillMaxPages?: number; startWaitMs?: number; peerPartWaitMs?: number };
export class DiscordBinding implements ChannelBinding {
	readonly port: DiscordChannel;
	readonly #options: BindingOptions;

	constructor(port: DiscordChannel, options: BindingOptions = {}) {
		this.port = port;
		this.#options = options;
	}

	createAdapter(deps: AdapterDeps): ChannelAdapter {
		const discord = deps.config.channels.discord;
		if (discord === undefined) throw new Error("discord binding without channels.discord");
		const { store } = deps;
		this.port.useButtonValues(store);
		const adapter = new DiscordAdapter({
			channel: this.port,
			core: deps.core,
			deliveries: deps.deliveries,
			ownerUserId: discord.ownerUserId,
			clock: deps.clock,
			log: deps.log,
			guildIds: discord.guildIds,
			mentionFreeChannels: discord.mentionFreeChannels,
			inline: { channels: discord.inlineReplyChannels, originOf: (id) => store.getInbound(id)?.originKey },
			logChannel: discord.logChannelId,
			requireMention: discord.requireMention,
			peerBots: discord.peerBots,
			peerHopLimit: deps.config.peerHopLimit,
			isTaskRoot: (threadRef) => store.tasks.isTaskRoot(threadRef),
			onInboundFailure: () => adapter.recover(),
			startWaitMs: this.#options.startWaitMs,
			peerPartWaitMs: this.#options.peerPartWaitMs,
			onFatal: deps.detach,
			mediaRoot: join(deps.config.homeDir, "media"),
			recovery: {
				cursors: store,
				maxPages: this.#options.backfillMaxPages,
				targets: () => discordBackfillTargets(store),
			},
		});
		return adapter;
	}

	/**
	 * Messages of a server thread oldest-first with its root leading. The root is the message the thread was started
	 * from: it lives in the parent channel under the thread's own id, so it is the first message after `id − 1` there.
	 * A `limit` (the root only) is that single read.
	 */
	readonly readThread = async (channel: string, threadTs: string, limit?: number): Promise<ThreadMessage[]> => {
		const transport = this.port.transport;
		const [root] = await transport.listMessages({ channelId: channel, after: String(BigInt(threadTs) - 1n), limit: 1 });
		const out = root?.id === threadTs ? [threadMessage(root)] : [];
		if (limit !== undefined) return out;
		let after = threadTs;
		for (let page = 0; page < THREAD_CONTEXT_MAX_PAGES; page++) {
			const messages = await transport.listMessages({ channelId: threadTs, after, limit: THREAD_PAGE_LIMIT });
			out.push(...messages.map(threadMessage));
			const last = messages.at(-1);
			if (last === undefined || messages.length < THREAD_PAGE_LIMIT) break;
			after = last.id;
		}
		return out;
	};
}
