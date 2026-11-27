// Acknowledging a Discord button click inside its 3 s window, with one retry for a transient failure.
import { errorText } from "../channel/text";
import type { AdapterClock } from "../channel/types";
import type { Logger } from "../log";
import { DiscordCallError, type DiscordInteraction, DiscordRateLimitedError, type DiscordTransport } from "./transport";

/** Discord's 3 s window for acknowledging a click, less the margin for the retry itself to land. */
const ACK_WINDOW_MS = 3_000;
const ACK_MARGIN_MS = 250;
/** Discord's code for an interaction that was already acknowledged: the ACK is in effect. */
const ALREADY_ACKNOWLEDGED_CODE = 40060;

/**
 * Acknowledges a click inside Discord's 3 s window. A rate-limited ACK waits out `retry_after` and tries once
 * more; an ambiguous failure (5xx/timeout) retries once at once. Returns whether Discord took the ACK: `acked`
 * (or already acknowledged), `failed-definitive` when the owner certainly saw the click fail — the action must
 * not run blind, or the owner's re-click would run it twice — and `failed-ambiguous` when the ACK may have
 * landed, so the caller still runs the action.
 */
export async function ackInteraction(
	transport: DiscordTransport,
	clock: AdapterClock,
	log: Logger,
	interaction: DiscordInteraction,
	response: { type: number; data?: Record<string, unknown> },
): Promise<"acked" | "failed-definitive" | "failed-ambiguous"> {
	const receivedAt = clock.now();
	for (let attempt = 0; ; attempt++) {
		try {
			await transport.respondInteraction({
				interactionId: interaction.id,
				token: interaction.token,
				response,
			});
			return "acked";
		} catch (err) {
			if (err instanceof DiscordCallError && err.code === ALREADY_ACKNOWLEDGED_CODE) return "acked";
			const rateLimited = err instanceof DiscordRateLimitedError;
			const callError = err instanceof DiscordCallError ? err : undefined;
			const retryable = rateLimited || callError?.kind === "ambiguous";
			const waitMs = rateLimited ? err.retryAfterMs : 0;
			const remainingMs = ACK_WINDOW_MS - (clock.now() - receivedAt) - ACK_MARGIN_MS;
			if (!retryable || attempt > 0 || waitMs > remainingMs) {
				log.warn("interaction_ack_failed", { id: interaction.id, error: errorText(err), attempts: attempt + 1 });
				return rateLimited || callError?.kind === "definitive" ? "failed-definitive" : "failed-ambiguous";
			}
			if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}
}
