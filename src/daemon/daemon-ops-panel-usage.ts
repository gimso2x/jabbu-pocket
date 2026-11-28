// `#ops` 패널의 공급자별 사용량: 구조화 수집(`전체 한도` 버튼과 공유), 패널용 한 줄 요약, 15분 캐시.
import type { Section } from "../dashboard/snapshot";
import { readUsageLimits, type UsageLimitsInfo } from "../dashboard/usage-limits";
import { realProcessRunner } from "../dispatch/omp";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { readOmpUsage, type UsageResponse } from "../omp/usage-json";
import type { OpsUsageInput } from "../ops/ops-panel-fields";
import { usedPercentOfLimit } from "../ops/quota-gate";
import { redact } from "../redact";
import type { DaemonContext } from "./daemon-context";

/** The panel's usage line is collected at most this often (the same TTL as the dashboard's limits card). */
const USAGE_REFRESH_MS = 15 * 60_000;

/** The raw limit sources of one collection, before any text or panel formatting (the button and the panel share it). */
interface UsageCollection {
	limits?: Section<UsageLimitsInfo>;
	ompUsage?: UsageResponse;
	ompError?: string;
}

export async function collectUsage(ctx: DaemonContext, now: number): Promise<UsageCollection> {
	const config = ctx.options.config;
	const run = ctx.options.usageLimitsRun ?? realProcessRunner;
	if (config.dashboard?.usageLimits !== undefined) {
		return { limits: await readUsageLimits(config.dashboard.usageLimits, run, () => now) };
	}
	if (config.agent === "agy") return {};
	try {
		return {
			ompUsage: await readOmpUsage({
				executable: config.ompExecutable,
				...(config.ompProfile === undefined ? {} : { profile: config.ompProfile }),
				...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
				env: buildChildEnv({}, withOmpProfile(process.env, config.ompProfile)),
				run,
			}),
		};
	} catch (error) {
		return { ompError: redact(error instanceof Error ? error.message : String(error)) };
	}
}

/** The panel's one line per provider: its most-used limit. Failed sources and accounts are skipped, not zeroed. */
function usageForPanel(collection: UsageCollection): OpsUsageInput {
	const byProvider = new Map<string, { provider: string; label: string; usedPct: number; resetsAt?: number }>();
	const offer = (provider: string, label: string, usedPct: number, resetsAt: number | undefined): void => {
		const used = Math.min(100, Math.max(0, usedPct));
		const current = byProvider.get(provider);
		if (current !== undefined && current.usedPct >= used) return;
		byProvider.set(provider, { provider, label, usedPct: used, ...(resetsAt === undefined ? {} : { resetsAt }) });
	};
	let failure: string | undefined;
	const { limits, ompUsage, ompError } = collection;
	if (limits !== undefined) {
		if (!limits.ok) failure = limits.error;
		else {
			for (const source of limits.sources) {
				if (!source.ok) {
					failure ??= source.error;
					continue;
				}
				if (source.accounts !== undefined) {
					// A multi-account provider runs on its best unblocked account (the pool promotes the
					// next account when the active one is exhausted), so the line shows the best account's
					// most-used window; the primary's exhaustion alone must not make the provider look dead.
					let best: { used: number; label: string; resetsAt: number | undefined } | undefined;
					for (const account of source.accounts) {
						if (!account.ok) continue;
						let worst: { used: number; label: string; resetsAt: number | undefined } | undefined;
						for (const row of account.rows) {
							const used = 100 - row.remainingPct;
							if (worst === undefined || used > worst.used)
								worst = { used, label: row.windowLabel, resetsAt: row.resetsAt };
						}
						if (worst !== undefined && (best === undefined || worst.used < best.used)) best = worst;
					}
					if (best !== undefined) {
						offer(source.name, best.label, best.used, best.resetsAt);
						continue;
					}
				}
				for (const row of source.rows) offer(source.name, row.windowLabel, 100 - row.remainingPct, row.resetsAt);
			}
		}
	} else if (ompUsage !== undefined) {
		for (const report of ompUsage.reports) {
			for (const limit of report.limits) {
				const used = usedPercentOfLimit(limit);
				if (used !== undefined)
					offer(report.provider, limit.window?.label ?? limit.label, used, limit.window?.resetsAt);
			}
		}
	} else if (ompError !== undefined) failure = ompError;
	if (byProvider.size > 0)
		return { state: "ok", rows: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)) };
	return failure === undefined ? { state: "empty" } : { state: "failed", error: failure };
}

/**
 * The panel's last collected usage line. A stale or missing value starts one background collection (never awaited, so
 * a slow `omp usage` cannot hold the serialized queue the buttons run on) and a later tick reads its result.
 */
export class OpsUsageCache {
	readonly #ctx: DaemonContext;
	#value: { at: number; usage: OpsUsageInput } | undefined;
	#inflight = false;

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
	}

	read(now: number): OpsUsageInput | undefined {
		const stale = this.#value === undefined || now - this.#value.at >= USAGE_REFRESH_MS;
		if (stale && !this.#inflight) {
			this.#inflight = true;
			void collectUsage(this.#ctx, now)
				.then((collection) => {
					this.#value = { at: now, usage: usageForPanel(collection) };
				})
				.catch((error: unknown) => {
					this.#value = { at: now, usage: { state: "failed", error: redact(String(error)) } };
				})
				.finally(() => {
					this.#inflight = false;
				});
		}
		return this.#value?.usage;
	}
}
