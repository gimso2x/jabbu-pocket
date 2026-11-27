import { readFileSync } from "node:fs";
import { isRecord } from "../omp/type-guards";

/** Ledger cursor that holds the first-run onboarding state as JSON (no schema change: like the ops panel's state). */
export const ONBOARDING_CURSOR = "onboarding";

/** Thrown to the model (and the CLI) when an onboarding operation is refused; the state is unchanged. */
export class OnboardingError extends Error {}

/** Said by the daemon's call-time guard when a posting or work-starting tool runs during onboarding. */
export const ONBOARDING_TOOL_DENIED = "첫 실행 온보딩 중에는 읽기 전용이라 쓸 수 없는 도구다";

export type OnboardingPhase = "new" | "running" | "done";

export interface OnboardingConsent {
	answer: "yes" | "no";
	/** The owner's own words that carried the answer (checked against the inbound ledger). */
	message: string;
	at: number;
}

export interface OnboardingToolEntry {
	answer: "allowed" | "declined";
	reads: string;
	message: string;
}

export interface OnboardingState {
	phase: OnboardingPhase;
	/** Set by the CLI's `--reset`: the next conversation is a first run even with an owner notes file. */
	forced?: true;
	consent?: OnboardingConsent;
	tools: Record<string, OnboardingToolEntry>;
	reopenedBy?: string;
	summary?: string;
	/** When `start` opened the run: only owner messages after it can carry a consent or a tool answer. */
	startedAt?: number;
}

/** The part of the ledger the onboarding state lives in (`Store` has it). */
export interface CursorStore {
	getCursor(key: string): string | undefined;
	setCursor(key: string, value: string): void;
}

/** Why the stored state is unusable: the state then counts as running and no operation may change it. */
export type StateRead = { ok: true; state: OnboardingState } | { ok: false };

const FRESH: OnboardingState = { phase: "new", tools: {} };

function isConsent(value: unknown): value is OnboardingConsent {
	return (
		isRecord(value) &&
		(value.answer === "yes" || value.answer === "no") &&
		typeof value.message === "string" &&
		typeof value.at === "number"
	);
}

function isToolEntry(value: unknown): value is OnboardingToolEntry {
	return (
		isRecord(value) &&
		(value.answer === "allowed" || value.answer === "declined") &&
		typeof value.reads === "string" &&
		typeof value.message === "string"
	);
}

function parseState(raw: string): OnboardingState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || (value.phase !== "new" && value.phase !== "running" && value.phase !== "done")) {
		return undefined;
	}
	if (!isRecord(value.tools) || !Object.values(value.tools).every(isToolEntry)) return undefined;
	if (value.consent !== undefined && !isConsent(value.consent)) return undefined;
	if (value.forced !== undefined && value.forced !== true) return undefined;
	for (const key of ["reopenedBy", "summary"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return undefined;
	}
	if (value.startedAt !== undefined && typeof value.startedAt !== "number") return undefined;
	return value as unknown as OnboardingState;
}

/**
 * The stored state; none stored is a fresh `new`. A value that does not parse is `{ ok: false }` and every caller
 * treats it as running (tools refused) without overwriting it; only the CLI's `--reset` repairs it.
 */
export function readState(store: CursorStore, onUnreadable?: () => void): StateRead {
	const raw = store.getCursor(ONBOARDING_CURSOR);
	if (raw === undefined) return { ok: true, state: { ...FRESH, tools: {} } };
	const state = parseState(raw);
	if (state === undefined) {
		onUnreadable?.();
		return { ok: false };
	}
	return { ok: true, state };
}

export function writeState(store: CursorStore, state: OnboardingState): void {
	store.setCursor(ONBOARDING_CURSOR, JSON.stringify(state));
}

/** What `jabbu-pocket onboarding --reset` stores. */
export const RESET_STATE: OnboardingState = { phase: "new", forced: true, tools: {} };

/** Whether the owner notes file has nothing in it: missing or whitespace only. Any other read failure counts as content. */
export function ownerNotesBlank(path: string): boolean {
	try {
		return readFileSync(path, "utf8").trim() === "";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** A first run: nothing started yet and the owner notes are empty, or `--reset` forced one. */
export function isFirstRun(state: OnboardingState, notesPath: string): boolean {
	return state.phase === "new" && (state.forced === true || ownerNotesBlank(notesPath));
}

/** Whether the daemon refuses posting and work-starting tools: running, or a state it cannot read. */
export function onboardingRunning(read: StateRead): boolean {
	return !read.ok || read.state.phase === "running";
}

const FIRST_RUN_LINE =
	"- 첫 실행: 오너에게 먼저 인사하고 `jabbu_onboarding` start 후, 왜 읽는지 밝힌 동의 질문 하나를 일반 답장으로 묻는다(ask 버튼 금지 — 마감 자동 선택이 동의가 되면 안 됨). 오너가 글로 답하기 전엔 아무것도 읽지 않는다. First run: greet the owner, call `jabbu_onboarding` start, then ask one consent question in a plain reply saying why you want to read (no ask card: a deadline auto-pick must not count as consent); read nothing until the owner answers in writing.";
const BEFORE_CONSENT_LINE =
	"- 온보딩 중: 동의 답 전, 아무것도 읽지 않는다. Onboarding in progress: read nothing before the owner's consent answer.";
const AFTER_CONSENT_LINE =
	"- 온보딩 중(읽기 전용): 도구마다 일반 답장으로 먼저 묻고 `jabbu_onboarding` tool로 기록, 끝나면 finish. Onboarding (read-only): ask per tool in a plain reply first, record it with `jabbu_onboarding`, then finish.";
const DECLINED_LINE =
	"- 온보딩 거절됨: 오너가 먼저 꺼내기 전엔 다시 묻지 않는다. Onboarding declined: do not ask again unless the owner brings it up.";

/** The prompt line of the stored state, or undefined when the conversation is not in onboarding. */
export function onboardingPromptLine(read: StateRead, notesPath: string): string | undefined {
	if (!read.ok) return BEFORE_CONSENT_LINE;
	const { state } = read;
	if (state.phase === "running") return state.consent?.answer === "yes" ? AFTER_CONSENT_LINE : BEFORE_CONSENT_LINE;
	if (state.phase === "new") return isFirstRun(state, notesPath) ? FIRST_RUN_LINE : undefined;
	return state.consent?.answer === "no" ? DECLINED_LINE : undefined;
}
