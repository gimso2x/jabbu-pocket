import type { Logger } from "../log";
import type { Store } from "../store/db";

/**
 * Expires stale pending rows and re-queues inflight rows of a dead process, even with no adapter running: the
 * daemon sweep runs on its own interval, not as an adapter-pump side effect. Call only right after the pump step:
 * no send is in flight then (every pump chains onto the daemon's single pump queue), so re-queuing an inflight row
 * cannot double-send it. Logs only when it did something.
 */
export function sweepDeliveries(store: Store | undefined, log: Logger): void {
	if (store === undefined) return;
	const expired = store.sweepExpired();
	const recovered = store.recoverInflight();
	if (expired > 0 || recovered > 0) log.info("delivery_sweep", { expired, recovered });
}
