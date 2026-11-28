// Pure helpers of `rpc-driver.ts` (kept apart so that file stays under its LOC baseline).
import type { OmpState } from "./driver";
import { OmpDriverError } from "./driver";
import { type PromptResultFrame, RpcCommandError } from "./rpc-client";
import { isRecord } from "./type-guards";

export function listen<T>(s: Set<T>, f: T): () => void {
	s.add(f);
	return () => s.delete(f);
}

/** A finite number of at least `min`, else undefined. */
export function countOf(value: unknown, min: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

/**
 * `OmpState.context` from omp's `contextUsage`: nothing without a positive window (an unknown model), `tokens`/`percent`
 * null when omp sends no number (right after a compaction it does not know them yet).
 */
export function contextOf(usage: unknown): Pick<OmpState, "context"> {
	if (!isRecord(usage)) return {};
	const window = countOf(usage.contextWindow, 1);
	if (window === undefined) return {};
	const tokens = countOf(usage.tokens, 0) ?? null;
	return { context: { tokens, window, percent: tokens === null ? null : (countOf(usage.percent, 0) ?? null) } };
}

export function toDriverError(error: unknown): unknown {
	if (!(error instanceof RpcCommandError)) return error;
	const code = error.code === "unknown_since" ? "unknown_since" : "rpc_error";
	return new OmpDriverError(code, error.message, { rpcCode: error.code, cause: error });
}

/** A turn's end as `#finalize` reads it (a `prompt_result`, or the end of the wait for an unsettled session). */
export type TurnEnd = Pick<PromptResultFrame, "status" | "error">;

/**
 * The failure of a run that ended with `agent_end`, read from its last assistant message like omp's own prompt
 * outcome (`stopReason` `error` or `aborted`); undefined when it completed.
 */
export function runFailure(messages: unknown): TurnEnd | undefined {
	if (!Array.isArray(messages)) return undefined;
	const last = messages.findLast((message) => isRecord(message) && message.role === "assistant");
	if (!isRecord(last)) return undefined;
	if (last.stopReason === "aborted") return { status: "aborted" };
	if (last.stopReason !== "error") return undefined;
	const message = typeof last.errorMessage === "string" ? last.errorMessage : "omp run failed";
	return { status: "error", error: { message } };
}
