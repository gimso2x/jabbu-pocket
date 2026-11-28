// Options of `DiscordAdapter` (see `adapter.ts`): the port, the core sink, the owner, the recovery
// behind `recover()` and the per-channel policy. Kept apart so `adapter.ts` stays under its LOC baseline.
import type { PeerBotList } from "../channel/inbound";
import type { AdapterClock, CoreSink, DeliverySource } from "../channel/types";
import type { Logger } from "../log";
import type { BackfillCursors, BackfillTarget } from "./backfill";
import type { DiscordChannel } from "./channel";
import type { InlineRoots } from "./inline-root";
import type { TypingTimers } from "./typing";

export interface DiscordAdapterOptions {
	/** The port: its transport carries every call, its channel cache tells threads from messages. */
	channel: DiscordChannel;
	core: CoreSink;
	deliveries: DeliverySource;
	ownerUserId: string;
	clock: AdapterClock;
	log: Logger;
	/** Servers whose messages are taken; absent: every server. DMs are not affected. */
	guildIds?: readonly string[] | undefined;
	/** Channel ids where the owner's message counts as addressed without a mention. */
	mentionFreeChannels?: readonly string[] | undefined;
	/** The Discord #log ledger channel (`channels.discord.logChannelId`): inbound there or in its threads never becomes a turn. */
	logChannel?: string | undefined;
	/** `channels.discord.inlineReplyChannels` and a lookup of a message's recorded origin (an edit goes where its original went). */
	inline?: ConstructorParameters<typeof InlineRoots>[0];
	/** In a server channel only a mention addresses the bot. */
	requireMention?: boolean | undefined;
	/** Peer bots whose server channel messages that mention this bot are taken (`channels.discord.peerBots`). */
	peerBots?: PeerBotList | undefined;
	/** Peer input cap per thread (top-level `peerHopLimit`). Default `DEFAULT_PEER_HOP_LIMIT`. */
	peerHopLimit?: { turns: number; windowMinutes: number } | undefined;
	/** Whether a thread root is a registered [TASK]: its status reaction belongs to the task sweep. */
	isTaskRoot?: ((threadRef: string) => boolean) | undefined;
	/** Called after a live message failed as `inbound_failed` (the missed-message recovery trigger). */
	onInboundFailure?: (() => void) | undefined;
	/**
	 * Missed-message recovery behind `recover()`: the watermarks and the channels to read (asked at every pass).
	 * Absent: `recover()` does nothing.
	 */
	recovery?: { cursors: BackfillCursors; targets(): BackfillTarget[]; maxPages?: number | undefined } | undefined;
	/** Directory for downloaded inbound attachments (`<home>/media`); without it attachments are skipped with a note. */
	mediaRoot?: string | undefined;
	/** The typing indicator's interval timer (tests fire it by hand). Default `setInterval`/`clearInterval`, unref'd. */
	typingTimers?: TypingTimers | undefined;
	/** How long `start()` waits for the first Ready before it lets the daemon go on. Default `START_WAIT_MS`. */
	startWaitMs?: number | undefined;
	/** How long a mentioned peer post waits for the rest of its split answer. Default `PEER_PART_WAIT_MS`; 0: no wait. */
	peerPartWaitMs?: number | undefined;
	/** A fatal gateway close after `start()` returned: the daemon drops this adapter (see `AdapterDeps.detach`). */
	onFatal?: ((error: Error) => void) | undefined;
}
