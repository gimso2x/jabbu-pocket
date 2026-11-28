/*
 * Turn failure reason classification.
 * Pure functions: no clock, no I/O. `provider_limit` is checked before `transient` because `TRANSIENT` in
 * `stuck.ts` also matches 429 / rate-limit / too many requests.
 */

import * as p from "./failure-patterns";
import { TRANSIENT } from "./stuck";

export { PROVIDER_LIMIT } from "./failure-patterns";

export type FailureKind =
	| "provider_limit"
	| "context_overflow"
	| "auth"
	| "model_rejected"
	| "tool_history_rejected"
	| "transient"
	| "unknown";

export interface FailureClassification {
	kind: FailureKind;
	/** Sub-classification for `provider_limit`: durable `quota` vs short-window `rate_limited`. */
	limitScope?: p.ProviderLimitScope;
	/** Raw extracted reset moment (e.g. `"2026-11-20 12:15:02"`) or relative text (`"<기간> 뒤"`), only for `provider_limit`. */
	resetAt?: string;
}

const RESET_HHMM_PATTERN = /(?:^|[\sT])(\d{1,2}:\d{2})(?::\d{2})?/;

/** Extracts a raw reset timestamp or `"<duration> 뒤"` phrase when present. */
export function extractResetAt(reason: string): string | undefined {
	return p.extractResetDurationOrTime(reason);
}

/** Formats an extracted reset value into the notice phrase (`"HH:MM 이후"` or `"<기간> 뒤"`). */
export function formatResetHint(resetAt: string): string {
	if (resetAt.endsWith(" 뒤")) return resetAt;
	const hhmm = RESET_HHMM_PATTERN.exec(resetAt)?.[1];
	return `${hhmm ?? resetAt} 이후`;
}

/** Classifies a turn failure reason into one of the seven failure kinds. */
export function classifyFailure(reason: string): FailureClassification {
	if (p.isBillingExhausted(reason) || p.PROVIDER_LIMIT.test(reason)) {
		const limitScope = p.classifyLimitScope(reason);
		const resetAt = extractResetAt(reason);
		return resetAt === undefined
			? { kind: "provider_limit", limitScope }
			: { kind: "provider_limit", limitScope, resetAt };
	}
	if (p.CONTEXT_OVERFLOW.test(reason)) return { kind: "context_overflow" };
	if (p.isAuthError(reason)) return { kind: "auth" };
	if (p.MODEL_REJECTED.test(reason)) return { kind: "model_rejected" };
	if (p.TOOL_HISTORY_REJECTED.test(reason)) return { kind: "tool_history_rejected" };
	if (TRANSIENT.test(reason) || p.SERVER_UNAVAILABLE.test(reason)) return { kind: "transient" };
	return { kind: "unknown" };
}
