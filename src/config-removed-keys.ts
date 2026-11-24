/**
 * Keys of the removed Slack channel: a config that still has one is refused with a note (no migration), so a Slack
 * setting never loads as a silent no-op.
 */
export const SLACK_KEYS = [
	"slack",
	"mentionFreeChannels",
	"peerBots",
	"requireMention",
	"escalationChannel",
	"logChannel",
] as const;
