// The gate thresholds (how stale or stuck a signal must be before its gate opens), as one place next to the
// health projection that judges them (`./gates`, which re-exports them).

import { DEFAULT_SWEEP_MS } from "../daemon/heartbeat";
import { FRESHNESS_MS } from "../store/transitions";

/** A stale backup is the first thing to catch; the hub uses the same 36h window for its file-age check. */
export const BACKUP_MAX_AGE_MS = 36 * 60 * 60_000;
/** A stamp dated further ahead than this is a clock jump or corruption, not a fresh backup. */
export const BACKUP_FUTURE_TOLERANCE_MS = 60 * 60_000;
/**
 * The sweep heartbeat may age at most three sweeps before the sweep chain counts as dead: the loop is blocked or
 * the timer is gone, and with it every origin's stall marking (they all run on that one loop).
 */
export const SWEEP_STALLED_MS = 3 * DEFAULT_SWEEP_MS;
/**
 * A dispatched turn with no omp event for this long is hung (upstream cycle: INBOUND_STARVATION_MS). Measured from
 * `last_event_at`, falling back to `dispatched_at`, so a long turn that keeps working does not open the gate. A turn
 * whose origin waits on a pending approval card is waiting on the owner, not hung (the card has its own timeout).
 */
export const INBOUND_STARVATION_MS = 10 * 60_000;
/**
 * An owner message still `pending` (never handed to omp) this long means the conversation went silent on it
 * (gajae-way `origin_silent`). Rows queued behind a turn that is still producing omp events are normal queueing
 * and stay out; a hung turn ahead of them does not exempt them.
 */
export const ORIGIN_SILENT_MS = 15 * 60_000;
/** Deliveries whose next attempt is this far overdue mean the delivery pump is stuck. */
export const DELIVERY_OVERDUE_MS = 10 * 60_000;
/** A lane that has not progressed for a day needs attention. */
export const LANE_STUCK_MS = 24 * 60 * 60_000;
/**
 * A held (`failed_ambiguous`) delivery older than the boot requeue window (`FRESHNESS_MS`) can no longer be rescued by
 * a restart, so only the owner's `ompbot deliveries ack|resend` clears it — past this it gates. It is that window on
 * purpose: the same constant decides what `requeueAmbiguous` brings back, so the gate cannot drift from it.
 */
export const AMBIGUOUS_STUCK_MS = FRESHNESS_MS;
/** Only fresh, unrecovered monitor failures gate; an old `failed_no_retry` already notified once and must not alarm forever. */
export const MONITOR_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Chat turns failing repeatedly: `[turn failed]` notice deliveries are the only ledger trace of a broken bot (the
 * 2026-10-24 stale-model outage showed up as four of them and nothing else). The window and threshold mirror the
 * mailbox escalation, so what the owner was DM'd about also fails `ompbot gates`.
 */
export const TURNS_FAILING_WINDOW_MS = 60 * 60_000;
export const TURNS_FAILING_THRESHOLD = 3;
/** Re-received message ids with other content are counted over this window (`inbound_identity_conflicts`). */
export const INBOUND_CONFLICT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The Discord gateway stays down this long before `discord_disconnected`
 * opens; shorter blips reconnect by themselves.
 */
export const SOCKET_DOWN_MS = 10 * 60_000;
/** An enabled monitor whose next fire is this far in the past means the monitor tick is not firing it. */
export const MONITOR_OVERDUE_MS = 15 * 60_000;
/**
 * A drain still on while the apply that took it is dead (pid gone or from before a reboot) this long after that
 * apply started: new turns are held with nobody left to restart or cancel. Long enough for a normal backup + drain.
 */
export const DRAIN_ORPHANED_MS = 10 * 60_000;
