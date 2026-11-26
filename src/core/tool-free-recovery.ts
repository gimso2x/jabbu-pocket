// 세션 저널(.jsonl)을 역추적해 도구 호출이 전혀 없었던 실패 턴만 증명하고 재전송 없이 안전 종료한다.
import { readFileSync, statSync } from "node:fs";
import { isTaskOrigin } from "../lanes/status";
import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { entryText, type OmpEntry } from "../omp/driver";
import { isRecord } from "../omp/type-guards";
import { redact } from "../redact";
import type { Store } from "../store/db";
import type { InboundRow } from "../store/db-rows";
import { classifyFailure, type FailureKind, formatResetHint } from "./failure-kind";
import { isTurnPromptFor, promptTextOf } from "./types";

export const TOOL_FREE_OP_PREFIX = "failed:toolfree:";

export interface ToolFreeFailureProof {
	reason: string;
	failureKind: FailureKind;
	assistantEntryId: string;
}

export type ToolFreeStore = Pick<
	Store,
	"getInbound" | "markDispatched" | "recordTurnFailure" | "discard" | "recordAnswer"
>;

export type ToolFreeStage = "send_timeout" | "boot_sending" | "boot_uncertain" | "post_turn";

const SAFE_NON_MESSAGE_TYPES = new Set(["session", "model_change", "thinking_level_change", "session_info", "label"]);
const TOOL_CONTENT_BLOCK_TYPES = new Set(["toolCall", "tool_use", "server_tool_use", "toolResult", "tool_result"]);

function parseEntryLine(line: string): OmpEntry | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) return undefined;
		if (typeof parsed.id !== "string" || typeof parsed.type !== "string") return undefined;
		return parsed as OmpEntry;
	} catch {
		return undefined;
	}
}

/**
 * 세션 `.jsonl` 파일에서 `since` 이후 엔트리만 읽는다.
 * 파일이 없거나 `since` 커서를 못 찾거나 tail에 손상·잘린 줄이 하나라도 있으면 `undefined`(fail-closed)를 반환한다.
 */
export function readSessionEntriesSince(sessionFile: string, since?: string | null): OmpEntry[] | undefined {
	if (statSync(sessionFile, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
	const lines = readFileSync(sessionFile, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "");
	const parsed = lines.map(parseEntryLine);
	let sliceStart = 0;
	if (typeof since === "string" && since !== "") {
		const sinceIndex = parsed.findIndex((entry) => entry?.id === since);
		if (sinceIndex === -1) return undefined;
		sliceStart = sinceIndex + 1;
	}
	const tail = parsed.slice(sliceStart);
	if (tail.some((entry) => entry === undefined)) return undefined;
	return tail as OmpEntry[];
}

function isAssistantErrorMessage(message: Record<string, unknown>): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted") return true;
	return typeof message.errorMessage === "string" && message.errorMessage.trim() !== "";
}

function hasToolBlock(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) => isRecord(block) && typeof block.type === "string" && TOOL_CONTENT_BLOCK_TYPES.has(block.type),
	);
}

/**
 * `entries` 안에서 `promptText`에 대응하는 턴이 도구 실행 없이 오류/중단으로 끝났는지 검증한다.
 * 빈 tail, 도구 호출 흔적, 정상 `stop` 응답, 알 수 없는 엔트리 타입이 하나라도 있으면 `undefined`를 반환한다.
 */
export function proveToolFreeFailure(
	entries: readonly OmpEntry[],
	promptText: string,
): ToolFreeFailureProof | undefined {
	const promptAt = entries.findIndex(
		(entry) =>
			entry.type === "message" && entry.message?.role === "user" && isTurnPromptFor(entryText(entry), promptText),
	);
	if (promptAt === -1) return undefined;
	const after = entries.slice(promptAt + 1);
	if (after.length === 0) return undefined;
	const nextUserAt = after.findIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const turn = nextUserAt === -1 ? after : after.slice(0, nextUserAt);
	if (turn.length === 0) return undefined;

	let lastAssistant: { id: string; message: Record<string, unknown> } | undefined;
	for (const entry of turn) {
		if (entry.type !== "message") {
			if (!SAFE_NON_MESSAGE_TYPES.has(entry.type)) return undefined;
			continue;
		}
		if (!isRecord(entry.message)) return undefined;
		const msg = entry.message;
		if (msg.role === "developer") continue;
		if (msg.role !== "assistant") return undefined;
		if (msg.stopReason === "toolUse" || msg.stopReason === "stop") return undefined;
		if (hasToolBlock(msg.content)) return undefined;
		if (!isAssistantErrorMessage(msg)) return undefined;
		lastAssistant = { id: entry.id, message: msg };
	}

	if (lastAssistant === undefined) return undefined;
	const rawError =
		typeof lastAssistant.message.errorMessage === "string" && lastAssistant.message.errorMessage.trim() !== ""
			? lastAssistant.message.errorMessage.trim()
			: String(lastAssistant.message.stopReason);
	return {
		reason: rawError,
		failureKind: classifyFailure(rawError).kind,
		assistantEntryId: lastAssistant.id,
	};
}

function collapseMasked(text: string, maxChars: number): string {
	const clean = redact(text).replace(/\s+/g, " ").trim();
	return [...clean].slice(0, maxChars).join("");
}

/** 도구 미호출 실패로 자동 정리된 행에 남기는 스레드 안내 문구를 만든다. */
export function toolFreeClosureNotice(row: InboundRow, proof: ToolFreeFailureProof): string {
	const preview = collapseMasked(row.textRef, 80);
	const shortReason = collapseMasked(proof.reason, 160);
	let tail = " 다시 실행하려면 새로 보내 주세요.";
	if (proof.failureKind === "provider_limit") {
		const resetAt = classifyFailure(proof.reason).resetAt;
		const reset = resetAt === undefined ? "" : `${formatResetHint(resetAt)} `;
		tail = ` 공급자 한도입니다. ${reset}여유가 회복된 뒤 다시 보내거나 \`/model-jabbu\`로 모델을 바꾸세요.`;
	}
	return `⚠️ 도구 실행 전 실패로 안전 종료(${shortReason}) — "${preview}"은(는) 도구 호출 없이 실패한 것을 세션 저널로 확인해 재전송 없이 닫았습니다.${tail}`;
}

/**
 * 증명된 도구 미호출 실패 행을 `failed_notified`(`sending`) 또는 `discarded`(`uncertain`)로 안전 종료한다.
 */
export function closeToolFreeRow(
	store: ToolFreeStore,
	log: Logger,
	row: InboundRow,
	proof: ToolFreeFailureProof,
	stage: ToolFreeStage,
): boolean {
	const current = store.getInbound(row.platformMessageId);
	const opRef = `${TOOL_FREE_OP_PREFIX}${row.platformMessageId}`;
	const notice = toolFreeClosureNotice(row, proof);
	if (current?.state === "sending") {
		store.markDispatched(row.platformMessageId, { opRef, entryCursor: row.entryCursor });
		store.recordTurnFailure({ originKey: row.originKey, opRef, threadRef: row.threadRef, notice });
	} else if (current?.state === "uncertain") {
		store.discard(row.platformMessageId, opRef);
		if (!row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) && !isTaskOrigin(row.originKey)) {
			store.recordAnswer({ originKey: row.originKey, opRef, threadRef: row.threadRef, parts: [notice] });
		}
	} else {
		return false;
	}
	log.info("tool_free_failure_closed", {
		stage,
		origin: row.originKey,
		id: row.platformMessageId,
		kind: proof.failureKind,
		entry: proof.assistantEntryId,
	});
	return true;
}

/**
 * 세션 저널 파일에서 `row`의 도구 미호출 실패를 증명할 수 있으면 안전 종료하고 그 증명 결과를 반환한다.
 */
export function tryCloseToolFreeFromFile(
	store: ToolFreeStore,
	log: Logger,
	row: InboundRow,
	sessionFile: string | undefined,
	stage: ToolFreeStage,
): ToolFreeFailureProof | undefined {
	if (sessionFile === undefined) return undefined;
	try {
		const entries = readSessionEntriesSince(sessionFile, row.entryCursor);
		if (entries === undefined) return undefined;
		const proof = proveToolFreeFailure(entries, promptTextOf(row.textRef));
		if (proof === undefined) return undefined;
		return closeToolFreeRow(store, log, row, proof, stage) ? proof : undefined;
	} catch (error) {
		log.warn("tool_free_probe_failed", {
			stage,
			origin: row.originKey,
			id: row.platformMessageId,
			error: String(error),
		});
		return undefined;
	}
}
