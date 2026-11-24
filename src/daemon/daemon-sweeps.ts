import { isAutonomousRow, type ProviderLimitInfo, type TurnFailureEscalation } from "../core/mailbox";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { collectGates, type GateState, gateOptionsFromConfig } from "../ops/gates";
import { redact } from "../redact";
import type { InboundRow } from "../store/db-rows";
import {
	DEFAULT_GATE_SWEEP_MS,
	GATE_RESOLVE_CLOSED_SWEEPS,
	PENDING_ALERT_AFTER,
	PENDING_RETRY_MS,
	WINDOW_GATES,
} from "./daemon-constants";
import { type DaemonContext, ownerTarget } from "./daemon-context";
import type { PendingRetryState } from "./daemon-types";
import {
	formatGateClosedNotice,
	formatGateOpenNotice,
	formatPendingDispatchNotice,
	formatProviderLimitNotice,
	formatTurnEscalationNotice,
} from "./notices";

/**
 * Owner DM for a run of failed turns — the bot reporting "나 망가짐" by itself, the missing half of the 2026-10-24
 * outage. The same failure sign notifies once per 24h (monitor incident cadence); monitor origins are skipped
 * because their failures already retry with backoff and get their own terminal notice.
 */
export function escalateTurnFailures(ctx: DaemonContext, info: TurnFailureEscalation): void {
	const store = ctx.store;
	if (store === undefined || info.originKey.startsWith(MONITOR_ORIGIN_PREFIX)) return;
	const owner = ownerTarget(ctx, "turn_failures");
	if (owner === undefined) return;
	const now = ctx.clock.now();
	let incident = { notify: true, count: 1, firstAt: now };
	try {
		incident = store.recordAlertIncident(`turns:${info.originKey}`, info.reason, now);
	} catch (error) {
		ctx.log.warn("escalation_incident_failed", { origin: info.originKey, error: String(error) });
	}
	if (!incident.notify) return;
	ctx.log.warn("turn_failures_notified", {
		origin: info.originKey,
		failures: info.failures,
		count: incident.count,
		modelHealed: info.modelHealed,
	});
	void owner.adapter.postNotice(
		owner.channel,
		formatTurnEscalationNotice({ ...info, reason: redact(info.reason) }, incident.count),
	);
}

/**
 * Owner DM for a provider usage limit seen in omp's retry events (429 / weekly limit). One incident sign for every
 * wording, so the owner hears about it once per 24h; monitor origins are not skipped (their limit hit is exactly
 * what 2026-11-02 hid for six hours). The incident is never resolved automatically.
 */
export function notifyProviderLimit(ctx: DaemonContext, info: ProviderLimitInfo): void {
	const store = ctx.store;
	if (store === undefined) return;
	const owner = ownerTarget(ctx, "provider_limit");
	if (owner === undefined) return;
	const now = ctx.clock.now();
	let incident = { notify: true, count: 1, firstAt: now };
	try {
		incident = store.recordAlertIncident("provider:limit", "provider-limit", now);
	} catch (error) {
		ctx.log.warn("provider_limit_incident_failed", { origin: info.originKey, error: String(error) });
	}
	if (!incident.notify) return;
	ctx.log.warn("provider_limit_notified", { origin: info.originKey, count: incident.count });
	void owner.adapter.postNotice(owner.channel, formatProviderLimitNotice(info, incident.count));
}

/** The gate transitions the sweep reports to the owner (the self-diagnosis loop of `jabbu-pocket gates`). */
export class GateSweep {
	readonly #ctx: DaemonContext;
	/** Gate states of the previous gate sweep (closed→open transitions and per-open "did we alert" bookkeeping). */
	readonly #gateStates = new Map<
		string,
		{ state: GateState; alerted: boolean; closedSweeps: number; pendingResolve: boolean }
	>();
	#lastGateSweepAt = 0;

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
	}

	/**
	 * Self-diagnosis loop: every `gateSweepMs` the daemon runs the same gate projection as `jabbu-pocket gates` and reports
	 * transitions to the owner DM. An opening gate notifies once and re-alerts daily while it stands (the same gate
	 * within 24h stays quiet), and a close after an alerted open sends the recovery notice — so a flapping gate
	 * cannot spam and a dead backup timer still reaches the only channel the owner watches. Two exceptions: the
	 * window gates (`turns_failing`, `monitors_failed`) close silently, because an aged-out window is not a fix, and
	 * `standing` incidents re-seed `alerted` after a restart, so a real recovery still reports across incarnations.
	 * After an alerted open closes (with the recovery notice, or silently for a window gate) the incident is resolved
	 * once the gate has stayed closed for `GATE_RESOLVE_CLOSED_SWEEPS` sweeps, so a later recurrence alerts again; a
	 * gate first seen closed after a restart, window gates included, resolves its leftover incident immediately.
	 */
	async sweep(): Promise<void> {
		const interval = this.#ctx.options.gateSweepMs ?? DEFAULT_GATE_SWEEP_MS;
		const store = this.#ctx.store;
		if (interval <= 0 || store === undefined) return;
		const owner = ownerTarget(this.#ctx, "gate_sweep");
		if (owner === undefined) return;
		const now = this.#ctx.clock.now();
		if (now - this.#lastGateSweepAt < interval) return;
		this.#lastGateSweepAt = now;
		const { config } = this.#ctx.options;
		for (const gate of collectGates({
			homeDir: config.homeDir,
			now,
			...gateOptionsFromConfig(config),
			...(this.#ctx.options.hostLoad === undefined ? {} : { hostLoad: this.#ctx.options.hostLoad }),
			...(this.#ctx.options.statfs === undefined ? {} : { statfs: this.#ctx.options.statfs }),
		})) {
			// Nothing to judge (stamp or ledger missing): keep the previous state untouched — no notice, no incident
			// write or resolve — so a stamp deleted under an open gate never reads as a recovery.
			if (gate.state === "unknown") continue;
			const previous = this.#gateStates.get(gate.name);
			try {
				if (gate.state === "open") {
					const incident = store.recordAlertIncident(`gate:${gate.name}`, "open", now);
					// `standing` rebuilds the alerted flag after a restart (the in-memory map starts empty); a quiet
					// repeat inside 24h still counts as "the owner knows".
					const alerted = incident.notify || incident.standing || (previous?.state === "open" && previous.alerted);
					if (incident.notify) {
						await owner.adapter.postNotice(owner.channel, formatGateOpenNotice(gate, incident.firstAt, now));
					}
					this.#gateStates.set(gate.name, { state: "open", alerted, closedSweeps: 0, pendingResolve: false });
				} else if (previous?.state === "open") {
					// A close after a quiet open stays quiet; a close after an alerted open reports the recovery —
					// except the window gates, whose close only means the evidence aged out. Either way an alerted
					// incident is resolved after the closed sweeps, so a window gate's row does not stay alerted.
					if (previous.alerted && !WINDOW_GATES.has(gate.name)) {
						await owner.adapter.postNotice(owner.channel, formatGateClosedNotice(gate));
					}
					this.#gateStates.set(gate.name, {
						state: "closed",
						alerted: false,
						closedSweeps: 1,
						pendingResolve: previous.alerted,
					});
				} else if (previous?.state === "closed") {
					previous.closedSweeps += 1;
					if (previous.pendingResolve && previous.closedSweeps >= GATE_RESOLVE_CLOSED_SWEEPS) {
						store.resolveAlertIncidents(`gate:${gate.name}`);
						previous.pendingResolve = false;
						this.#ctx.log.info("gate_incident_resolved", { gate: gate.name });
					}
				} else {
					// First observation after a restart is already closed: clear any leftover alerted row (no row = no-op).
					// A window gate too: it only closes once its evidence window passed without a recurrence.
					store.resolveAlertIncidents(`gate:${gate.name}`);
					this.#ctx.log.info("gate_incident_resolved", { gate: gate.name, reason: "closed_at_boot" });
					this.#gateStates.set(gate.name, { state: "closed", alerted: false, closedSweeps: 1, pendingResolve: false });
				}
			} catch (error) {
				this.#ctx.log.warn("gate_report_failed", { gate: gate.name, error: String(error) });
			}
		}
	}
}

/** The sweep retry of stranded pending rows, and the origins a freeze held. */
export class PendingDispatchSweep {
	readonly #ctx: DaemonContext;
	/** Sweep-retry state per origin with stranded pending rows; progress deletes the entry. */
	readonly #pendingRetries = new Map<string, PendingRetryState>();
	/** Origins whose autonomous pending rows a freeze held: the first sweep after the unfreeze resumes them at once. */
	readonly frozenHeldOrigins = new Set<string>();

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
	}

	noteFrozenHeld(pending: readonly InboundRow[]): void {
		const autonomous = pending.filter((row) => isAutonomousRow(row.originKey, row));
		if (autonomous.length === 0 || this.#ctx.frozen() === undefined) return;
		for (const row of autonomous) this.frozenHeldOrigins.add(row.originKey);
	}

	/**
	 * A pending row stranded by a `dispatch_pending_failed` drain throw or a failed steer has no retry path but the
	 * origin's next message or a restart, and a stuck row blocks the rows behind it (`#drain` breaks). Every sweep,
	 * origins whose oldest pending row is at least `pendingRetryMs` old get one `resumePending` re-run — the same
	 * drain the origin's next message runs, so the semantics are identical — gated on the origin being idle: a busy
	 * origin's pending rows are its normal queue and drain when the turn settles. `PENDING_ALERT_AFTER` failed
	 * retries in a row alert the owner once through the shared `recordAlertIncident` machine (24h repeat
	 * suppression), so a message cannot sit for hours unnoticed like in the 2026-10-24 outage.
	 */
	sweep(): void {
		const interval = this.#ctx.options.pendingRetryMs ?? PENDING_RETRY_MS;
		const store = this.#ctx.store;
		const router = this.#ctx.router;
		if (interval <= 0 || store === undefined || router === undefined) return;
		// A restart drain holds pending rows on purpose (`resumePending` returns at once), so a retry would count a
		// deliberate wait as a failure and alert the owner; `setDraining(false)` dispatches them itself.
		if (router.draining) return;
		const now = this.#ctx.clock.now();
		const pending = store.listInbound({ state: "pending" });
		// The (cached) freeze probe is read only when a freeze could matter: an autonomous row waits or one was held.
		const frozen =
			(this.frozenHeldOrigins.size > 0 || pending.some((row) => isAutonomousRow(row.originKey, row))) &&
			this.#ctx.frozen() !== undefined;
		// A freeze holds autonomous rows on purpose: no retry, no failure count, no `dispatch:` incident. The origins
		// that had any resume at once (no age wait) in the first sweep after the unfreeze.
		if (frozen) this.noteFrozenHeld(pending);
		const released = frozen ? new Set<string>() : new Set(this.frozenHeldOrigins);
		const stale = pending.filter((row) =>
			frozen
				? !isAutonomousRow(row.originKey, row) && now - row.createdAt >= interval
				: now - row.createdAt >= interval || released.has(row.originKey),
		);
		if (!frozen) this.frozenHeldOrigins.clear();
		for (const originKey of new Set(stale.map((row) => row.originKey))) {
			if (router.mailbox(originKey).state.busy) continue;
			// A paused lane holds its owner messages on purpose until `계속`; a retry would count the wait as a failure.
			if (store.getLaneByOrigin(originKey)?.status === "paused") continue;
			const previous = this.#pendingRetries.get(originKey);
			if (previous !== undefined && now - previous.at < interval) continue;
			const oldest = stale
				.filter((row) => row.originKey === originKey)
				.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
			const state: PendingRetryState = {
				at: now,
				oldestId: oldest.platformMessageId,
				failures: previous?.failures ?? 0,
				sign: previous?.sign ?? "",
			};
			this.#pendingRetries.set(originKey, state);
			router
				.mailbox(originKey)
				.resumePending()
				.catch((error: unknown) => {
					state.sign = String(error);
					this.#ctx.log.warn("pending_retry_failed", { origin: originKey, error: String(error) });
				})
				.then(() => this.#settlePendingRetry(originKey, state));
		}
	}

	/**
	 * Counts one retry outcome on the oldest stuck row: it leaving pending (answered, dispatched, discarded) is
	 * progress — the streak clears and a standing incident resolves — while a row still pending increments the
	 * streak and, from `PENDING_ALERT_AFTER`, records an owner incident (a notice only on its first occurrence or
	 * after the 24h repeat window).
	 */
	#settlePendingRetry(originKey: string, state: PendingRetryState): void {
		const store = this.#ctx.store;
		if (store === undefined) return;
		if (store.getInbound(state.oldestId)?.state !== "pending") {
			if (state.failures > 0) store.resolveAlertIncidents(`dispatch:${originKey}`);
			if (this.#pendingRetries.get(originKey) === state) this.#pendingRetries.delete(originKey);
			return;
		}
		state.failures += 1;
		if (state.failures < PENDING_ALERT_AFTER) return;
		const owner = ownerTarget(this.#ctx, "pending_dispatch");
		if (owner === undefined) return;
		const now = this.#ctx.clock.now();
		const sign = state.sign === "" ? "resume_pending_stuck" : state.sign;
		let incident = { notify: true, count: 1, firstAt: now };
		try {
			incident = store.recordAlertIncident(`dispatch:${originKey}`, sign, now);
		} catch (error) {
			this.#ctx.log.warn("pending_retry_incident_failed", { origin: originKey, error: String(error) });
			return;
		}
		if (!incident.notify) return;
		this.#ctx.log.warn("pending_dispatch_notified", {
			origin: originKey,
			failures: state.failures,
			count: incident.count,
		});
		const oldest = store.getInbound(state.oldestId);
		void owner.adapter.postNotice(
			owner.channel,
			formatPendingDispatchNotice(originKey, now - (oldest?.createdAt ?? now), redact(sign), incident.count),
		);
	}
}
