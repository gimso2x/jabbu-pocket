/*
 * Pure regex taxonomy and limit-scope helpers for turn failure strings.
 * Split from `failure-kind.ts` to keep that module compact under the LOC ratchet.
 */

export type ProviderLimitScope = "quota" | "rate_limited";

const HTTP_402 =
	/(?:^|[[(])402(?=\s*(?:$|[\]):,-]|payment|billing|credit|insufficient|quota|error))|(?<![#\d.])\b(?:http(?:\/\d(?:\.\d)?)?|status(?:[\s_-]?code)?|error[\s_-]?code|code)["']?\s*[:=\s(]\s*402\b|\b402\s+(?:payment[\s_-]?required|insufficient|credit|billing)\b/i;

const BILLING_WORDING =
	/insufficient[\s_-]?quota|insufficient\s+(?:balance|credits?)|credits?\s+exhausted|credit\s+balance|no\s+credits?\s+remaining|payment[\s_-]?required/i;

const USAGE_CAPPED =
	/usage[\s_-]?(?:limit|cap)|quota(?:\s+(?:exceeded|exhausted|reached))?|limit\s+exhausted|weekly\s+limit|monthly\s+limit|쿼터\s*초과/i;

const SHORT_WINDOW_RATE_LIMIT =
	/per[\s_-]?(?:second|minute|hour|min|sec)\b|\b[rt]pm\b|\b(?:retry(?:\s+again)?|try\s+again)\s+(?:in|after)\s+\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;

const THROTTLED = /throttl/i;

/** Provider usage/rate limits (429, rate-limit, too many requests, usage limit, quota, billing exhaustion). */
export const PROVIDER_LIMIT =
	/\b429\b|rate[\s_-]?limit|too\s+many\s+requests|usage[\s_-]?(?:limit|cap)|limit\s+exhausted|quota|쿼터\s*초과|resource[\s_-]?exhausted|throttl|insufficient[\s_-]?quota|insufficient\s+(?:balance|credits?)|credits?\s+exhausted|credit\s+balance|no\s+credits?\s+remaining|payment[\s_-]?required/i;

export const CONTEXT_OVERFLOW =
	/context[\s_-]?(?:length|window|limit|size)|maximum\s+(?:context|prompt\s+length)|(?:prompt|input)\s+is\s+too\s+long|too\s+many\s+tokens|input\s+token\s+count[^.\n]{0,40}exceeds|reduce\s+the\s+length\s+of\s+the\s+(?:messages|prompt|input)/i;

export const MODEL_REJECTED =
	/could\s+not\s+restore\s+model|model[\s_-]?not[\s_-]?found|no[\s_-]?such[\s_-]?model|unknown[\s_-]?model|invalid[\s_-]?model|unsupported[\s_-]?model|\bmodel\b[^.\n]{0,40}\b(?:is\s+not\s+supported|does\s+not\s+exist|not\s+available)\b|unsupported[\s_-]?(?:parameter|value)/i;

export const TOOL_HISTORY_REJECTED =
	/no\s+tool\s+output\s+found\s+for\s+(?:function|tool)\s+call|tool_call_ids?[^.\n]{0,60}(?:response|respond)|tool_use(?:_id)?[^.\n]{0,60}tool_result|tool_result[^.\n]{0,60}tool_use(?:_id)?/i;

export const SERVER_UNAVAILABLE =
	/(?:^|[[(])(?:500|529)(?=\s*(?:$|[\]):,-]|internal|server|overloaded|error|service))|(?<![#\d.])\b(?:http(?:\/\d(?:\.\d)?)?|status(?:[\s_-]?code)?|error[\s_-]?code|code)["']?\s*[:=\s(]\s*(?:500|529)\b|\b(?:500|529)\s+(?:internal[\s_-]?server|server[\s_-]?error|overloaded(?:_error)?)\b|internal[\s_-]?server[\s_-]?error|server_error|overloaded(?:_error)?|deadline[\s_-]?exceeded/i;

const AUTH_PHRASE = /^(?:unauthorized|forbidden)\.?$/i;
const AUTH_CONTEXTUAL_PHRASE =
	/(?:^|(?:request|api|http|auth|provider|status|error|failed|response|401|403)(?:\s+(?:failed|returned|with|status|code))?\s*[:=-]?\s*)(?:unauthorized|forbidden)\b/i;
const AUTH_CODE_NUMBER =
	/(?:^|[[(])(?:401|403)(?=\s*(?:$|[\]):,-]|unauthorized|forbidden|invalid|unauthenticated|authentication|permission|access|error|bad))|(?<![#\d.])\b(?:http(?:\/\d(?:\.\d)?)?|status(?:[\s_-]?code)?|error[\s_-]?code|code)["']?\s*[:=\s(]\s*(?:401|403)\b|\b(?:401|403)\s+(?:unauthorized|forbidden|unauthenticated|invalid[\s_-]?api[\s_-]?key|access[\s_-]?denied|permission[\s_-]?denied|bad[\s_-]?credentials)\b/i;
const AUTH_WORDING =
	/invalid[\s_-]?api[\s_-]?key|incorrect\s+api\s+key|api\s+key\s+not\s+valid|expired\s+api\s+key|authentication(?:[\s_-]?error|\s+failed|\s+required)|permission[\s_-]?(?:denied|error)|access[\s_-]?denied|invalid[\s_-]?grant|refresh\s+token\s+expired|unauthenticated/i;

const RESET_AT_PATTERN =
	/resets?\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)/i;
const DURATION_EXPR =
	"(\\d{1,6}(?:\\.\\d{1,6})?\\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)(?:(?:\\s*,?\\s*and\\s+|\\s*)\\d{1,6}(?:\\.\\d{1,6})?\\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)){0,3})";
const RESET_IN_PATTERN = new RegExp(`resets?\\s+in\\s+${DURATION_EXPR}`, "i");
const RETRY_IN_PATTERN = new RegExp(`\\b(?:retry(?:\\s+again)?|try\\s+again)\\s+(?:in|after)\\s+${DURATION_EXPR}`, "i");

/** Whether `reason` indicates exhausted billing/credits or HTTP 402. */
export function isBillingExhausted(reason: string): boolean {
	return HTTP_402.test(reason) || BILLING_WORDING.test(reason);
}

/** Whether `reason` indicates a provider authentication or authorization failure (hardened against line/port numbers). */
export function isAuthError(reason: string): boolean {
	const trimmed = reason.trim();
	return (
		AUTH_WORDING.test(reason) ||
		AUTH_CODE_NUMBER.test(trimmed) ||
		AUTH_PHRASE.test(trimmed) ||
		AUTH_CONTEXTUAL_PHRASE.test(trimmed)
	);
}

/** Splits `provider_limit` into durable `quota` vs short-window `rate_limited`; defaults conservatively to `quota`. */
export function classifyLimitScope(reason: string): ProviderLimitScope {
	if (isBillingExhausted(reason)) return "quota";
	if (SHORT_WINDOW_RATE_LIMIT.test(reason)) return "rate_limited";
	if (THROTTLED.test(reason) && !USAGE_CAPPED.test(reason)) return "rate_limited";
	return "quota";
}

/** Extracts a raw reset timestamp or `"<duration> 뒤"` from `resets at`, `resets in`, or `retry/try again in/after`. */
export function extractResetDurationOrTime(reason: string): string | undefined {
	const atMatch = RESET_AT_PATTERN.exec(reason);
	if (atMatch?.[1] !== undefined) return atMatch[1];
	const inMatch = RESET_IN_PATTERN.exec(reason) ?? RETRY_IN_PATTERN.exec(reason);
	if (inMatch?.[1] !== undefined) return `${inMatch[1].trim().slice(0, 40)} 뒤`;
	return undefined;
}
