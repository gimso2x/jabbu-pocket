// The fence of a lane's core steers. An inbound row of the lane's origin parked as `uncertain` (its delivery outcome
// is unknown, so the mailbox never replays it) holds every core-authored message of that lane — nothing new is steered
// into a session whose last input may or may not have run — until the owner clears the rows with `/queue retry|close`.
// The mailbox's own paths (the one-time `uncertain:<id>` notice, `/queue`) are not touched.
import { COMMAND_TEXT } from "../core/types";
import type { Store } from "../store/db";
import type { LaneManagerDeps } from "./manager-types";
import type { LaneRow } from "./status";

/** The store slice the fence reads. */
export type FenceStore = Pick<Store, "listInbound">;

/**
 * Inbound rows of `originKey` parked as `uncertain`: what `/queue retry|close` clears. 0 when there are none; rows of
 * other origins and in other states do not count.
 */
export function uncertainCount(store: FenceStore, originKey: string): number {
	return store.listInbound({ originKey, state: "uncertain" }).length;
}

/**
 * The first line of a lane card whose origin has `count` parked rows: what is held (the core steers nothing into the
 * lane meanwhile) and where the owner clears it. Mirrors the mailbox's one-time notice, which names the same command.
 */
export function uncertainLine(count: number): string {
	return `⚠️ 전달 불확실 ${count}건 — 코어 발신 보류 중 · \`${COMMAND_TEXT.queue}\`에서 \`retry <번호>\` 또는 \`close <번호>\``;
}

/**
 * Holds a core send of `kind` into `lane` while its origin has parked rows, and logs `lane_send_fenced_uncertain` with
 * their count; false when the send may go. A paused lane never gets here: its own hold (`lane_send_held_paused`) comes
 * first, in `#send`.
 */
export function fenceUncertain(
	deps: { store: FenceStore; log: LaneManagerDeps["log"] },
	lane: Pick<LaneRow, "name" | "originKey">,
	kind: string,
): boolean {
	const uncertain = uncertainCount(deps.store, lane.originKey);
	if (uncertain === 0) return false;
	deps.log.warn("lane_send_fenced_uncertain", { lane: lane.name, kind, uncertain });
	return true;
}
