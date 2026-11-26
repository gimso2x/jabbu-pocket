import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	OWN_ANSWER_LINE,
	ROTATION_CONTEXT_HEADER,
	rotationContextBlock,
	THREAD_ANSWER_LINE,
	THREAD_CONTEXT_HEADER,
} from "../core/mailbox-thread-context";
import type { Logger } from "../log";
import { INJECTION_WARNING_HEAD, injectionWarning, scanForInjection } from "../safety/injection";
import type { Store } from "../store/db";
import { formatLocal } from "../time";
import type { AgyAccountPool, AgyBlockedAccount } from "./agy-account-pool";
import { finalLineQuotaNotice, isQuotaErrorText, quotaRetryNotice } from "./agy-notice";
import { OmpDriverError } from "./driver";
import { isRecord } from "./type-guards";

export const DEFAULT_QUOTA_BLOCK_MS = 60 * 60_000;
export const QUOTA_RESET_BUFFER_MS = 120_000;
export const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;

/** Updates that only refresh state; any other kind is debug-logged once. */
export const QUIET_UPDATES: Record<string, true> = {
	available_commands_update: true,
	session_info_update: true,
	current_mode_update: true,
	user_message_chunk: true,
	plan: true,
};

const RESET_PHRASE = /Resets in ([0-9hms.\s]+)/i;
const RESET_PART = /([\d.]+)\s*([hms])/gi;

/** Parses agy's `Resets in 2h30m` phrase into ms plus safety buffer (falls back to 60 min + buffer). */
export function parseResetDurationMs(detail: string): number {
	const match = RESET_PHRASE.exec(detail);
	if (match !== null) {
		const phrase = match[1] ?? "";
		let totalMs = 0;
		for (const part of phrase.matchAll(RESET_PART)) {
			const value = Number(part[1]);
			const unit = part[2]?.toLowerCase();
			if (!Number.isFinite(value) || value <= 0) continue;
			if (unit === "h") totalMs += value * 3_600_000;
			else if (unit === "m") totalMs += value * 60_000;
			else if (unit === "s") totalMs += value * 1_000;
		}
		if (totalMs > 0) return Math.ceil(totalMs) + QUOTA_RESET_BUFFER_MS;
	}
	return DEFAULT_QUOTA_BLOCK_MS + QUOTA_RESET_BUFFER_MS;
}

/** Prepends an injection warning line when quoted bot answers inside a rotation block contain instruction-like text. */
function applyRotationInjectionWarning(block: string, log?: Logger, originKey?: string): string {
	if (block.startsWith(INJECTION_WARNING_HEAD)) return block;
	const answers = block
		.split("\n")
		.filter((line) => line.startsWith(THREAD_ANSWER_LINE) || line.startsWith(OWN_ANSWER_LINE));
	const where = "스레드 맥락의 봇 답";
	const findings = scanForInjection(answers.join("\n"), where);
	const warning = injectionWarning(findings);
	if (warning === null) return block;
	log?.info("injection_flagged", { origin: originKey, where, kinds: findings.map((f) => f.kind) });
	return `${warning}\n${block}`;
}

/** Prepends `rotationContext` once to a retried/switched prompt when not already carrying thread/rotation context. */
export function prependRotationContext(prompt: string, context: string | null): string {
	if (context === null || context === "") return prompt;
	if (prompt.includes(ROTATION_CONTEXT_HEADER) || prompt.includes(THREAD_CONTEXT_HEADER)) return prompt;
	return `${applyRotationInjectionWarning(context)}\n\n${prompt}`;
}

/** Builds a rotation context block for `originKey` from the store's latest inbound row of that origin. */
export function latestRotationContext(store: Store | undefined, originKey: string, log?: Logger): string | null {
	if (store === undefined) return null;
	const row = store.listInbound({ originKey }).at(-1);
	if (row === undefined) return null;
	const block = rotationContextBlock(store, originKey, row);
	return block === null ? null : applyRotationInjectionWarning(block, log, originKey);
}

/** Human-readable quota failure line naming either the switched next account or the soonest reset time. */
export function formatQuotaExhaustedError(params: {
	detail: string;
	hadToolCall: boolean;
	nextAccount?: string | undefined;
	soonest?: AgyBlockedAccount | undefined;
	timezone?: string | undefined;
}): string {
	const { detail, hadToolCall, nextAccount, soonest, timezone } = params;
	if (nextAccount === undefined) {
		const resetHint =
			soonest === undefined
				? ""
				: ` (가장 빠른 리셋: ${formatLocal(soonest.until, timezone ?? "UTC")}, ${soonest.name})`;
		return `agy rate limited (429): 모든 계정 한도 소진${resetHint}`;
	}
	if (hadToolCall) {
		return `agy rate limited (429): ${detail} (도구 실행 후 중단 — 다음 계정 ${nextAccount}으로 전환됨, 이어서 요청해 주세요)`;
	}
	return `agy rate limited (429): ${detail} (다음 계정 ${nextAccount}으로 전환됨, 이어서 요청해 주세요)`;
}

/** Builds the `rpc_error` thrown when every pool account is currently rate-limited. */
export function allAccountsExhaustedError(accounts: AgyAccountPool, now: number, timezone?: string): OmpDriverError {
	return new OmpDriverError(
		"rpc_error",
		formatQuotaExhaustedError({
			detail: "all accounts exhausted",
			hadToolCall: false,
			soonest: accounts.soonestReset(now),
			timezone,
		}),
	);
}

/** The head of every agy quota failure's turn error (the daemon blocks a headless agy task on it). */
export const AGY_RATE_LIMIT_HEAD = "agy rate limited (429)";

/** Records a quota retry notice detail (`RESOURCE_EXHAUSTED …`) onto the active turn. */
export function setQuotaNotice(
	turn: { rateLimit?: string; rateLimitDetail?: string; rateLimitResetMs?: number },
	detail: string,
): void {
	turn.rateLimit = `${AGY_RATE_LIMIT_HEAD}: ${detail}`;
	turn.rateLimitDetail = detail;
	turn.rateLimitResetMs = parseResetDurationMs(detail);
}

/** Records a 429/RESOURCE_EXHAUSTED error failure onto the turn when no retry notice already did. */
export function recordQuotaFailure(
	turn: { rateLimit?: string; rateLimitDetail?: string; rateLimitResetMs?: number },
	failure: unknown,
): void {
	if (failure === undefined || turn.rateLimit !== undefined) return;
	const message = failure instanceof Error ? failure.message : String(failure);
	if (!isQuotaErrorText(message)) return;
	setQuotaNotice(turn, quotaRetryNotice(message) ?? message);
}

/** Records a final-line quota notice on a normal `end_turn` reply when no earlier notice or failure already did. */
export function recordFinalQuotaNotice(
	turn: { rateLimit?: string; rateLimitDetail?: string; rateLimitResetMs?: number },
	stopReason: string | undefined,
	text: string,
): boolean {
	if (turn.rateLimit !== undefined || stopReason !== "end_turn") return false;
	const detail = finalLineQuotaNotice(text);
	if (detail === undefined) return false;
	setQuotaNotice(turn, detail);
	return true;
}

/** Extracts the quota detail from a print-mode result (error text when failed, final line when succeeded). */
export function resultQuotaDetail(succeeded: boolean, error: string, text: string): string | undefined {
	if (!succeeded) return isQuotaErrorText(error) ? (quotaRetryNotice(error) ?? error) : undefined;
	return finalLineQuotaNotice(text);
}

export interface AgyPointer {
	conversationId: string;
	account?: string;
}

export function readAgyPointer(pointerPath: string): AgyPointer | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
		if (!isRecord(parsed) || typeof parsed.conversationId !== "string") return undefined;
		const account = typeof parsed.account === "string" && parsed.account !== "" ? parsed.account : undefined;
		return account === undefined
			? { conversationId: parsed.conversationId }
			: { conversationId: parsed.conversationId, account };
	} catch {
		return undefined;
	}
}

export function writeAgyPointer(sessionDir: string, pointerPath: string, sessionId: string, account?: string): void {
	mkdirSync(resolve(sessionDir), { recursive: true });
	const payload = account === undefined ? { conversationId: sessionId } : { conversationId: sessionId, account };
	writeFileSync(pointerPath, `${JSON.stringify(payload)}\n`);
}

export function clearAgyPointer(pointerPath: string): void {
	rmSync(pointerPath, { force: true });
}

/** Extracts and validates an agy conversation id from a file path or raw id string. */
export function parseAgySessionStem(sessionFile: string): string {
	const stem =
		sessionFile
			.replace(/\.(jsonl?|pb)$/, "")
			.split(/[/\\]/)
			.at(-1) ?? "";
	if (!/^[\w-]{8,}$/.test(stem)) {
		throw new OmpDriverError("rpc_error", `not an agy conversation id: ${sessionFile}`);
	}
	return stem;
}
