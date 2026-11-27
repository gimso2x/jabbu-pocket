import { parseChatOrigin } from "../core/origin-key";
import type { HerdrAgentStatus } from "../dispatch/omp";
import type { TaskStage } from "../flow/task-flow";
import { redact } from "../redact";
import type { TypicalDuration } from "../store/turn-duration";
import type { TaskRisk } from "../tasks/docs";
import type { TaskRow, TaskStatus } from "../tasks/ledger";
import type { TaskTurnFields } from "./turn";

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function extractRepoName(repo: string | null | undefined, cwd: string): string | undefined {
	const clean = redact((repo?.trim() ? repo : cwd).split(/[\\/]/).filter(Boolean).pop() ?? "");
	return clean === "" ? undefined : clean;
}

/** `DM` for any platform's owner DM; a channel by its id, named after its platform when that is Discord. */
export function originLabel(originKey: string | null, channelNames?: Record<string, string>): string | null {
	if (originKey === null) return null;
	const ref = parseChatOrigin(originKey);
	if (ref?.kind === "dm") return ref.platform === "web" ? "웹 대화" : "DM";
	const channel = /^(slack|discord)\/ch\/([^/]+)(\/t\/[^/]+)?$/.exec(originKey);
	if (channel === null) return originKey;
	const named = channel[2] ? channelNames?.[channel[2]] : undefined;
	const head = named ?? `${channel[1] === "discord" ? "Discord " : ""}채널 ${channel[2]}`;
	return `${head} ${channel[3] === undefined ? "메인" : "스레드"}`;
}

export type HerdrState = { ok: true; status: HerdrAgentStatus } | { ok: false; error: string };

/** Threads in the flow view: a TASK registered in this window, or any open TASK. */
export const FLOW_WINDOW_MS = 7 * 86_400_000;

export interface TaskInfo extends TaskTurnFields {
	taskId: string;
	install?: string;
	rawTaskId?: string;
	title: string;
	risk: TaskRisk;
	status: TaskStatus;
	host: string;
	agent: string;
	runtime: TaskRow["runtime"];
	branch: string;
	open: boolean;
	updatedAt: string;
	closedAt?: string;
	acChecked?: number;
	acTotal: number;
	stepsDone?: number;
	stepsTotal?: number;
	progress?: { status: string; updated: string; current: string; blockedReason: string };
	acceptance?: Array<{ id: string; text: string; checked: boolean }>;
	steps?: Array<{ id: string; text: string; done: boolean }>;
	herdr?: HerdrState;
	link?: string;
	overlap?: string;
	error?: string;
	typical?: TypicalDuration;
	elapsedMs?: number;
}

/** One TASK box of a flow, built from the flow's own row (not cut to the snapshot's closed-TASK limit). */
export interface FlowStepInfo {
	taskId: string;
	title: string;
	status: TaskStatus;
	risk: TaskRisk;
	host: string;
	branch: string;
	createdAt: string;
	closedAt?: string;
	acTotal: number;
	stage: TaskStage;
	typical?: TypicalDuration;
	elapsedMs?: number;
}

/** One request thread: its request line and its TASKs in registration order. */
export interface FlowChainInfo {
	threadRef: string;
	originKey: string;
	place: string | null;
	title: string;
	requestedAt: string | null;
	updatedAt: string;
	done: number;
	total: number;
	here: string | null;
	now: string;
	tasks: FlowStepInfo[];
	discordHref: string;
}

export interface LaneInfo {
	name: string;
	originKey: string;
	title: string;
	status: string;
	cwd: string;
	updatedAt: string;
	uncertainCount: number;
	typical?: TypicalDuration;
	elapsedMs?: number;
	evidence?: { file: string; sha256: string };
	install?: string;
	landState?: string;
	prUrl?: string;
	repo?: string;
}

/**
 * The `https://discord.com/channels/…` link that opens a Discord conversation: a DM at its message
 * (`discord/dm/…`, `<dm>:<message>`), a server thread or a lane (`<parent>:<thread>`) at the thread, a server channel
 * at its message. "" for a ref that is not two snowflakes, or a server conversation without the one server id.
 */
export function discordThreadHref(
	guild: string | null | undefined,
	originKey: string | null | undefined,
	threadRef: string | null | undefined,
): string {
	const ref = /^(\d{17,20}):(\d{17,20})$/.exec(threadRef ?? "");
	if (ref === null) return "";
	const key = (originKey ?? "").replace(/^[^/:]+:/, "");
	if (key.startsWith("discord/dm/")) return `https://discord.com/channels/@me/${ref[1]}/${ref[2]}`;
	if (!guild) return "";
	if (/^discord\/ch\/\d+\/t\/\d+$/.test(key) || key.startsWith("jabbu/work/")) {
		return `https://discord.com/channels/${guild}/${ref[2]}`;
	}
	if (key.startsWith("discord/ch/")) return `https://discord.com/channels/${guild}/${ref[1]}/${ref[2]}`;
	return "";
}
