// Discord's inbound policy under `channels.discord`: the connection keys a reload applies without a restart, and the
// `ChannelPolicy` the daemon hands the running adapter. Nothing bound at daemon start reads them, so they need no restart.
import type { ChannelPolicy } from "../channel/adapter";
import type { JabbuConfig } from "../config";

/** The `channels.discord` keys a reload applies live: the owner's connection policy, not a startup resource. */
const LIVE_DISCORD_KEYS = ["guildIds", "mentionFreeChannels", "requireMention"] as const;

type DiscordConfig = NonNullable<JabbuConfig["channels"]["discord"]>;

/**
 * `channels` text without the live Discord policy keys: a missing `discord` reads like one that carries only those keys
 * (both leave no boot-bound setting behind), so only a real startup-bound difference reaches the comparison.
 */
function bootBoundChannels(channels: JabbuConfig["channels"]): string {
	const { discord, ...rest } = channels;
	const bootBound: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(discord ?? {}))
		if (!(LIVE_DISCORD_KEYS as readonly string[]).includes(key)) bootBound[key] = value;
	return JSON.stringify({ ...rest, discord: bootBound });
}

/**
 * A `channels` difference that stays inside Discord's live policy keys applies without a restart: `next` takes the new
 * `channels`, `restartRequired` drops `channels`, and the changed sub-paths are returned. Any other difference — or a
 * `channels` already judged restart-bound — leaves all three alone and returns nothing.
 */
export function applyLiveChannelsReload(
	next: JabbuConfig,
	current: JabbuConfig,
	fresh: JabbuConfig,
	restartRequired: string[],
): string[] {
	if (!restartRequired.includes("channels")) return [];
	if (bootBoundChannels(current.channels) !== bootBoundChannels(fresh.channels)) return [];
	const currentDiscord = current.channels.discord;
	const freshDiscord = fresh.channels.discord;
	const changed: string[] = [];
	for (const key of LIVE_DISCORD_KEYS)
		if (JSON.stringify(currentDiscord?.[key]) !== JSON.stringify(freshDiscord?.[key]))
			changed.push(`channels.discord.${key}`);
	if (changed.length === 0) return [];
	next.channels = fresh.channels;
	restartRequired.splice(restartRequired.indexOf("channels"), 1);
	return changed;
}

/** What a reload hands the Discord adapter: the three live keys and the top-level peer hop cap (`channels.discord.logChannelId` and friends stay put). */
export function discordPolicyOf(config: JabbuConfig): ChannelPolicy {
	const discord: DiscordConfig | undefined = config.channels.discord;
	return {
		guildIds: discord?.guildIds,
		mentionFreeChannels: discord?.mentionFreeChannels ?? [],
		requireMention: discord?.requireMention === true,
		...(config.peerHopLimit === undefined ? {} : { peerHopLimit: config.peerHopLimit }),
	};
}
