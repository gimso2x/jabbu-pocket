import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import type { Logger } from "../log";
import type { HostToolDef } from "../safety/host-tools";
import { OWNER_NOTES_MAX_BYTES } from "../safety/prompt-files";
import { formatLocal } from "../time";
import {
	type CursorStore,
	isFirstRun,
	ONBOARDING_CURSOR,
	type OnboardingConsent,
	OnboardingError,
	type OnboardingState,
	readState,
	writeState,
} from "./state";

/** The part of the ledger the tool reads: the owner's messages of its conversation. */
export interface OnboardingLedger extends CursorStore {
	listInbound(filter: { originKey: string }): ReadonlyArray<{
		textRef: string;
		createdAt: number;
		peerUserId: string | null;
	}>;
}

export interface OnboardingToolDeps {
	originKey: string;
	store: OnboardingLedger;
	/** `<home>/workspace/owner.md`, the path the daemon injects the owner notes from. */
	notesPath: string;
	timezone: string;
	now: () => number;
	log: Logger;
}

export const FINISH_TEXT_MAX_CHARS = 2000;
/** How many of the owner's latest messages can carry the words that reopen a finished or already-noted bot. */
const REOPEN_WINDOW = 20;
const TOOL_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function requireString(params: Record<string, unknown>, key: string): string {
	const value = stringParam(params, key);
	if (value === undefined || value.trim() === "") throw new OnboardingError(`${key} is required`);
	return value;
}

/** The state to change, or a refusal: an unreadable state is never overwritten. */
function writable(deps: OnboardingToolDeps): OnboardingState {
	const read = readState(deps.store, () => deps.log.warn("onboarding_state_unreadable", { origin: deps.originKey }));
	if (!read.ok) {
		throw new OnboardingError(
			`온보딩 상태를 읽을 수 없어 바꾸지 않는다(${ONBOARDING_CURSOR} cursor가 깨짐): jabbu-pocket onboarding --reset으로만 복구한다`,
		);
	}
	return read.state;
}

/**
 * Whether `message` is inside an owner message of this conversation (a peer bot's row never counts, and an ask card's
 * auto-picked answer was never an inbound row). `after` keeps only messages newer than it; `last` only the latest ones.
 */
function ownerSaid(deps: OnboardingToolDeps, message: string, after: number | undefined, last?: number): boolean {
	const words = message.trim();
	if (words === "") return false;
	const rows = deps.store
		.listInbound({ originKey: deps.originKey })
		.filter((row) => row.peerUserId === null && (after === undefined || row.createdAt > after));
	return (last === undefined ? rows : rows.slice(-last)).some((row) => row.textRef.includes(words));
}

function requireOwnerWords(deps: OnboardingToolDeps, state: OnboardingState, params: Record<string, unknown>): string {
	const message = requireString(params, "message");
	if (!ownerSaid(deps, message, state.startedAt)) {
		throw new OnboardingError("message는 온보딩을 연 뒤 이 대화에서 오너가 실제로 보낸 글 원문이어야 한다");
	}
	return message;
}

function requireRunning(state: OnboardingState, op: string): void {
	if (state.phase !== "running") throw new OnboardingError(`${op}: 온보딩이 진행 중이 아니다(phase ${state.phase})`);
}

function requireConsent(state: OnboardingState, op: string): void {
	if (state.consent?.answer !== "yes") throw new OnboardingError(`${op}: 오너의 동의(consent yes)가 먼저 필요하다`);
}

function start(deps: OnboardingToolDeps, params: Record<string, unknown>): string {
	const state = writable(deps);
	if (state.phase === "running") return "이미 진행 중이다";
	const reopen = params.reopen === true;
	if (!reopen && !(state.phase === "new" && isFirstRun(state, deps.notesPath))) {
		throw new OnboardingError(
			"start: 첫 실행이 아니다. 오너가 먼저 온보딩을 꺼냈을 때만 reopen: true와 그 오너 글 원문 message로 연다",
		);
	}
	let reopenedBy: string | undefined;
	if (reopen) {
		reopenedBy = requireString(params, "message");
		if (!ownerSaid(deps, reopenedBy, undefined, REOPEN_WINDOW)) {
			throw new OnboardingError("message는 이 대화에서 오너가 실제로 보낸 최근 글 원문이어야 한다");
		}
	}
	const { consent: _consent, summary: _summary, forced: _forced, ...kept } = state;
	writeState(deps.store, {
		...kept,
		phase: "running",
		tools: {},
		startedAt: deps.now(),
		...(reopenedBy === undefined ? {} : { reopenedBy }),
	});
	return "온보딩을 시작했다. 왜 읽는지 밝힌 동의 질문 하나를 일반 답장으로 묻고, 오너 글 답을 받으면 consent로 기록한다";
}

function consent(deps: OnboardingToolDeps, params: Record<string, unknown>): string {
	const state = writable(deps);
	requireRunning(state, "consent");
	const reply = params.reply;
	if (reply !== "yes" && reply !== "no") throw new OnboardingError('reply must be "yes" or "no"');
	const message = requireOwnerWords(deps, state, params);
	const { forced: _forced, ...kept } = state;
	const recorded: OnboardingConsent = { answer: reply, message, at: deps.now() };
	writeState(
		deps.store,
		reply === "no" ? { ...kept, phase: "done", consent: recorded } : { ...kept, consent: recorded },
	);
	return reply === "no"
		? "거절을 기록했고 온보딩을 끝냈다. 오너가 먼저 꺼내기 전에는 다시 묻지 않는다"
		: "동의를 기록했다. 도구마다 일반 답장으로 먼저 묻고 tool로 기록한다";
}

function tool(deps: OnboardingToolDeps, params: Record<string, unknown>): string {
	const state = writable(deps);
	requireRunning(state, "tool");
	requireConsent(state, "tool");
	const name = stringParam(params, "name");
	if (name === undefined || !TOOL_NAME.test(name)) throw new OnboardingError("name must match [A-Za-z0-9._-]{1,64}");
	const reply = params.reply;
	if (reply !== "allowed" && reply !== "declined") throw new OnboardingError('reply must be "allowed" or "declined"');
	const reads = stringParam(params, "reads") ?? "";
	const message = requireOwnerWords(deps, state, params);
	writeState(deps.store, { ...state, tools: { ...state.tools, [name]: { answer: reply, reads, message } } });
	return `${name}: ${reply}`;
}

/** Appends `section` to the owner notes without following a symlink; refuses what is not a regular file or would outgrow the cap. */
function appendNotes(path: string, section: string): void {
	let size = 0;
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry !== undefined) {
		if (entry.isSymbolicLink() || !entry.isFile()) {
			throw new OnboardingError("finish: 관찰지가 일반 파일이 아니다(심링크 등)라 쓰지 않는다");
		}
		size = entry.size;
	}
	const bytes = Buffer.from(size === 0 ? section.replace(/^\n/, "") : section, "utf8");
	if (size + bytes.length > OWNER_NOTES_MAX_BYTES) {
		throw new OnboardingError(`finish: 덧붙이면 관찰지가 ${OWNER_NOTES_MAX_BYTES}바이트를 넘는다. text를 줄인다`);
	}
	const flags =
		entry === undefined
			? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
			: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
	let fd: number;
	try {
		fd = openSync(path, flags, 0o600);
	} catch (error) {
		// The workspace folder is made by `init` and nothing recreates it: a missing folder must be an onboarding
		// refusal with a usable message, not a raw ENOENT for the model to guess at.
		throw new OnboardingError(
			`finish: 관찰지를 열 수 없다(${(error as NodeJS.ErrnoException).code ?? "error"}): workspace 폴더를 확인한다`,
		);
	}
	try {
		if (!fstatSync(fd).isFile()) throw new OnboardingError("finish: 관찰지가 일반 파일이 아니다");
		writeSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

function finish(deps: OnboardingToolDeps, params: Record<string, unknown>): string {
	const state = writable(deps);
	requireRunning(state, "finish");
	requireConsent(state, "finish");
	const text = requireString(params, "text").trim();
	if (text.length > FINISH_TEXT_MAX_CHARS) {
		throw new OnboardingError(`finish: text는 ${FINISH_TEXT_MAX_CHARS}자 이하여야 한다(${text.length}자)`);
	}
	const day = formatLocal(deps.now(), deps.timezone).slice(0, 10);
	appendNotes(deps.notesPath, `\n## 온보딩 요약 (${day})\n${text}\n`);
	const { forced: _forced, ...kept } = state;
	writeState(deps.store, { ...kept, phase: "done", summary: text });
	return "온보딩을 끝냈고 요약을 관찰지에 덧붙였다";
}

function view(deps: OnboardingToolDeps): string {
	const read = readState(deps.store, () => deps.log.warn("onboarding_state_unreadable", { origin: deps.originKey }));
	if (!read.ok) return JSON.stringify({ phase: "running", unreadable: true });
	const { summary: _summary, ...rest } = read.state;
	return JSON.stringify(rest);
}

/** `jabbu_onboarding`: the first-run onboarding state machine (`docs/guide.md` "첫 실행 온보딩"). */
export function buildOnboardingTool(deps: OnboardingToolDeps): HostToolDef {
	return {
		name: "jabbu_onboarding",
		label: "First-run onboarding",
		description:
			"First-run onboarding record. op=view: the state. op=start {reopen?, message?}: begin (an existing bot needs reopen:true and the owner's own words in message). op=consent {reply: yes|no, message}: the owner's answer to the consent question. op=tool {name, reply: allowed|declined, reads, message}: the owner's answer for one tool. op=finish {text}: append the summary (<=2000 chars) to the owner notes and end. message must be a verbatim quote of the owner's written message in this conversation; ask-card answers do not count. While onboarding runs, dispatch, work start, board post, monitor add/remove and file upload are refused.",
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", enum: ["view", "start", "consent", "tool", "finish"] },
				reopen: { type: "boolean" },
				reply: { type: "string", enum: ["yes", "no", "allowed", "declined"] },
				name: { type: "string", description: "Tool name, [A-Za-z0-9._-]{1,64}" },
				reads: { type: "string", description: "What will be read through that tool" },
				message: { type: "string", description: "The owner's message, verbatim" },
				text: { type: "string", description: "Summary for the owner notes, at most 2000 characters" },
			},
			required: ["op"],
			additionalProperties: false,
		},
		async execute(params) {
			switch (params.op) {
				case "view":
					return view(deps);
				case "start":
					return start(deps, params);
				case "consent":
					return consent(deps, params);
				case "tool":
					return tool(deps, params);
				case "finish":
					return finish(deps, params);
				default:
					throw new OnboardingError("op must be view, start, consent, tool or finish");
			}
		},
	};
}
