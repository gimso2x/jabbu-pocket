import { type JabbuConfig, peerSilenceMinutes } from "../config";
import { COMMAND_OP_REF, type MailboxClock } from "../core/types";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { redact } from "../redact";
import { type LogChannels, type PeerCallPolicy, Store } from "../store/db";
import type { DeliveryRow, InboundRow } from "../store/db-rows";
import type { CrashPoint } from "./crash";

/** The peer call policy of a config: Discord peer bots with `peerSilenceAlert` on; `undefined` (off) otherwise. */
export function peerCallPolicyOf(config: JabbuConfig): PeerCallPolicy | undefined {
	const discord = config.channels.discord;
	if (!discord?.peerBots?.length || peerSilenceMinutes(config) === 0) return undefined;
	return {
		peers: discord.peerBots,
		skipConversations: [discord.logChannelId].filter((id) => id !== undefined),
		ownerUserId: discord.ownerUserId,
		silenceMs: peerSilenceMinutes(config) * 60_000,
	};
}

/** The ledger with the crash hooks and a delivery nudge wired into the state changes that matter. */
export class DaemonStore extends Store {
	constructor(
		path: string,
		clock: MailboxClock,
		private readonly crash: (point: CrashPoint) => void,
		private readonly nudge: () => void,
		log: Logger,
		logChannel: LogChannels,
		timezone: string,
	) {
		super({
			path,
			clock,
			timezone,
			redact,
			logChannel,
			hooks: {
				afterInboundAnswered: () => crash("after_final_before_answered"),
				onDeliveryState: ({ deliveryId, from, to }) => log.info("delivery_state", { id: deliveryId, from, to }),
				onInboundConflict: ({ platformMessageId, originKey, storedSha, newSha, storedLength, newLength }) =>
					log.warn("inbound_identity_conflict", {
						id: platformMessageId,
						origin: originKey,
						stored: storedSha,
						received: newSha,
						storedLength,
						receivedLength: newLength,
					}),
				onOwnerNoticeUnroutable: ({ originKey, opRef }) =>
					log.warn("owner_notice_unroutable", { origin: originKey, op: opRef }),
				onExpiredDropped: (dropped) => log.warn("expired_dropped", { ids: dropped.map((r) => r.deliveryId) }),
			},
		});
	}

	override markDispatched(...args: Parameters<Store["markDispatched"]>): InboundRow {
		const row = super.markDispatched(...args);
		// Only a real prompt/steer counts; command and failure bookkeeping uses synthetic op refs.
		if (!COMMAND_OP_REF.test(args[1].opRef)) this.crash("after_dispatch");
		return row;
	}

	override recordAnswer(...args: Parameters<Store["recordAnswer"]>): DeliveryRow[] {
		const rows = super.recordAnswer(...args);
		// A completed real turn ends the origin's failure run (chat commands and monitor events are not turn
		// successes), so the next run of failures alerts as a fresh incident.
		if (!COMMAND_OP_REF.test(args[0].opRef) && !args[0].originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
			this.resolveAlertIncidents(`turns:${args[0].originKey}`);
		}
		this.crash("after_answered");
		this.nudge();
		return rows;
	}

	/** A running turn's text goes out right away; whether the turn succeeded is judged at its end (no incident reset). */
	override recordInterim(...args: Parameters<Store["recordInterim"]>): DeliveryRow {
		const row = super.recordInterim(...args);
		this.nudge();
		return row;
	}

	override recordTurnFailure(...args: Parameters<Store["recordTurnFailure"]>): DeliveryRow | undefined {
		const row = super.recordTurnFailure(...args);
		if (row) this.nudge();
		return row;
	}
}
