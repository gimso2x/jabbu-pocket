import type { ProviderLimitInfo, TurnFailureEscalation } from "../core/mailbox";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { redact } from "../redact";
import { type DaemonContext, ownerTarget } from "./daemon-context";
import { formatProviderLimitNotice, formatTurnEscalationNotice } from "./notices";

/**
 * Posts an owner notice whose incident row was recorded first (24h suppression). The adapter never throws, so a
 * failed post (`false`) would otherwise leave the incident "alerted" and silence every retry for a day: resolve the
 * scope instead, so the next occurrence of the same condition notifies again. Resolves to whether it was posted.
 */
export async function postOwnerNotice(
	ctx: DaemonContext,
	owner: { adapter: { postNotice(channel: string, text: string): Promise<boolean> }; channel: string },
	scope: string,
	text: string,
): Promise<boolean> {
	const posted = await owner.adapter.postNotice(owner.channel, text);
	if (posted) return true;
	try {
		ctx.store?.resolveAlertIncidents(scope);
	} catch (error) {
		ctx.log.warn("owner_notice_unresolve_failed", { scope, error: String(error) });
	}
	ctx.log.warn("owner_notice_retry_armed", { scope });
	return false;
}

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
	void postOwnerNotice(
		ctx,
		owner,
		`turns:${info.originKey}`,
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
	void postOwnerNotice(ctx, owner, "provider:limit", formatProviderLimitNotice(info, incident.count));
}
