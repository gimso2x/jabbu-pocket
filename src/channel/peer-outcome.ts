/** The core's verdict on a peer message: recorded (empty), a redelivery, or dropped (`notice`: post the cap notice now). */
export interface PeerInboundOutcome {
	duplicate?: true;
	dropped?: "peer_in_lane_thread" | "peer_hop_cap";
	notice?: boolean;
	/** Recorded but not dispatched (the bot is frozen): the adapter posts no ⏳ status. */
	held?: "frozen";
}
