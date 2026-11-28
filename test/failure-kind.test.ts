import { describe, expect, test } from "bun:test";
import { classifyFailure, formatResetHint, PROVIDER_LIMIT } from "../src/core/failure-kind";
import { ownerFailureTail, toolFreeFailureTail } from "../src/core/failure-notice";
import { isProviderLimit } from "../src/core/mailbox";

describe("classifyFailure", () => {
	test("provider_limit: zai 429 with reset timestamp extracts kind, limitScope=quota, and resetAt", () => {
		const res = classifyFailure("429 Usage limit reached for 5 hour. Your limit will reset at 2026-11-20 12:15:02");
		expect(res).toEqual({ kind: "provider_limit", limitScope: "quota", resetAt: "2026-11-20 12:15:02" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("12:15 이후");
	});

	test("provider_limit: resets in <duration> keeps '<기간> 뒤' text verbatim with quota scope", () => {
		const res = classifyFailure("Rate-limit exceeded, resets in 1h 30m");
		expect(res).toEqual({ kind: "provider_limit", limitScope: "quota", resetAt: "1h 30m 뒤" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("1h 30m 뒤");
	});

	test("provider_limit: too many requests and rate-limit classify as provider_limit before transient", () => {
		for (const msg of [
			"Too Many Requests",
			"HTTP rate-limit error",
			"429 Too Many Requests",
			"usage_limit reached",
			"You exceeded your quota",
			"Limit Exhausted",
		]) {
			expect(classifyFailure(msg).kind).toBe("provider_limit");
			expect(PROVIDER_LIMIT.test(msg)).toBe(true);
			expect(isProviderLimit(msg)).toBe(true);
		}
	});

	test("provider_limit: billing/credits/402 classify as quota scope even when retry-in text appears", () => {
		for (const msg of [
			"402 Payment Required",
			"Your credit balance is too low to access the Anthropic API",
			"insufficient credits on your account",
			"429 You exceeded your current quota: insufficient_quota",
			"429 Weekly/Monthly Limit Exhausted",
			"429 Usage limit reached. resets in 15m",
			"agy rate limited (429): 쿼터 초과 (steer 1건 미전달)",
			"402 Payment Required: insufficient credits, retry in 10s",
		]) {
			expect(classifyFailure(msg)).toMatchObject({ kind: "provider_limit", limitScope: "quota" });
		}
	});

	test("provider_limit: short-window RPM/TPM/retry-in/throttling classify as rate_limited", () => {
		expect(classifyFailure("429 Rate limit reached for requests per min (RPM). Please try again in 120ms.")).toEqual({
			kind: "provider_limit",
			limitScope: "rate_limited",
			resetAt: "120ms 뒤",
		});
		expect(
			classifyFailure("429 Quota exceeded for metric per minute, model: gemini-2.5-flash. Please retry in 12s."),
		).toEqual({ kind: "provider_limit", limitScope: "rate_limited", resetAt: "12s 뒤" });
		expect(
			classifyFailure("429 rate_limit_error: tokens per min (TPM) exceeded; reduce the length of the messages"),
		).toEqual({ kind: "provider_limit", limitScope: "rate_limited" });
		expect(classifyFailure("ThrottlingException: Too many requests")).toEqual({
			kind: "provider_limit",
			limitScope: "rate_limited",
		});
	});

	test("provider_limit: ISO reset timestamp formats HH:MM 이후", () => {
		const res = classifyFailure("429 rate limit, resets at 2026-11-20T09:45:10Z");
		expect(res).toEqual({ kind: "provider_limit", limitScope: "quota", resetAt: "2026-11-20T09:45:10Z" });
		expect(formatResetHint(res.resetAt ?? "")).toBe("09:45 이후");
	});

	test("context_overflow: Anthropic, OpenAI, Gemini, Bedrock and gateway-relayed 502 overflow errors", () => {
		for (const msg of [
			"prompt is too long: 215000 tokens > 200000 maximum",
			"This model's maximum context length is 128000 tokens",
			"context_length_exceeded",
			"Exceeds context window size",
			"Too many tokens in input",
			"input token count (1200000) exceeds the maximum number of tokens allowed",
			"ValidationException: Input is too long for requested model",
			"Please reduce the length of the messages",
			"502 Bad Gateway: prompt is too long",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "context_overflow" });
		}
	});

	test("auth: provider auth failures match while innocent 401/403 numbers and prose do not", () => {
		for (const msg of [
			"401 invalid api key",
			"403 Forbidden",
			"Request failed: Unauthorized",
			"authentication_error: bad credentials",
			"invalid_api_key provided",
			"400 invalid_grant (Refresh token expired)",
			"HTTP/1.1 401",
			'{"statusCode":403}',
			"API key not valid. Please pass a valid API key.",
			"PERMISSION_DENIED: caller does not have permission",
			"UNAUTHENTICATED: missing credentials",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "auth" });
		}
		for (const innocent of [
			"syntax error at line 401",
			"port 403 already in use",
			"issue #401 failed",
			"401 bytes written",
			"user is unauthorized to edit file.ts",
			"git hook rejected: forbidden branch name",
			"two-factor authentication guide",
		]) {
			expect(classifyFailure(innocent)).toEqual({ kind: "unknown" });
		}
	});

	test("model_rejected: missing, unknown, unsupported model or parameter errors", () => {
		for (const msg of [
			"model_not_found: gpt-99",
			"The model `claude-unknown` does not exist or you do not have access to it",
			"unsupported_model: reasoning not available",
			"unsupported_parameter: temperature",
			"could not restore model anthropic/old-model",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "model_rejected" });
		}
	});

	test("tool_history_rejected: mismatched tool call and tool result history errors", () => {
		for (const msg of [
			"400 No tool output found for function call call_abc123",
			"An assistant message with 'tool_calls' must be followed by tool messages; tool_call_ids did not have response",
			"messages.4: unexpected `tool_use_id` found in `tool_result` blocks",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "tool_history_rejected" });
		}
	});

	test("transient: socket hang up, timeouts, 500/502/503/504/529 and DEADLINE_EXCEEDED without bare 500 numbers", () => {
		for (const msg of [
			"socket hang up",
			"read ECONNRESET",
			"Request timed out after 30s",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"529 overloaded_error",
			"500 Internal Server Error",
			"DEADLINE_EXCEEDED",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "transient" });
		}
		for (const innocent of ["completed in 500ms", "failed at line 500"]) {
			expect(classifyFailure(innocent)).toEqual({ kind: "unknown" });
		}
	});

	test("unknown: unrelated messages fall back to unknown", () => {
		for (const msg of [
			"boom",
			"omp_executable_missing",
			"error 14290",
			"port 4010 already in use",
			"무관한 오류 문장입니다",
			"",
		]) {
			expect(classifyFailure(msg)).toEqual({ kind: "unknown" });
		}
	});
});

describe("failure notices", () => {
	test("ownerFailureTail distinguishes rate_limited, quota, model_rejected, tool_history_rejected, context_overflow, and auth", () => {
		expect(ownerFailureTail("429 RPM limit exceeded, retry in 20s")).toBe(
			"일시적 요청 속도 제한입니다. 20s 뒤 다시 보내 주세요",
		);
		expect(ownerFailureTail("ThrottlingException")).toBe("일시적 요청 속도 제한입니다. 잠시 뒤 다시 보내 주세요");
		expect(ownerFailureTail("402 Payment Required")).toBe(
			"공급자 한도입니다. 다시 보내거나 다른 모델로 `/model-jabbu`",
		);
		expect(ownerFailureTail("model_not_found")).toBe(
			"설정한 모델을 공급자가 거부했습니다. `/model-jabbu`로 다른 모델로 바꾼 뒤 다시 보내 주세요",
		);
		expect(ownerFailureTail("No tool output found for function call call_1")).toBe(
			"세션의 도구 호출 기록이 어긋나 이어갈 수 없습니다. `/new-jabbu`로 새 세션을 연 뒤 다시 보내 주세요",
		);
	});

	test("toolFreeFailureTail gives actionable guidance across all failure kinds", () => {
		expect(toolFreeFailureTail("429 RPM exceeded, try again in 15s")).toBe(
			" 일시적 요청 속도 제한입니다. 15s 뒤 다시 보내 주세요.",
		);
		expect(toolFreeFailureTail("429 usage limit exhausted. resets in 15m")).toBe(
			" 공급자 한도입니다. 15m 뒤 여유가 회복된 뒤 다시 보내거나 `/model-jabbu`로 모델을 바꾸세요.",
		);
		expect(toolFreeFailureTail("model_not_found")).toBe(
			" 설정한 모델을 공급자가 거부했습니다. `/model-jabbu`로 다른 모델로 바꾼 뒤 다시 보내 주세요.",
		);
		expect(toolFreeFailureTail("unexpected tool_use_id found in tool_result blocks")).toBe(
			" 세션의 도구 호출 기록이 어긋났습니다. `/new-jabbu`로 새 세션을 연 뒤 다시 보내 주세요.",
		);
		expect(toolFreeFailureTail("prompt is too long")).toBe(
			" 대화가 너무 길어 이어갈 수 없습니다. `/new-jabbu`(또는 `/compact-jabbu`) 뒤 다시 보내 주세요.",
		);
		expect(toolFreeFailureTail("401 invalid api key")).toBe(
			" 봇 계정 인증 문제입니다. 로그인·키를 확인한 뒤 다시 보내 주세요.",
		);
		expect(toolFreeFailureTail("aborted")).toBe(" 다시 실행하려면 새로 보내 주세요.");
	});
});
